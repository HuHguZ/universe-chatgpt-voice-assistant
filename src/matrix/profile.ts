import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function setRobotProfile(homeserver: string, user: { userId: string; accessToken: string }, displayName = 'Universe'): Promise<void> {
  const base = homeserver.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${user.accessToken}` };
  const robot = await readFile(resolve('src/matrix/robot.png'));
  const upload = await fetch(`${base}/_matrix/media/v3/upload?filename=universe.png`, { method: 'POST', headers: { ...headers, 'content-type': 'image/png' }, body: robot, signal: AbortSignal.timeout(15_000) });
  if (!upload.ok) throw new Error(`Matrix avatar upload failed (HTTP ${upload.status})`);
  const { content_uri } = await upload.json();
  if (typeof content_uri !== 'string' || !/^mxc:\/\/[^/]+\/[^/]+$/.test(content_uri)) throw new Error('Invalid Matrix avatar URI');
  for (const [field, value] of Object.entries({ displayname: displayName, avatar_url: content_uri })) {
    const response = await fetch(`${base}/_matrix/client/v3/profile/${encodeURIComponent(user.userId)}/${field}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ [field]: value }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Matrix profile update failed (HTTP ${response.status})`);
  }
}
