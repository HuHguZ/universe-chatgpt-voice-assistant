import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createSonoraServer } from '../src/server.ts';
import { SonoraSession } from '../src/session.ts';
import { VoiceTransport } from '../src/voice-transport.ts';
import { MatrixAudioTransport } from '../src/matrix/transport.ts';
import { setRobotProfile } from '../src/matrix/profile.ts';
import { testSpeech, streamTestSpeech, audible } from './test-audio.ts';
import { nodeVersionTool, runNodeVersion } from './demo-tool.ts';
import { totalmem } from 'node:os';

const { createLabUser, createLabRoom, matrixRequest, MATRIX_URL } = await import(new URL('../infra/lab.mjs', import.meta.url).href);
const users: any[] = [];
const transports: MatrixAudioTransport[] = [];
let voice: VoiceTransport | undefined;
const app = createSonoraServer({ sessionFactory: send => new SonoraSession(send, { createVoice: async () => { voice = await VoiceTransport.create(); return voice; } }) });
let ws: WebSocket | undefined;
let audioQueue = Promise.resolve();
let failure: Error | undefined;
let toolCompleted = false;
let heardReply = 0;
let botAudibleFrames = 0;
let sentFrames = 0;
const transcriptRoles: Record<string, number> = {};
const events: Record<string, number> = {};
const commandMode = process.argv.includes('--command');
const memoryMode = process.argv.includes('--memory');
const requestedTool = memoryMode ? 'shell' : commandMode ? 'node_version' : 'system_time';
let commands = 0;
let taskCompleted = false;
let assistantText = '';
try {
  const pcm = await testSpeech(memoryMode ? 'memory' : commandMode);
  users.push(await createLabUser(undefined, 'Universe'), await createLabUser(undefined, 'Universe test caller'));
  await setRobotProfile(MATRIX_URL, users[0]);
  const roomId = await createLabRoom(users[0], users[1]);
  await matrixRequest(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/org.matrix.msc4143.rtc.slot/${encodeURIComponent('m.call#ROOM')}`, { method: 'PUT', token: users[0].accessToken, body: { status: 'open', application: { type: 'm.call' }, encryption: { type: 'org.matrix.msc4143.per_member' } } });
  const created = await Promise.allSettled(users.map(user => MatrixAudioTransport.create({ homeserver: MATRIX_URL, ...user, roomId })));
  for (const result of created) if (result.status === 'fulfilled') transports.push(result.value);
  const rejected = created.find(result => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  const [bot, caller] = transports as [MatrixAudioTransport, MatrixAudioTransport];
  for (let attempt = 0;; attempt++) {
    const status = await Promise.all(transports.map(transport => transport.status()));
    if (status.every(state => state.keyParticipants >= 2 && state.remoteEncrypted)) break;
    assert.ok(attempt < 100, 'Matrix media key exchange timed out');
    await delay(100);
  }
  console.log(JSON.stringify({ stage: 'encrypted Matrix participants ready' }));
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  ws = new WebSocket(`ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/session`);
  await once(ws, 'open');
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Universe voice startup timed out')), 40000);
    ws!.on('message', async raw => {
      const event = JSON.parse(raw.toString());
      events[event.type] = (events[event.type] ?? 0) + 1;
      if (event.type === 'transcript' && event.final) transcriptRoles[event.role] = (transcriptRoles[event.role] ?? 0) + 1;
      if (event.type === 'transcript' && event.role === 'assistant') {
        if (event.final) assistantText = event.text;
        else assistantText += event.delta ?? '';
      }
      if (event.type === 'task.completed' && event.status === 'completed') taskCompleted = true;
      if (event.type === 'session.started') { clearTimeout(timer); resolve(); }
      if (event.type === 'error') { failure ??= new Error(event.message); clearTimeout(timer); reject(failure); }
      if (event.type === 'tool.completed' && event.name === requestedTool && event.success) toolCompleted = true;
      if (event.type === 'tool.call') {
        let result;
        try { commands++; result = await runNodeVersion(event.name, event.arguments); }
        catch { failure ??= new Error('Local demonstration command failed'); result = { success: false, contentItems: [{ type: 'inputText', text: failure.message }] }; }
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'tool.result', callId: event.callId, result }));
      }
      if (event.type === 'output.audio') audioQueue = audioQueue.then(() => bot.input(event)).catch(error => { failure = error; });
      if (event.type === 'output.reset') audioQueue = audioQueue.then(() => bot.interrupt());
    });
  });
  ws.send(JSON.stringify({ type: 'session.start', voice: true, tools: commandMode ? [nodeVersionTool] : [] }));
  await started;
  console.log(JSON.stringify({ stage: 'subscribed voice ready' }));
  bot.on('audio', audio => {
    if (audible(audio)) botAudibleFrames++;
    if (ws?.readyState === WebSocket.OPEN) { sentFrames++; ws.send(JSON.stringify({ type: 'input.audio', ...audio })); }
  });
  caller.on('audio', audio => { if (toolCompleted && audible(audio)) heardReply++; });
  for (const transport of transports) transport.on('transportError', error => { failure = error; });
  await streamTestSpeech(pcm, audio => caller.input(audio));
  const deadline = Date.now() + 60000;
  const spokenRam = () => (assistantText.match(/\d+(?:[.,]\d+)?/g) ?? []).some(value => {
    const gib = Number(value.replace(',', '.'));
    const usable = totalmem() / 1024 ** 3;
    return gib >= usable * 0.95 && gib <= usable * 1.1;
  });
  const complete = () => heardReply >= 50 && taskCompleted && (!commandMode || assistantText.includes(process.versions.node)) && (!memoryMode || spokenRam());
  while (!failure && !complete() && Date.now() < deadline) await delay(100);
  console.log(JSON.stringify({ botAudibleFrames, sentFrames, transcriptRoles, events, failure: failure?.message, voice: await voice?.diagnostics().catch(() => ({ closed: true })) }));
  if (failure) throw failure;
  assert.ok(toolCompleted, `Spoken Matrix request did not execute ${requestedTool} through Universe`);
  assert.equal(commands, commandMode ? 1 : 0);
  assert.ok(heardReply >= 50 && taskCompleted, 'Matrix caller did not receive an audible assistant reply after the completed backend task');
  if (commandMode) assert.ok(assistantText.includes(process.versions.node), 'Spoken assistant transcript did not confirm the actual Node version');
  if (memoryMode) assert.ok(spokenRam(), 'Spoken assistant transcript did not confirm actual installed RAM');
  console.log(JSON.stringify({ matrixToSubscribedCodex: true, encryptedCall: true, actualToolExecuted: requestedTool, localCommandExecuted: commands === 1 || memoryMode && toolCompleted, spokenVersionConfirmed: commandMode && assistantText.includes(process.versions.node), spokenRamConfirmed: memoryMode && spokenRam(), callerAudibleFrames: heardReply, events }));
} finally {
  ws?.terminate();
  await app.close();
  await audioQueue.catch(() => {});
  await Promise.allSettled(transports.map(transport => transport.close()));
  await Promise.allSettled(users.map(user => matrixRequest('/_matrix/client/v3/logout', { method: 'POST', token: user.accessToken, body: {} })));
}
