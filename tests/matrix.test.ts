import assert from 'node:assert/strict';
import test from 'node:test';
import { pcmToMono } from '../src/matrix/pcm.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setRobotProfile } from '../src/matrix/profile.ts';

test('Matrix audio downmixes signed little-endian stereo without clipping', () => {
  // -32768/+32767, +16384/+16384, -16384/-16384.
  const audio = { data: 'AID/fwBAAEAAwADA', sampleRate: 24000, numChannels: 2 };
  assert.deepEqual(Array.from(pcmToMono(audio)), [-1 / 65536, 0.5, -0.5]);
});

test('Matrix audio rejects malformed, partial, oversized and unsupported PCM', () => {
  const valid = { data: 'AAA=', sampleRate: 48000, numChannels: 1 };
  for (const invalid of [
    { ...valid, data: '!' }, { ...valid, data: 'AA==' }, { ...valid, data: '' },
    { ...valid, sampleRate: 0 }, { ...valid, numChannels: 3 },
    { ...valid, data: Buffer.alloc(48000 * 2 * 3).toString('base64') },
  ]) assert.throws(() => pcmToMono(invalid), /PCM/);
});

test('bot profile uploads a robot image and sets the Universe name and returned Matrix avatar', async () => {
  const requests: { path: string; method?: string; authorization?: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
    const body = request.url?.includes('/upload') ? Buffer.concat(parts).toString('base64') : Buffer.concat(parts).toString();
    requests.push({ path: request.url!, method: request.method, authorization: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url?.includes('/upload') ? { content_uri: 'mxc://lab/robot' } : {}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await setRobotProfile(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { userId: '@sonora:lab', accessToken: 'test-only' });
    assert.equal(requests.length, 3);
    assert.ok(requests.every(request => request.authorization === 'Bearer test-only'));
    assert.equal(requests[0]?.method, 'POST'); assert.match(requests[0]!.body, /^iVBORw0KGgo/);
    const updates = Object.fromEntries(requests.slice(1).map(request => [request.path.split('/').at(-1), JSON.parse(request.body)]));
    assert.deepEqual(updates.displayname, { displayname: 'Universe' });
    assert.deepEqual(updates.avatar_url, { avatar_url: 'mxc://lab/robot' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
