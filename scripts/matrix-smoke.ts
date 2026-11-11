import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MatrixAudioTransport } from '../src/matrix/transport.ts';
import { setRobotProfile } from '../src/matrix/profile.ts';
import type { AudioChunk } from '../src/voice-transport.ts';
// Keep the lab's own CLI entry guard outside the bundled smoke entry point.
const { createLabUser, createLabRoom, matrixRequest, MATRIX_URL } = await import(new URL('../infra/lab.mjs', import.meta.url).href);

function tone(frequency: number, frame: number): AudioChunk {
  const bytes = Buffer.alloc(960 * 2);
  for (let i = 0; i < 960; i++) bytes.writeInt16LE(Math.round(Math.sin((frame * 960 + i) * 2 * Math.PI * frequency / 48000) * 16000), i * 2);
  return { data: bytes.toString('base64'), sampleRate: 48000, numChannels: 1 };
}

function energy(chunks: AudioChunk[], frequency: number): number {
  let total = 0;
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk.data, 'base64');
    let re = 0, im = 0;
    for (let i = 0, at = 0; i < bytes.length; i += 2, at++) {
      const x = bytes.readInt16LE(i) / 32768;
      const angle = at * 2 * Math.PI * frequency / 48000;
      re += x * Math.cos(angle); im += x * Math.sin(angle);
    }
    total += Math.hypot(re, im) / (bytes.length / 2);
  }
  return total / Math.max(1, chunks.length);
}

function peak(chunks: AudioChunk[]): number {
  let peak = 0;
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk.data, 'base64');
    for (let i = 0; i < bytes.length; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
  }
  return peak;
}

export async function matrixSmoke(lateJoin = false) {
  const users: { userId: string; deviceId: string; accessToken: string }[] = [];
  const transports: MatrixAudioTransport[] = [];
  try {
    users.push(await createLabUser(undefined, 'Sonora'));
    users.push(await createLabUser(undefined, 'Sonora test participant'));
    await setRobotProfile(MATRIX_URL, users[0]!);
    const profile = await matrixRequest(`/_matrix/client/v3/profile/${encodeURIComponent(users[0]!.userId)}`);
    assert.equal(profile.displayname, 'Universe'); assert.match(profile.avatar_url, /^mxc:\/\//);
    const roomId = await createLabRoom(users[0], users[1]);
    await matrixRequest(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/org.matrix.msc4143.rtc.slot/${encodeURIComponent('m.call#ROOM')}`, { method: 'PUT', token: users[0].accessToken, body: { status: 'open', application: { type: 'm.call' }, encryption: { type: 'org.matrix.msc4143.per_member' } } });
    if (lateJoin) {
      for (const user of users) transports.push(await MatrixAudioTransport.create({ homeserver: MATRIX_URL, ...user, roomId }));
    } else {
      const results = await Promise.allSettled(users.map(user => MatrixAudioTransport.create({ homeserver: MATRIX_URL, ...user, roomId })));
      for (const result of results) if (result.status === 'fulfilled') transports.push(result.value);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    const [a, b] = transports as [MatrixAudioTransport, MatrixAudioTransport];
    const received: AudioChunk[][] = [[], []];
    a.on('audio', audio => received[0]!.push(audio)); b.on('audio', audio => received[1]!.push(audio));
    for (let i = 0; i < 100; i++) {
      const states = await Promise.all(transports.map(transport => transport.status()));
      if (states.every(state => state.remoteEncrypted && state.keyParticipants >= 2 && state.memberships === 2)) break;
      if (i === 99) throw new Error(`Matrix participants did not exchange encrypted media keys: ${JSON.stringify(states)}`);
      await delay(100);
    }
    for (let frame = 0; frame < 100; frame++) {
      await Promise.all([a.input(tone(700, frame)), b.input(tone(1100, frame))]);
      await delay(20);
    }
    await delay(500);
    assert.ok(energy(received[0]!, 1100) > 0.01, `Participant A must receive B decrypted tone: ${JSON.stringify(received.map(chunks => ({ frames: chunks.length, peak: peak(chunks), energy700: energy(chunks, 700), energy1100: energy(chunks, 1100) })))}`);
    assert.ok(energy(received[1]!, 700) > 0.01, 'Participant B must receive A decrypted tone');
    assert.ok(energy(received[0]!, 1100) > energy(received[0]!, 700) * 5, 'Participant A must receive the remote track');
    assert.ok(energy(received[1]!, 700) > energy(received[1]!, 1100) * 5, 'Participant B must receive the remote track');
    const before = await a.status();
    assert.ok(before.encrypted && before.remoteEncrypted);
    await b.close();
    let rotated = false;
    for (let i = 0; i < 200; i++) {
      const after = await a.status();
      if (after.localKeyIndex !== before.localKeyIndex && after.memberships === 1) { rotated = true; break; }
      await delay(100);
    }
    assert.ok(rotated, 'The remaining participant must rotate its media key after a leaver');
    return { botProfile: true, encryptedParticipants: 2, bidirectionalTone: true, receivedFrames: received.map(chunks => chunks.length), mediaKeyRotation: true };
  } finally {
    await Promise.allSettled(transports.map(transport => transport.close()));
    await Promise.allSettled(users.map(user => matrixRequest('/_matrix/client/v3/logout', { method: 'POST', token: user.accessToken, body: {} })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await matrixSmoke(process.argv.includes('--late-join')))); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Matrix smoke failed'); process.exitCode = 1; }
}
