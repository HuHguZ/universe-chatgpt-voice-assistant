import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceTransport } from '../src/voice-transport.ts';

test('voice playback preserves burst order and rejects excess backlog', async () => {
  const starts: number[] = [];
  const state = { next: 0, inputFrames: 0, inputEnergy: 0, gapSeconds: 0, destination: {}, context: {
    currentTime: 0,
    createBuffer: (_channels: number, frames: number, rate: number) => ({ duration: frames / rate, getChannelData: () => new Float32Array(frames) }),
    createBufferSource: () => ({ buffer: null, connect() {}, start(at: number) { starts.push(at); } }),
  } };
  const previous = (globalThis as any).window;
  (globalThis as any).window = { sonora: state };
  const voice = Object.create(VoiceTransport.prototype) as VoiceTransport;
  (voice as any).page = { evaluate: (fn: any, arg: any) => fn(arg) };
  const audio = { data: Buffer.alloc(9600).toString('base64'), sampleRate: 48000, numChannels: 1 };
  try {
    for (let i = 0; i < 10; i++) await voice.input(audio);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 0.099, 'scheduled audio overlaps');
    await assert.rejects(async () => { for (let i = 0; i < 15; i++) await voice.input(audio); }, /queue is full/);
  } finally { (globalThis as any).window = previous; }
});
