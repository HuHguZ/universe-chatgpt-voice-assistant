import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { matrixAssets, MatrixAudioTransport } from './transport.ts';
import type { MatrixAudioOptions } from './transport.ts';
import { setRobotProfile } from './profile.ts';
import { createSonoraServer } from '../server.ts';
import { nodeVersionTool, runNodeVersion } from '../../scripts/demo-tool.ts';
import { audible } from '../../scripts/test-audio.ts';
import { endCallTool, acceptEndCall } from '../call-control.ts';

const { createLabUser, createLabRoom, matrixRequest, MATRIX_URL } = await import(pathToFileURL(resolve('infra/lab.mjs')).href);

class LiveCall {
  readonly id = randomUUID();
  phase = 'joining';
  toolsCompleted = 0;
  speechFrames = 0;
  replyFrames = 0;
  private users: any[] = [];
  private bot?: MatrixAudioTransport;
  private botStarting?: Promise<void>;
  private ws?: WebSocket;
  private botReady = Promise.withResolvers<void>();
  private humanReady = Promise.withResolvers<void>();
  private closed = false;
  private closing?: Promise<void>;
  private output = Promise.resolve();
  private endCalls = new Set<string>();
  lastSeen = Date.now();

  async prepare(): Promise<MatrixAudioOptions> {
    this.users.push(await createLabUser(undefined, 'Sonora'));
    this.users.push(await createLabUser(undefined, 'Вы'));
    await setRobotProfile(MATRIX_URL, this.users[0]);
    const roomId = await createLabRoom(this.users[0], this.users[1]);
    await matrixRequest(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/org.matrix.msc4143.rtc.slot/${encodeURIComponent('m.call#ROOM')}`, { method: 'PUT', token: this.users[0].accessToken, body: { status: 'open', application: { type: 'm.call' }, encryption: { type: 'org.matrix.msc4143.per_member' } } });
    if (this.closed) throw new Error('Call closed');
    this.botStarting = (async () => {
      const bot = await MatrixAudioTransport.create({ homeserver: MATRIX_URL, ...this.users[0], roomId }, async () => {
        this.botReady.resolve(); await this.humanReady.promise;
        if (this.closed) throw new Error('Call closed');
      });
      this.bot = bot;
      if (this.closed) { await bot.close(); return; }
      bot.on('audio', audio => { if (audible(audio)) this.speechFrames++; if (this.phase === 'ready' && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'input.audio', ...audio })); });
      bot.on('transportError', () => this.fail());
    })();
    void this.botStarting.catch(() => this.fail());
    return { homeserver: MATRIX_URL, ...this.users[1], roomId };
  }

  async cryptoReady(): Promise<void> { this.humanReady.resolve(); await this.botReady.promise; if (this.closed) throw new Error('Call closed'); }

  async connect(apiPort: number): Promise<void> {
    await this.botStarting;
    for (let n = 0;; n++) {
      if (this.closed || !this.bot) throw new Error('Call closed');
      const status = await this.bot.status();
      if (status.keyParticipants >= 2 && status.remoteEncrypted) break;
      if (n >= 100) throw new Error('Encrypted call timed out');
      await delay(100);
    }
    this.phase = 'voice';
    const ws = this.ws = new WebSocket(`ws://127.0.0.1:${apiPort}/session`);
    await once(ws, 'open');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Voice startup timed out')), 40000);
      ws.on('error', () => { clearTimeout(timer); reject(new Error('Voice connection failed')); this.fail(); });
      ws.on('close', () => { clearTimeout(timer); reject(new Error('Voice closed')); if (!this.closed) this.fail(); });
      ws.on('message', async raw => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'session.started') { clearTimeout(timer); this.phase = 'ready'; resolve(); }
        if (event.type === 'error') { clearTimeout(timer); reject(new Error('Voice session failed')); this.fail(); }
        if (event.type === 'tool.completed' && event.success) this.toolsCompleted++;
        if (event.type === 'tool.completed' && event.name === endCallTool.name && event.success && this.endCalls.has(event.callId)) void this.close().catch(() => this.fail());
        if (event.type === 'output.audio') { if (audible(event)) this.replyFrames++; this.output = this.output.then(() => this.closed ? undefined : this.bot?.input(event)).catch(() => this.fail()); }
        if (event.type === 'output.reset') void this.bot?.interrupt().catch(() => this.fail());
        if (event.type === 'tool.call') {
          let result;
          try { result = event.name === endCallTool.name ? acceptEndCall(event.arguments) : await runNodeVersion(event.name, event.arguments); }
          catch { result = { success: false, contentItems: [{ type: 'inputText', text: 'Command failed' }] }; }
          if (event.name === endCallTool.name && result.success) this.endCalls.add(event.callId);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'tool.result', callId: event.callId, result }));
        }
      });
      ws.send(JSON.stringify({ type: 'session.start', voice: true, tools: [nodeVersionTool, endCallTool] }));
    });
  }

  private fail(): void { this.phase = 'error'; void this.close().catch(() => {}); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.botReady.resolve(); this.humanReady.resolve(); this.ws?.terminate();
    if (this.phase !== 'error') this.phase = 'closed';
    this.closing = (async () => {
      await this.botStarting?.catch(() => {});
      await this.output.catch(() => {});
      await this.bot?.close();
      await Promise.allSettled(this.users.map(user => matrixRequest('/_matrix/client/v3/logout', { method: 'POST', token: user.accessToken, body: {} })));
    })();
    return this.closing;
  }
}

