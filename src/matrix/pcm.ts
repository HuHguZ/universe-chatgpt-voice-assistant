import type { AudioChunk } from '../voice-transport.ts';

export function pcmToMono(audio: AudioChunk): Float32Array {
  if (!audio || !Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 96000
    || ![1, 2].includes(audio.numChannels) || typeof audio.data !== 'string' || audio.data.length > 1_024_000
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio.data)) {
    throw new Error('Invalid PCM audio');
  }
  const raw = atob(audio.data);
  const frames = raw.length / (2 * audio.numChannels);
  if (!Number.isInteger(frames) || frames < 1 || frames > audio.sampleRate * 2) throw new Error('Invalid PCM frame count');
  const bytes = new DataView(Uint8Array.from(raw, c => c.charCodeAt(0)).buffer);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    for (let channel = 0; channel < audio.numChannels; channel++) {
      samples[i] += bytes.getInt16((i * audio.numChannels + channel) * 2, true) / (32768 * audio.numChannels);
    }
  }
  return samples;
}
