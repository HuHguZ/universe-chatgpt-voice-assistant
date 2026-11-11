import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AudioChunk } from '../src/voice-transport.ts';

export async function testSpeech(command: boolean | 'memory' | 'hangup' = false): Promise<Buffer> {
  const path = resolve(command === 'hangup' ? 'runtime/test-hangup.wav' : command === 'memory' ? 'runtime/test-memory.wav' : command ? 'runtime/test-command.wav' : 'runtime/test-request.wav');
  try { await access(path); }
  catch {
    if (process.platform !== 'win32') throw new Error('Generate runtime/test-request.wav as PCM16 mono 48 kHz before this smoke');
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/test-speech.ps1'), ...(command === 'hangup' ? ['-Hangup'] : command === 'memory' ? ['-Memory'] : command ? ['-NodeVersion'] : [])], { windowsHide: true, timeout: 20000 });
  }
  return parseTestWav(await readFile(path));
}

export function parseTestWav(wav: Buffer): Buffer {
  assert.ok(wav.length >= 44 && wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE', 'Invalid test WAV');
  let format = false;
  for (let at = 12; at + 8 <= wav.length;) {
    const length = wav.readUInt32LE(at + 4);
    assert.ok(at + 8 + length <= wav.length, 'Truncated test WAV');
    const kind = wav.toString('ascii', at, at + 4);
    if (kind === 'fmt ') {
      assert.ok(length >= 16 && wav.readUInt16LE(at + 8) === 1 && wav.readUInt16LE(at + 10) === 1 && wav.readUInt32LE(at + 12) === 48000 && wav.readUInt16LE(at + 22) === 16, 'Test WAV must be PCM16 mono 48 kHz');
      format = true;
    }
    if (kind === 'data') {
      assert.ok(format && length > 0 && length % 2 === 0, 'Invalid test WAV data');
      return wav.subarray(at + 8, at + 8 + length);
    }
    at += 8 + length + length % 2;
  }
  throw new Error('Test WAV data not found');
}

export async function streamTestSpeech(pcm: Buffer, input: (audio: AudioChunk) => Promise<void>): Promise<void> {
  const start = performance.now();
  for (let at = 0; at < pcm.length; at += 1920) {
    await input({ data: pcm.subarray(at, at + 1920).toString('base64'), sampleRate: 48000, numChannels: 1 });
    await delay(Math.max(0, start + (at + 1920) / 96 - performance.now()));
  }
}

export function audible(audio: AudioChunk): boolean {
  const pcm = Buffer.from(audio.data, 'base64');
  let power = 0;
  for (let i = 0; i < pcm.length; i += 2) power += pcm.readInt16LE(i) ** 2;
  return power / (pcm.length / 2) > 200 ** 2;
}
