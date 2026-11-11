import assert from 'node:assert/strict';
import { startCodex } from '../src/codex.ts';
import { VoiceTransport } from '../src/voice-transport.ts';
import { runNodeVersion } from './demo-tool.ts';
import { testSpeech, audible } from './test-audio.ts';

const version = await runNodeVersion('node_version', {});
assert.equal(version.contentItems[0]!.text, process.version);
const rpc = await startCodex();
try { assert.ok((await rpc.request('config/read', { includeLayers: false })).config); }
finally { rpc.close(); }

const pcm = await testSpeech();
const voice = await VoiceTransport.create();
try {
  const sdp = await voice.offer();
  assert.match(sdp, /m=audio/); assert.match(sdp, /m=application/);
  const input = { data: pcm.subarray(0, 96000).toString('base64'), sampleRate: 48000, numChannels: 1 };
  assert.ok(audible(input)); await voice.input(input);
  const diagnostics: any = await voice.diagnostics();
  assert.equal(diagnostics.audioContext, 'running'); assert.equal(diagnostics.inputFrames, 48000);
  assert.ok(diagnostics.inputEnergy > 0);
  console.log(JSON.stringify({ platform: process.platform, architecture: process.arch, nativeProcess: true, codexRpc: true, chromiumWebRTC: true, pcmInput: true, modelStarted: false }));
} finally { await voice.close(); }
