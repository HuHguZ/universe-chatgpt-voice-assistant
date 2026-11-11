import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { nodeVersionTool, runNodeVersion } from './demo-tool.ts';
import { createSonoraServer } from '../src/server.ts';
import { testSpeech, streamTestSpeech, audible } from './test-audio.ts';
import { SonoraSession } from '../src/session.ts';
import { startCodex } from '../src/codex.ts';
import { VoiceTransport } from '../src/voice-transport.ts';

const backendEvents: Record<string, number> = {};
let closedReason: string | undefined;
let voice: VoiceTransport | undefined;
const app = createSonoraServer({ sessionFactory: send => new SonoraSession(send, {
  startCodex: async () => {
    const rpc = await startCodex();
    rpc.on('notification', message => {
      backendEvents[message.method] = (backendEvents[message.method] ?? 0) + 1;
      if (message.method === 'thread/realtime/closed') closedReason = /^[a-z_ -]{1,60}$/i.test(message.params.reason) ? message.params.reason : 'unknown';
    }); return rpc;
  }, createVoice: async () => { voice = await VoiceTransport.create(); return voice; },
}) });
await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
const ws = new WebSocket(`ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/session`);
const types: Record<string, number> = {};
let commands = 0;
let toolFailure = false;
const voiceMode = process.argv.includes('--voice');
let timeConfirmed = false;
let audibleReply = 0;
try {
  await once(ws, 'open');
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tool smoke timed out')), 60000);
    ws.on('message', async raw => {
      const event = JSON.parse(raw.toString());
      types[event.type] = (types[event.type] ?? 0) + 1;
      if (event.type === 'session.started') {
        if (voiceMode) void testSpeech().then(pcm => streamTestSpeech(pcm, async audio => { ws.send(JSON.stringify({ type: 'input.audio', ...audio })); })).catch(reject);
        else ws.send(JSON.stringify({ type: 'input.text', text: 'Вызови system_time и node_version. Кратко сообщи точное время и версию Node.js. Обязательно используй оба инструмента, не угадывай.' }));
      }
      if (event.type === 'tool.completed' && event.name === 'system_time' && event.success) timeConfirmed = true;
      if (event.type === 'output.audio' && timeConfirmed && audible(event)) audibleReply++;
      if (event.type === 'tool.call') {
        let result;
        try {
          commands++;
          result = await runNodeVersion(event.name, event.arguments);
        } catch { toolFailure = true; result = { success: false, contentItems: [{ type: 'inputText', text: 'Demonstration command failed' }] }; }
        ws.send(JSON.stringify({ type: 'tool.result', callId: event.callId, result }));
      }
      if (event.type === 'error') { clearTimeout(timer); reject(new Error(event.message)); }
      if ((!voiceMode && event.type === 'task.completed') || (voiceMode && audibleReply >= 10)) { clearTimeout(timer); resolve(); }
    });
  });
  ws.send(JSON.stringify({ type: 'session.start', voice: voiceMode, tools: [nodeVersionTool] }));
  await done;
  assert.equal(types['tool.completed'], voiceMode ? 1 : 2);
  assert.equal(commands, voiceMode ? 0 : 1);
  assert.equal(toolFailure, false);
  console.log(JSON.stringify({ subscribedToolSmoke: 'passed', voice: voiceMode, audibleReply, localCommandExecuted: commands === 1, events: types }));
} finally {
  if (voiceMode) console.log(JSON.stringify({ events: types, backendEvents, closedReason, voice: await voice?.diagnostics().catch(() => ({ closed: true })) }));
  ws.terminate(); await app.close();
}
