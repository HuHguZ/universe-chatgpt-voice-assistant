import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { WebSocketServer, WebSocket } from 'ws';
import { createNativeMatrixServer } from '../src/matrix/native.ts';

function tone(frequency: number, samples: number, offset = 0): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let n = 0; n < samples; n++) pcm.writeInt16LE(Math.round(Math.sin((n + offset) * 2 * Math.PI * frequency / 48000) * 12000), n * 2);
  return pcm;
}

function amplitude(pcm: Buffer, frequency: number): number {
  let re = 0, im = 0;
  for (let n = 0; n < pcm.length / 2; n++) {
    const sample = pcm.readInt16LE(n * 2) / 32768, angle = n * 2 * Math.PI * frequency / 48000;
    re += sample * Math.cos(angle); im += sample * Math.sin(angle);
  }
  return Math.hypot(re, im) / (pcm.length / 2);
}

const until = async (condition: () => boolean | Promise<boolean>, message: string) => {
  for (let n = 0; n < 200; n++) { if (await condition()) return; await delay(100); }
  throw new Error(message);
};

// This proof uses a fake universal API and synthetic PCM, never a subscribed voice model.
const pcm = tone(600, 48000 * 30), wav = Buffer.alloc(44);
for (let n = 0; n < pcm.length / 2; n++) pcm.writeInt16LE(Math.round(pcm.readInt16LE(n * 2) * (n % 9600 < 7200 ? 1 : 0)), n * 2);
wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
await mkdir('runtime', { recursive: true });
const microphone = resolve('runtime/native-test-tone.wav'); await writeFile(microphone, Buffer.concat([wav, pcm]));
const api = createServer(), sockets = new WebSocketServer({ server: api });
let inputPeak = 0, inputFrames = 0, sessionsClosed = 0;
let current: WebSocket | undefined;
sockets.on('connection', ws => {
  current = ws; ws.on('close', () => sessionsClosed++);
  ws.on('message', raw => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'session.start') ws.send('{"type":"session.started"}');
    if (event.type === 'input.audio') { inputFrames++; inputPeak = Math.max(inputPeak, amplitude(Buffer.from(event.data, 'base64'), 600)); }
  });
});
api.listen(0, '127.0.0.1'); await once(api, 'listening');
const app = await createNativeMatrixServer(`ws://127.0.0.1:${(api.address() as AddressInfo).port}/session`);
app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${microphone}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const context = await browser.newContext({ locale: 'en-US', permissions: ['microphone'] });
let microphoneRequests = 0;
await context.exposeFunction('nativeMicrophoneRequested', () => { microphoneRequests++; });
await context.addInitScript(() => {
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (...args) => { (window as any).nativeMicrophoneRequested(); return capture(...args); };
});
const page = await context.newPage();
try {
  const bootstrap = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${bootstrap}/status`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const navigationStatus = await new Promise<number | undefined>((resolve, reject) => {
    httpRequest(`${bootstrap}/status`, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject).end();
  });
  assert.equal(navigationStatus, 200);
  await page.goto(`${bootstrap}/matrix`);
  await page.getByRole('button', { name: 'Voice call', exact: true }).waitFor({ timeout: 45000 });
  const backup = page.getByRole('button', { name: 'Not now', exact: true }); if (await backup.isVisible()) await backup.click();
  assert.equal(microphoneRequests, 0, 'opening a chat must not capture the microphone');
  await page.getByRole('button', { name: 'Voice call', exact: true }).click();
  await until(() => app.call.phase === 'ready', 'native call did not become ready');
  await until(() => inputPeak > 0.03, 'the API did not receive the decrypted 600 Hz microphone tone');
  assert.equal(microphoneRequests, 1, 'one-click voice call must capture without a mute toggle');
  const frame = page.frames().find(frame => frame.url().includes('/widgets/element-call/'))!;
  assert.ok(frame, 'real Element Call widget required');
  await until(async () => frame.locator('audio,video').evaluateAll(elements => elements.some(element => (element as HTMLMediaElement).srcObject instanceof MediaStream)), 'Element did not attach its remote audio');
  await frame.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48000 }), analyser = context.createAnalyser(); analyser.fftSize = 2048;
    const silence = context.createGain(); silence.gain.value = 0; analyser.connect(silence).connect(context.destination);
    for (const element of document.querySelectorAll<HTMLMediaElement>('audio,video')) if (element.srcObject instanceof MediaStream && element.srcObject.getAudioTracks().length) context.createMediaStreamSource(element.srcObject).connect(analyser);
    await context.resume(); (window as any).nativeAudioCheck = { context, analyser };
  });
  let outputPeak = 0;
  for (let n = 0; n < 100; n++) {
    assert.equal(current?.readyState, WebSocket.OPEN);
    current!.send(JSON.stringify({ type: 'output.audio', data: tone(1100, 960, n * 960).toString('base64'), sampleRate: 48000, numChannels: 1 }));
    outputPeak = Math.max(outputPeak, await frame.evaluate(() => {
      const { analyser } = (window as any).nativeAudioCheck, samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
      let re = 0, im = 0; for (let n = 0; n < samples.length; n++) { const angle = n * 2 * Math.PI * 1100 / 48000; re += samples[n]! * Math.cos(angle); im += samples[n]! * Math.sin(angle); }
      return Math.hypot(re, im) / samples.length;
    }));
    await delay(20);
  }
  assert.ok(outputPeak > 0.03, 'Element did not receive the decrypted 1100 Hz API tone');
  await frame.getByRole('switch', { name: 'Mute microphone', exact: true }).click();
  await delay(500); inputPeak = 0;
  await delay(700);
  assert.ok(inputPeak < 0.01, 'muting must stop the microphone tone from reaching the API');
  assert.equal(microphoneRequests, 1, 'muting must not automatically restart capture');
  await frame.getByRole('switch', { name: 'Unmute microphone', exact: true }).click();
  await until(() => inputPeak > 0.03, 'unmuting did not restore microphone audio');
  const status = await (await fetch(`${bootstrap}/status`)).json();
  assert.ok(status.matrix.encrypted && status.matrix.remoteEncrypted && status.matrix.keysReceived > 0);
  await page.screenshot({ path: 'runtime/native-element-call.png', fullPage: true });
  // The native widget's icon buttons use descriptions; the final button is its visible red hangup control.
  await frame.locator('button').last().click();
  await until(() => app.call.phase === 'idle' && sessionsClosed === 1, 'Element hangup did not close the universal API session');
  await page.getByRole('button', { name: 'Voice call', exact: true }).click();
  await until(() => app.call.phase === 'ready' && app.call.sessionsStarted === 2, 'a second native call did not reconnect');
  const secondFrame = page.frames().find(frame => frame.url().includes('/widgets/element-call/'))!;
  await secondFrame.locator('button').last().click();
  await until(() => app.call.phase === 'idle' && sessionsClosed === 2, 'second native hangup did not clean up');
  console.log(JSON.stringify({ realElementChat: true, automaticMicrophone: true, encryptedParticipants: 2, decodedMicrophoneTone: inputPeak > 0.03, decodedApiTone: outputPeak > 0.03, mutingHonored: true, inputFrames, hangupClosedApi: true, repeatedCall: true, noSubscribedModel: true }));
} catch (error) {
  await page.screenshot({ path: 'runtime/native-element-failure.png', fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ phase: app.call.phase, inputFrames, decodedMicrophoneTone: inputPeak, microphoneRequests }));
  throw error;
} finally {
  await browser.close(); await app.close(); sockets.close(); await new Promise<void>(resolve => api.close(() => resolve()));
}
