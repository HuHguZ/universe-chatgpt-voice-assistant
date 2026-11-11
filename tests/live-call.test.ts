import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

test('live call page serves a join screen and rejects foreign-origin control requests', async () => {
  const module = await import('../src/matrix/live-server.ts');
  const app = await module.createLiveCallServer();
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Войти в звонок/);
    assert.equal((await fetch(`${base}/join`, { method: 'POST', headers: { origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await fetch(`${base}/ready`, { method: 'POST', headers: { origin: base } })).status, 401);
  } finally { await app.close(); }
});
