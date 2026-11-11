import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTestWav, testSpeech, audible } from '../scripts/test-audio.ts';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Russian speech generator keeps the UTF8 BOM required by Windows PowerShell 5.1', async () => {
  const script = await readFile(new URL('../scripts/test-speech.ps1', import.meta.url));
  assert.deepEqual([...script.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('test WAV reader rejects truncated audio and unsupported sample formats', () => {
  const wav = Buffer.alloc(46);
  wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(2, 40); wav.writeInt16LE(123, 44);
  assert.equal(parseTestWav(wav).readInt16LE(), 123);
  assert.throws(() => parseTestWav(wav.subarray(0, 45)), /Truncated/);
  wav.writeUInt16LE(3, 20); assert.throws(() => parseTestWav(wav), /PCM16/);
});

test('all spoken smoke fixtures work in a fresh workspace without OS speech tools', async () => {
  const previousDirectory = process.cwd(), previousPath = process.env.PATH;
  const prefix = join(tmpdir(), 'universe-speech-'), directory = await mkdtemp(prefix);
  process.chdir(directory); process.env.PATH = '';
  try {
    for (const [mode, file] of [[false, 'request'], [true, 'command'], ['memory', 'memory'], ['hangup', 'hangup']] as const) {
      const pcm = await testSpeech(mode);
      assert.ok(pcm.length > 96000, `${file} must contain speech`);
      assert.ok(audible({ data: pcm.toString('base64'), sampleRate: 48000, numChannels: 1 }));
      assert.deepEqual(parseTestWav(await readFile(`runtime/test-${file}.wav`)), pcm);
    }
  } finally {
    process.chdir(previousDirectory); process.env.PATH = previousPath;
    assert.ok(directory.startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  }
});
