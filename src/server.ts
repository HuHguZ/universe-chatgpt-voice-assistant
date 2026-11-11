import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { parseInput } from './protocol.ts';
import type { Input } from './protocol.ts';
import { SonoraSession } from './session.ts';

type SessionHandle = { handle(input: Input): Promise<void>; close(): Promise<void> };

export function createSonoraServer(options: { sessionFactory?: (send: (event: Record<string, unknown>) => void) => SessionHandle } = {}) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === '/health') response.end(JSON.stringify({ service: 'universe-chatgpt-voice-assistant', status: 'ok' }));
    else { response.statusCode = 404; response.end('{"error":"Not found"}'); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const sessions = new Map<WebSocket, SessionHandle>();
  let owner: WebSocket | undefined;
  server.on('upgrade', (request, socket, head) => {
    const port = (server.address() as AddressInfo).port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origin = request.headers.origin;
    if (request.url !== '/session' || !hosts.includes(request.headers.host ?? '') || (origin && !hosts.some(host => origin === `http://${host}`))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (owner) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(request, socket, head, ws => {
      owner = ws;
      const send = (event: Record<string, unknown>) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, 'Client is too slow'); return; }
        ws.send(JSON.stringify(event));
        if (event.type === 'session.closed') ws.close(1000, 'Session closed');
      };
      const implementation = options.sessionFactory?.(send) ?? new SonoraSession(send);
      let closing: Promise<void> | undefined;
      const session: SessionHandle = { handle: input => implementation.handle(input), close: () => closing ??= Promise.resolve().then(() => implementation.close()) };
      sessions.set(ws, session);
      let queue = Promise.resolve();
      let waiting = 0;
      let generation = 0;
      ws.on('message', (data, binary) => {
        try {
          if (binary) throw new Error('Use JSON audio frames');
          const input = parseInput(data.toString());
          if (input.type === 'tool.result' || input.type === 'session.close' || input.type === 'session.interrupt') {
            if (input.type !== 'tool.result') generation++;
            void session.handle(input).catch(error => send({ type: 'error', message: error.message })); return;
          }
          if (++waiting > 64) { ws.close(1013, 'Input queue is full'); return; }
          const current = generation;
          queue = queue.then(() => current === generation ? session.handle(input) : undefined).catch(error => send({ type: 'error', message: error.message })).finally(() => { waiting--; });
        } catch (error) { send({ type: 'error', message: error instanceof Error ? error.message : 'Invalid message' }); }
      });
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        generation++;
        void session.close().catch(() => {}).finally(() => {
          if (owner === ws) owner = undefined;
          sessions.delete(ws);
        });
      });
    });
  });
  return {
    server,
    async close() {
      await Promise.all([...sessions].map(async ([ws, session]) => { ws.terminate(); await session.close(); }));
      sockets.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
