import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createSonoraServer } from '../src/server.ts';

test('rejects foreign browser origins and keeps health available after malformed input', async () => {
  let closed = 0;
  const app = createSonoraServer({ sessionFactory: send => ({ handle: async () => { send({ type: 'ok' }); }, close: async () => { closed++; } }) });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  try {
    const denied = new WebSocket(`ws://127.0.0.1:${port}/session`, { origin: 'https://untrusted.example' });
    await new Promise<void>(resolve => denied.on('error', () => resolve()));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
    await once(ws, 'open');
    const error = once(ws, 'message'); ws.send('{');
    assert.equal(JSON.parse(String((await error)[0])).type, 'error');
    const disconnected = once(ws, 'close'); ws.close(); await disconnected;
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally { await app.close(); }
  assert.ok(closed >= 1);
});

test('interrupt bypasses blocked work and drops audio queued before interruption', async () => {
  let release!: () => void;
  let blocked!: () => void;
  const entered = new Promise<void>(resolve => { blocked = resolve; });
  const calls: string[] = [];
  const app = createSonoraServer({ sessionFactory: send => ({
    async handle(input) {
      calls.push(input.type);
      if (input.type === 'input.text') { blocked(); await new Promise<void>(resolve => { release = resolve; }); }
      send({ type: input.type });
    }, async close() {},
  }) });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/session`);
  try {
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'input.text', text: 'work' })); await entered;
    ws.send(JSON.stringify({ type: 'input.audio', data: 'AAA=', sampleRate: 48000, numChannels: 1 }));
    ws.send(JSON.stringify({ type: 'session.interrupt' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(calls.includes('session.interrupt'));
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.includes('input.audio'), false);
  } finally { release?.(); ws.terminate(); await app.close(); }
});

test('disconnect retains ownership and shutdown waits for cleanup', async () => {
  let release!: () => void;
  let entered!: () => void;
  const cleaning = new Promise<void>(resolve => { entered = resolve; });
  const app = createSonoraServer({ sessionFactory: () => ({ async handle() {}, close: () => { entered(); return new Promise<void>(resolve => { release = resolve; }); } }) });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/session`;
  const ws = new WebSocket(url); await once(ws, 'open'); ws.terminate(); await cleaning;
  const other = new WebSocket(url);
  const rejected = await new Promise<boolean>(resolve => { other.on('error', () => resolve(true)); other.on('open', () => resolve(false)); });
  assert.equal(rejected, true);
  let finished = false;
  const closing = app.close().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release(); await closing;
});
