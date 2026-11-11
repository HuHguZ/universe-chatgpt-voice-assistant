import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SonoraSession, backendPrompt, voicePrompt } from '../src/session.ts';
import { once } from 'node:events';

class FakeCodex extends EventEmitter {
  stopped = false;
  replies: unknown[] = [];
  threadConfig: any;
  threadParams: any;
  async request(method: string, params?: any) {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'config/read') return { config: { mcp_servers: { unrelated: { command: 'do-not-run' } } } };
    if (method === 'thread/start') { this.threadParams = params; this.threadConfig = params.config; return { thread: { id: 'thread-test' } }; }
    return {};
  }
  send(value: unknown) { if (this.stopped) throw new Error('Codex process closed'); this.replies.push(value); this.emit('reply'); }
  close() { this.stopped = true; }
}

test('a connection closed during startup disposes the late Codex child', async () => {
  const rpc = new FakeCodex();
  let resolve!: (value: any) => void;
  const session = new SonoraSession(() => {}, { startCodex: () => new Promise(ready => { resolve = ready; }) });
  const starting = session.handle({ type: 'session.start', voice: false });
  await session.close();
  resolve(rpc);
  await assert.rejects(starting, /closed/);
  assert.equal(rpc.stopped, true);
});

test('local agent can use native shell and file tools and reports actual execution events', async () => {
  const rpc = new FakeCodex();
  const events: any[] = [];
  const session = new SonoraSession(event => events.push(event), { startCodex: async () => rpc as any });
  await session.handle({ type: 'session.start', voice: false });
  assert.equal(rpc.threadParams.sandbox, undefined, 'inherit the locally configured Codex permissions instead of forcing a restricted sandbox');
  assert.equal(rpc.threadParams.config.model_reasoning_effort, 'medium');
  assert.match(backendPrompt, /shell and file tools/);
  assert.doesNotMatch(backendPrompt, /Never read files or run commands/);
  assert.match(voicePrompt, /RAM/);
  rpc.emit('notification', { method: 'item/started', params: { item: { id: 'cmd-1', type: 'commandExecution', status: 'inProgress' } } });
  rpc.emit('notification', { method: 'item/completed', params: { item: { id: 'cmd-1', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'not forwarded' } } });
  assert.deepEqual(events.filter(event => event.type.startsWith('tool.')), [
    { type: 'tool.started', callId: 'cmd-1', name: 'shell' },
    { type: 'tool.completed', callId: 'cmd-1', name: 'shell', success: true },
  ]);
  await session.close();
});

test('client tool forwards arguments and confirmed result, then resolves pending work on close', async () => {
  const rpc = new FakeCodex();
  const events: any[] = [];
  const session = new SonoraSession(event => events.push(event), { startCodex: async () => rpc as any });
  await session.handle({ type: 'session.start', voice: false, tools: [{ name: 'example', description: 'Example', inputSchema: { type: 'object' } }] });
  const params = { callId: 'client-1', tool: 'example', arguments: { value: 7 } };
  rpc.emit('request', { id: 1, method: 'item/tool/call', params });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.find(event => event.type === 'tool.call').arguments, { value: 7 });
  const reply = once(rpc, 'reply');
  await session.handle({ type: 'tool.result', callId: params.callId, result: { success: true, contentItems: [{ type: 'inputText', text: 'done' }] } });
  await reply;
  assert.equal((rpc.replies[0] as any).result.success, true);
  rpc.emit('request', { id: 2, method: 'item/tool/call', params: { ...params, callId: 'client-2' } });
  await new Promise(resolve => setImmediate(resolve));
  await session.close();
  assert.equal(rpc.stopped, true);
});

class FakeVoice extends EventEmitter {
  stopped = false;
  async offer() { return 'offer'; }
  async ready() {}
  async input() {}
  async close() { this.stopped = true; }
}

test('terminal realtime closure disposes voice and rejects subsequent input', async () => {
  const rpc = new FakeCodex();
  const voice = new FakeVoice();
  const events: any[] = [];
  const session = new SonoraSession(event => events.push(event), { startCodex: async () => rpc as any, createVoice: async () => voice as any });
  await session.handle({ type: 'session.start' });
  rpc.emit('notification', { method: 'thread/realtime/closed', params: { reason: 'failed' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(voice.stopped, true);
  await assert.rejects(session.handle({ type: 'input.text', text: 'hello' }), /not ready/);
  assert.equal(events.at(-1).type, 'session.closed');
});

test('terminal interruption suppresses old audio and concurrent close awaits cleanup', async () => {
  const rpc = new FakeCodex();
  const voice = new FakeVoice();
  let release!: () => void;
  voice.close = () => new Promise<void>(resolve => { release = resolve; });
  const events: any[] = [];
  const session = new SonoraSession(event => events.push(event), { startCodex: async () => rpc as any, createVoice: async () => new FakeVoice() as any });
  (session as any).dependencies.createVoice = async () => voice;
  await session.handle({ type: 'session.start' });
  rpc.emit('notification', { method: 'turn/started', params: { turn: { id: 'turn-1' } } });
  const interrupting = session.handle({ type: 'session.interrupt' });
  voice.emit('audio', { data: 'AAA=', sampleRate: 48000, numChannels: 1 });
  assert.equal(events.filter(event => event.type === 'output.audio').length, 0);
  let finished = false;
  const second = session.close().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release(); await Promise.all([interrupting, second]);
  assert.equal(events.at(-1).type, 'session.closed');
});

test('runs the registered local tool once and closes the child on disconnect', async () => {
  const rpc = new FakeCodex();
  const events: any[] = [];
  const session = new SonoraSession(event => events.push(event), { startCodex: async () => rpc as any });
  await session.handle({ type: 'session.start', voice: false });
  assert.equal(events[0].type, 'session.started');
  assert.deepEqual(rpc.threadConfig, { mcp_servers: { unrelated: { enabled: false } }, model_reasoning_effort: 'medium' });
  const replyCount = new Promise<void>(resolve => rpc.on('reply', () => { if (rpc.replies.length === 2) resolve(); }));
  const params = { callId: 'time-1', tool: 'system_time', arguments: {} };
  rpc.emit('request', { id: 1, method: 'item/tool/call', params });
  rpc.emit('request', { id: 2, method: 'item/tool/call', params });
  await replyCount;
  assert.equal(events.filter(event => event.type === 'tool.started').length, 1);
  assert.equal(events.filter(event => event.type === 'tool.completed').length, 1);
  await session.close();
  assert.equal(rpc.stopped, true);
});

test('late server requests after shutdown cannot start tools or write to a closed child', async () => {
  const rpc = new FakeCodex();
  const events: any[] = [];
  const session = new SonoraSession(event => events.push(event), { startCodex: async () => rpc as any });
  await session.handle({ type: 'session.start', voice: false, tools: [{ name: 'example', description: 'Example', inputSchema: { type: 'object' } }] });
  await session.close();
  const before = events.length;
  rpc.emit('request', { id: 1, method: 'item/tool/call', params: { callId: 'late', tool: 'example', arguments: {} } });
  rpc.emit('request', { id: 2, method: 'unsupported' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, before);
  assert.equal(rpc.replies.length, 0);
});
