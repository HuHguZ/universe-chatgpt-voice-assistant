import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { NativeMatrixCall } from '../src/matrix/native.ts';
import type { MatrixAudioStatus } from '../src/matrix/transport.ts';
import type { AudioChunk } from '../src/voice-transport.ts';
import { endCallTool } from '../src/call-control.ts';
import { createSonoraServer } from '../src/server.ts';

class FakeMatrix extends EventEmitter {
  joins = 0; leaves = 0; outputs = 0; resets = 0;
  async join() { this.joins++; }
  async leave() { this.leaves++; }
  async input(_audio?: AudioChunk) { this.outputs++; }
  async interrupt() { this.resets++; }
  async status(): Promise<MatrixAudioStatus> { return { connected: true, encrypted: true, remoteEncrypted: true, keyParticipants: 2, memberships: 2, failed: false } as MatrixAudioStatus; }
}

test('native Matrix remains idle until a caller joins, bridges universal audio, hangs up and accepts another call', async () => {
  const server = createServer(); const sockets = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const matrix = new FakeMatrix();
  const call = new NativeMatrixCall(matrix, `ws://127.0.0.1:${(server.address() as AddressInfo).port}/session`);
  const messages: any[] = []; let closed = 0;
  sockets.on('connection', ws => {
    ws.on('close', () => closed++);
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString()); messages.push(message);
      if (message.type === 'session.start') { assert.equal(matrix.joins, call.sessionsStarted); ws.send('{"type":"output.audio"}'); ws.send('{"type":"session.started"}'); }
    });
  });
  const until = async (condition: () => boolean) => { for (let n = 0; n < 100 && !condition(); n++) await delay(10); assert.ok(condition()); };
  try {
    assert.equal(matrix.joins, 0);
    matrix.emit('memberships', 1); await call.settled(); await until(() => call.phase === 'ready');
    assert.equal(matrix.outputs, 0, 'early backend audio must not enter an unconnected Matrix transport');
    for (const ws of sockets.clients) ws.send('{"type":"output.audio"}');
    await until(() => matrix.outputs === 1);
    for (const ws of sockets.clients) ws.send('{"type":"output.reset"}');
    await until(() => matrix.resets === 1);
    matrix.emit('audio', { data: 'AAA=', sampleRate: 48000, numChannels: 1 });
    await until(() => messages.some(message => message.type === 'input.audio'));
    assert.deepEqual(messages[0], { type: 'session.start', voice: true, tools: [endCallTool] }); assert.equal(matrix.resets, 1);
    matrix.emit('memberships', 1); await call.settled(); assert.equal(matrix.joins, 1);
    matrix.emit('memberships', 0); await call.settled(); await until(() => closed === 1); assert.equal(call.phase, 'idle');
    matrix.emit('memberships', 1); await call.settled(); await until(() => call.sessionsStarted === 2); assert.equal(matrix.joins, 2);
  } finally { await call.close(); sockets.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('native hangup followed by rapid rejoin cannot skip the queued leave', async () => {
  const server = createServer(), sockets = new WebSocketServer({ server }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const matrix = new FakeMatrix(), joining = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  matrix.join = async () => { if (++matrix.joins === 1) { entered.resolve(); await joining.promise; } };
  const call = new NativeMatrixCall(matrix, `ws://127.0.0.1:${(server.address() as AddressInfo).port}/session`);
  sockets.on('connection', ws => ws.on('message', () => ws.send('{"type":"session.started"}')));
  try {
    matrix.emit('memberships', 1); await entered.promise;
    matrix.emit('memberships', 0); matrix.emit('memberships', 1); joining.resolve(); await call.settled();
    assert.equal(call.phase, 'ready'); assert.equal(call.sessionsStarted, 2); assert.equal(matrix.joins, 2); assert.ok(matrix.leaves >= 1);
    matrix.emit('memberships', 0); matrix.emit('memberships', 1); await call.settled();
    assert.equal(call.phase, 'ready'); assert.equal(call.sessionsStarted, 3); assert.equal(matrix.joins, 3);
  } finally { joining.resolve(); await call.close(); sockets.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('hangup during backend startup leaves Matrix without joining', async () => {
  const server = createServer(); const sockets = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const matrix = new FakeMatrix(); const call = new NativeMatrixCall(matrix, `ws://127.0.0.1:${(server.address() as AddressInfo).port}/session`);
  try {
    matrix.emit('memberships', 1); await once(sockets, 'connection'); matrix.emit('memberships', 0); await call.settled();
    assert.equal(call.sessionsStarted, 0); assert.equal(matrix.joins, 0); assert.equal(call.phase, 'idle'); assert.ok(matrix.leaves > 0);
  } finally { await call.close(); sockets.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('native Matrix rejects off-machine and non-session API URLs', () => {
  for (const url of ['ws://example.com/session', 'ws://127.0.0.1/other', 'http://127.0.0.1/session', 'ws://user:pass@127.0.0.1/session']) assert.throws(() => new NativeMatrixCall(new FakeMatrix(), url), /loopback/);
});

test('native reset cancels queued old audio before admitting the next reply', async () => {
  const server = createServer(), sockets = new WebSocketServer({ server }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const matrix = new FakeMatrix(), first = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), played: string[] = [];
  matrix.input = async audio => { played.push(audio!.data); if (audio!.data === 'first') { entered.resolve(); await first.promise; } };
  matrix.interrupt = async () => { played.push('reset'); };
  const call = new NativeMatrixCall(matrix, `ws://127.0.0.1:${(server.address() as AddressInfo).port}/session`);
  sockets.on('connection', ws => ws.on('message', () => ws.send('{"type":"session.started"}')));
  try {
    matrix.emit('memberships', 1); await call.settled();
    const ws = [...sockets.clients][0]!;
    ws.send('{"type":"output.audio","data":"first"}'); await entered.promise;
    ws.send('{"type":"output.audio","data":"old"}'); ws.send('{"type":"output.reset"}'); ws.send('{"type":"output.audio","data":"new"}');
    await delay(20); first.resolve();
    for (let n = 0; n < 100 && played.length < 3; n++) await delay(10);
    assert.deepEqual(played, ['first', 'reset', 'new']);
  } finally { first.resolve(); await call.close(); sockets.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('end_call leaves only the current call and waits for the caller to hang up before answering again', async () => {
  const server = createServer(), sockets = new WebSocketServer({ server }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const matrix = new FakeMatrix(), requests: any[] = [], results: any[] = [];
  const call = new NativeMatrixCall(matrix, `ws://127.0.0.1:${(server.address() as AddressInfo).port}/session`);
  sockets.on('connection', ws => ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'session.start') { requests.push(message); ws.send('{"type":"session.started"}'); }
    if (message.type === 'tool.result') { results.push(message); ws.send(JSON.stringify({ type: 'tool.completed', callId: message.callId, name: 'end_call', success: message.result.success })); }
  }));
  const until = async (condition: () => boolean) => { for (let n = 0; n < 100 && !condition(); n++) await delay(10); assert.ok(condition()); };
  try {
    matrix.emit('memberships', 1); await call.settled();
    assert.ok(requests[0]?.tools?.some((tool: any) => tool.name === 'end_call'), 'advertise the active call control to Codex');
    const ws = [...sockets.clients][0]!;
    ws.send('{"type":"tool.call","callId":"bad","name":"end_call","arguments":{"room":"other"}}');
    await until(() => results.length === 1); assert.equal(results[0].result.success, false); assert.equal(call.phase, 'ready');
    ws.send('{"type":"tool.call","callId":"end-1","name":"end_call","arguments":{}}');
    await until(() => results.length === 2 && call.phase === 'idle');
    assert.equal(results[1].result.success, true); assert.equal(matrix.leaves, 1); assert.equal(call.sessionsStarted, 1);
    matrix.emit('memberships', 2); await call.settled(); assert.equal(call.sessionsStarted, 1, 'do not rejoin the call the agent just left');
    matrix.emit('memberships', 0); matrix.emit('memberships', 1); await call.settled();
    assert.equal(call.phase, 'ready'); assert.equal(call.sessionsStarted, 2);
  } finally { await call.close(); sockets.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('immediate redial waits for previous backend cleanup instead of failing on HTTP 409', async () => {
  const cleanup = Promise.withResolvers<void>(), cleaning = Promise.withResolvers<void>();
  const sends: ((event: Record<string, unknown>) => void)[] = [];
  const app = createSonoraServer({ sessionFactory: send => {
    const first = sends.length === 0; sends.push(send);
    return {
      async handle(input) {
        if (input.type === 'session.start') send({ type: 'session.started' });
        if (input.type === 'tool.result') send({ type: 'tool.completed', callId: input.callId, name: 'end_call', success: input.result.success });
      },
      async close() { if (first) { cleaning.resolve(); await cleanup.promise; } },
    };
  } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const matrix = new FakeMatrix(), call = new NativeMatrixCall(matrix, `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/session`);
  try {
    matrix.emit('memberships', 1); await call.settled();
    sends[0]!({ type: 'tool.call', name: 'end_call', callId: 'end', arguments: {} });
    await cleaning.promise; await call.settled();
    assert.equal(call.phase, 'idle');
    matrix.emit('memberships', 0); matrix.emit('memberships', 1);
    await delay(50);
    assert.equal(call.phase, 'voice', 'wait while the single backend slot is still closing');
    assert.equal(call.sessionsStarted, 1);
    cleanup.resolve(); await call.settled();
    assert.equal(call.phase, 'ready'); assert.equal(call.sessionsStarted, 2);
  } finally { cleanup.resolve(); await call.close(); await app.close(); }
});
