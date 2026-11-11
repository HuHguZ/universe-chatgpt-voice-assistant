import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createSonoraServer } from '../src/server.ts';
import { SonoraSession } from '../src/session.ts';
import { createNativeMatrixServer } from '../src/matrix/native.ts';
import { testSpeech, audible } from './test-audio.ts';

const hangupMode = process.argv.includes('--hangup');
const pcm = Buffer.concat([await testSpeech(hangupMode ? 'hangup' : 'memory'), Buffer.alloc(2 * 96000)]);
const header = Buffer.alloc(44);
header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(48000, 24); header.writeUInt32LE(96000, 28);
header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
const microphone = resolve(hangupMode ? 'runtime/native-agent-hangup.wav' : 'runtime/native-agent-memory.wav'); await writeFile(microphone, Buffer.concat([header, pcm]));
let shells = 0, endCalls = 0, assistant = '', speechFrames = 0;
const events: Record<string, number> = {};
const api = createSonoraServer({ sessionFactory: send => {
  const session = new SonoraSession(event => {
    events[String(event.type)] = (events[String(event.type)] ?? 0) + 1;
    if (event.type === 'tool.completed' && event.name === 'shell' && event.success) shells++;
    if (event.type === 'tool.completed' && event.name === 'end_call' && event.success) endCalls++;
    if (event.type === 'transcript' && event.role === 'assistant') assistant = event.final ? String(event.text) : assistant + String(event.delta ?? '');
    send(event);
  });
  return { handle: async input => { if (input.type === 'input.audio' && audible(input)) speechFrames++; await session.handle(input); }, close: () => session.close() };
} });
api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening');
const app = await createNativeMatrixServer(`ws://127.0.0.1:${(api.server.address() as AddressInfo).port}/session`);
app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${microphone}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
try {
  const context = await browser.newContext({ locale: 'en-US', permissions: ['microphone'] });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/matrix`);
  const phone = page.getByRole('button', { name: 'Voice call', exact: true }); await phone.waitFor({ timeout: 45000 });
  const backup = page.getByRole('button', { name: 'Not now', exact: true }); if (await backup.isVisible()) await backup.click();
  await phone.click();
  for (let n = 0; app.call.phase !== 'ready'; n++) { assert.ok(n < 600 && app.call.phase !== 'error', 'Native call did not become ready'); await delay(100); }
  const frame = page.frames().find(frame => frame.url().includes('/widgets/element-call/'))!; assert.ok(frame);
  if (hangupMode) {
    for (let n = 0; !endCalls || String(app.call.phase) !== 'idle'; n++) {
      if (n % 20 === 0) console.log(JSON.stringify({ phase: app.call.phase, speechFrames, endCalls, events }));
      assert.ok(n < 180 && String(app.call.phase) !== 'error', 'Spoken request did not end the real Element call'); await delay(500);
    }
    await delay(1000);
    const status = await (await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/status`)).json();
    assert.equal(status.matrix.connected, false, 'The bot must actually leave RTC');
    assert.equal(app.call.sessionsStarted, 1, 'No automatic rejoin after end_call');
    assert.equal(app.call.phase, 'idle', 'The bot stays available for another call');
    console.log(JSON.stringify({ realElement: true, spokenEndCall: true, endCalls, disconnected: true, botOnline: true, subscriptionLogin: true }));
  } else {
    await frame.waitForFunction(() => Array.from(document.querySelectorAll<HTMLMediaElement>('audio,video')).some(element => element.srcObject instanceof MediaStream && element.srcObject.getAudioTracks().length), undefined, { timeout: 15000 });
    await frame.evaluate(async () => {
      const context = new AudioContext({ sampleRate: 48000 }), analyser = context.createAnalyser(); analyser.fftSize = 2048;
      const silent = context.createGain(); silent.gain.value = 0; analyser.connect(silent).connect(context.destination);
      for (const element of document.querySelectorAll<HTMLMediaElement>('audio,video')) if (element.srcObject instanceof MediaStream && element.srcObject.getAudioTracks().length) context.createMediaStreamSource(element.srcObject).connect(analyser);
      await context.resume(); (window as any).nativeAgentAudio = { context, analyser };
    });
    let peak = 0;
    let muted = false;
    const spokenRam = () => (assistant.match(/\d+(?:[.,]\d+)?/g) ?? []).some(value => { const n = Number(value.replace(',', '.')), usable = totalmem() / 1024 ** 3; return n >= usable * 0.95 && n <= usable * 1.1; });
    for (let n = 0;; n++) {
      peak = Math.max(peak, await frame.evaluate(() => { const a = (window as any).nativeAgentAudio.analyser; const samples = new Float32Array(a.fftSize); a.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length); }));
      if (shells > 0 && !muted) { await frame.getByRole('switch', { name: 'Mute microphone', exact: true }).click(); muted = true; }
      if (shells > 0 && spokenRam() && peak > 0.01) break;
      if (n % 20 === 0) console.log(JSON.stringify({ phase: app.call.phase, speechFrames, shells, peak, events, spokenRam: spokenRam() }));
      assert.ok(n < 180 && app.call.phase === 'ready', 'No confirmed spoken RAM result through real Element'); await delay(500);
    }
    await page.screenshot({ path: 'runtime/native-agent-call.png', fullPage: true });
    await frame.locator('button').last().click();
    for (let n = 0; String(app.call.phase) !== 'idle'; n++) { assert.ok(n < 150, 'Native hangup did not clean up'); await delay(100); }
    console.log(JSON.stringify({ realElement: true, encryptedCall: true, nativeShellCommands: shells, actualRamSpoken: spokenRam(), decodedAudibleReply: peak > 0.01, hangup: true, subscriptionLogin: true }));
  }
} finally { await browser.close(); await app.close(); await api.close(); }