export async function createLiveCallServer() {
  const assets = await matrixAssets();
  assets.set('/', ['text/html; charset=utf-8', await readFile('src/matrix/call.html', 'utf8')]);
  const api = createSonoraServer();
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening');
  let call: LiveCall | undefined;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('X-Frame-Options', 'DENY');
    const port = (server.address() as AddressInfo).port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origin = request.headers.origin;
    if (!hosts.includes(request.headers.host ?? '') || (request.method === 'POST' && !hosts.some(host => origin === `http://${host}`))) { response.writeHead(403).end(); return; }
    try {
      const asset = assets.get(request.url ?? '');
      if (request.method === 'GET' && asset) { response.writeHead(200, { 'Content-Type': asset[0] }).end(asset[1]); return; }
      if (request.method === 'POST' && request.url === '/join') {
        if (call) { response.writeHead(409).end(); return; }
        call = new LiveCall();
        response.setHeader('Set-Cookie', `sonora_call=${call.id}; HttpOnly; SameSite=Strict; Path=/`);
        const options = await call.prepare();
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(options)); return;
      }
      if (!call || !request.headers.cookie?.split('; ').includes(`sonora_call=${call.id}`)) { response.writeHead(401).end(); return; }
      call.lastSeen = Date.now();
      if (request.method === 'GET' && request.url === '/status') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ phase: call.phase, toolsCompleted: call.toolsCompleted, speechFrames: call.speechFrames, replyFrames: call.replyFrames })); return; }
      if (request.method === 'POST' && request.url === '/ready') { await call.cryptoReady(); response.writeHead(204).end(); return; }
      if (request.method === 'POST' && request.url === '/connected') { await call.connect((api.server.address() as AddressInfo).port); response.writeHead(204).end(); return; }
      if (request.method === 'POST' && request.url === '/leave') { await call.close(); call = undefined; response.writeHead(204).end(); return; }
      response.writeHead(404).end();
    } catch { await call?.close().catch(() => {}); response.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"Не удалось подключить звонок. Выйдите и попробуйте ещё раз."}'); }
  });
  const idle = setInterval(() => { if (call && Date.now() - call.lastSeen > 60000) { const old = call; void old.close().finally(() => { if (call === old) call = undefined; }); } }, 5000);
  idle.unref();
  return { server, async close() { clearInterval(idle); await call?.close(); await api.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
