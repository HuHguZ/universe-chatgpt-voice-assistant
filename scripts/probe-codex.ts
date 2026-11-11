import assert from 'node:assert/strict';
import { startCodex, isolatedToolsConfig } from '../src/codex.ts';
import { VoiceTransport } from '../src/voice-transport.ts';
import { voicePrompt, backendPrompt, timeTool } from '../src/session.ts';
import { testSpeech, streamTestSpeech, parseTestWav } from './test-audio.ts';
import { readFile } from 'node:fs/promises';

const rpc = await startCodex();
let voice: VoiceTransport;
try { voice = await VoiceTransport.create(); }
catch (error) { rpc.close(); throw error; }
const counts: Record<string, number> = {};
let audioBytes = 0;
let audibleFrames = 0;
let audibleAfterTool = 0;
let error: string | undefined;
let toolCalls = 0;
const transcriptRoles: Record<string, number> = {};
rpc.on('request', message => {
  if (message.method === 'item/tool/call' && message.params.tool === 'system_time') {
    toolCalls++;
    rpc.send({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ iso: new Date().toISOString() }) }] } });
  } else rpc.send({ id: message.id, error: { code: -32601, message: 'Unsupported probe request' } });
});
voice.on('audio', audio => {
  const pcm = Buffer.from(audio.data, 'base64');
  audioBytes += pcm.length;
  let power = 0;
  for (let i = 0; i < pcm.length; i += 2) power += pcm.readInt16LE(i) ** 2;
  if (power / (pcm.length / 2) > 200 ** 2) { audibleFrames++; if (toolCalls) audibleAfterTool++; }
});
rpc.on('notification', message => {
  counts[message.method] = (counts[message.method] ?? 0) + 1;
  if (message.method === 'thread/realtime/outputAudio/delta') audioBytes += Buffer.from(message.params.audio.data, 'base64').length;
  if (message.method === 'thread/realtime/error') error = message.params.message;
  if (message.method === 'thread/realtime/closed') error = `Realtime closed: ${message.params.reason}`;
  if (message.method === 'thread/realtime/transcript/done') transcriptRoles[message.params.role] = (transcriptRoles[message.params.role] ?? 0) + 1;
  if (message.method === 'thread/realtime/sdp') void voice.answer(message.params.sdp).catch(cause => { error = String(cause); });
});
try {
  const account = await rpc.request('account/read', {});
  assert.equal(account.account?.type, 'chatgpt', 'Sonora requires the existing ChatGPT subscription login');
  console.log(JSON.stringify({ chatgptLogin: true }));
  const { thread } = await rpc.request('thread/start', { cwd: process.cwd(), ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', config: await isolatedToolsConfig(rpc), developerInstructions: backendPrompt, dynamicTools: [{ type: 'function', ...timeTool }] });
  await rpc.request('thread/realtime/start', { threadId: thread.id, outputModality: 'audio', transport: { type: 'webrtc', sdp: await voice.offer() }, version: 'v3', delegationAckFiller: false, prompt: voicePrompt });
  const deadline = Date.now() + 60_000;
  while (!counts['thread/realtime/sdp'] && !error && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!error) {
    await voice.ready();
    await streamTestSpeech(process.argv[2] ? parseTestWav(await readFile(process.argv[2])) : await testSpeech(), audio => voice.input(audio));
  }
  while (audibleAfterTool < 10 && !error && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  console.log(JSON.stringify({ audioBytes, audibleFrames, audibleAfterTool, toolCalls, transcriptRoles, transport: await voice.diagnostics(), events: counts, error }));
  assert.ok(toolCalls >= 1 && audibleAfterTool >= 10, error ?? 'No complete spoken request -> tool -> audible response before deadline');
  await rpc.request('thread/realtime/stop', { threadId: thread.id });
} finally { await voice.close(); rpc.close(); }
