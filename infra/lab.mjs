import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MATRIX_URL = 'http://127.0.0.1:18008';
export const LIVEKIT_URL = 'ws://127.0.0.1:17880';
export const JWT_URL = 'http://127.0.0.1:16080';
export const RTC_TOKEN_PATH = '/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token';

export async function matrixRequest(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${MATRIX_URL}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  // Error bodies can contain request credentials; report only status and error code.
  if (!response.ok) throw new Error(`Matrix HTTP ${response.status} (${data.errcode ?? 'unknown'})`);
  return data;
}

export async function createLabUser(localpart = `sonora_${randomBytes(8).toString('hex')}`, displayName = 'Sonora lab') {
  assert.match(localpart, /^[a-z0-9_=-]{1,64}$/);
  const account = await matrixRequest('/_matrix/client/v3/register', {
    method: 'POST',
    body: {
      username: localpart,
      password: randomBytes(32).toString('base64url'),
      auth: { type: 'm.login.dummy' },
      initial_device_display_name: 'Sonora local test',
    },
  });
  const user = { userId: account.user_id, deviceId: account.device_id, accessToken: account.access_token };
  assert.equal(typeof user.accessToken, 'string');
  assert.ok(user.accessToken.length > 0);
  await matrixRequest(`/_matrix/client/v3/profile/${encodeURIComponent(user.userId)}/displayname`, {
    method: 'PUT', token: user.accessToken, body: { displayname: displayName },
  });
  return user;
}

export async function createLabRoom(owner, guest) {
  const room = await matrixRequest('/_matrix/client/v3/createRoom', {
    method: 'POST', token: owner.accessToken,
    body: {
      name: 'Sonora isolated test',
      preset: 'private_chat',
      invite: [guest.userId],
      creation_content: { 'm.federate': false },
      initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
    },
  });
  await matrixRequest(`/_matrix/client/v3/join/${encodeURIComponent(room.room_id)}`, {
    method: 'POST', token: guest.accessToken, body: {},
  });
  return room.room_id;
}

export async function getLiveKitToken(user, roomId, memberId = randomUUID(), slotId = 'm.call') {
  const result = await matrixRequest(RTC_TOKEN_PATH, {
    method: 'POST', token: user.accessToken,
    body: { server_name: 'sonora.local', url: LIVEKIT_URL, room_id: roomId, slot_id: slotId, member_id: memberId },
  });
  assert.equal(typeof result.jwt, 'string');
  return { url: LIVEKIT_URL, jwt: result.jwt, memberId, slotId };
}

function verifyLabJwt(jwt) {
  const [header, payload, signature] = jwt.split('.');
  // This public dev secret is deliberately identical to livekit.yaml.
  assert.equal(signature, createHmac('sha256', 'sonora-local-dev-secret-not-for-production').update(`${header}.${payload}`).digest('base64url'));
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.iss, 'devkey');
  assert.equal(claims.video.roomJoin, true);
  assert.ok(claims.exp > Date.now() / 1000);
  return claims;
}

export async function smoke() {
  for (const url of [`${MATRIX_URL}/health`, `${LIVEKIT_URL.replace('ws:', 'http:')}/`, `${JWT_URL}/healthz`]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, `Unhealthy endpoint: ${url}`);
  }
  const users = [];
  try {
    const owner = await createLabUser(undefined, 'Sonora assistant'); users.push(owner);
    const guest = await createLabUser(undefined, 'Sonora test participant'); users.push(guest);
    for (const user of users) {
      const identity = await matrixRequest('/_matrix/client/v3/account/whoami', { token: user.accessToken });
      assert.equal(identity.user_id, user.userId);
    }
    const transport = await matrixRequest('/_matrix/client/unstable/org.matrix.msc4143/rtc/transports', { token: owner.accessToken });
    const livekit = transport.rtc_transports.find((item) => item.type === 'livekit');
    assert.equal(livekit?.url, LIVEKIT_URL);
    assert.equal(livekit?.server_name, 'sonora.local');
    assert.equal(livekit?.livekit_service_url, undefined);
    const roomId = await createLabRoom(owner, guest);
    const encryption = await matrixRequest(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`, { token: owner.accessToken });
    assert.equal(encryption.algorithm, 'm.megolm.v1.aes-sha2');
    const ownerJwt = verifyLabJwt((await getLiveKitToken(owner, roomId)).jwt);
    const guestJwt = verifyLabJwt((await getLiveKitToken(guest, roomId)).jwt);
    assert.equal(ownerJwt.video.room, guestJwt.video.room);
    assert.notEqual(ownerJwt.sub, guestJwt.sub);
    await assert.rejects(matrixRequest(RTC_TOKEN_PATH, { method: 'POST', body: {} }), /HTTP 401/);
    await assert.rejects(getLiveKitToken(guest, '!not-joined:sonora.local'), /HTTP 403/);
    return { healthyServices: 3, authenticatedParticipants: 2, encryptedRoomState: true, signedLiveKitTokens: 2, deniedAnonymousAndNonMember: true };
  } finally {
    for (const user of users) {
      await matrixRequest('/_matrix/client/v3/logout', { method: 'POST', token: user.accessToken, body: {} }).catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await smoke())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
