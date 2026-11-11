import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { JsonRpcProcess } from '../src/codex.ts';

const fixture = fileURLToPath(new URL('./fixtures/rpc-child.mjs', import.meta.url));
function client() { return new JsonRpcProcess(process.execPath, [fixture], { timeoutMs: 500 }); }

test('correlates simultaneous replies and joins split JSONL', async () => {
  const rpc = client();
  try {
    assert.deepEqual(await Promise.all([rpc.request('echo', { a: 1 }), rpc.request('split', {})]), [{ a: 1 }, 'joined']);
  } finally { rpc.close(); }
});

test('delivers notifications and rejects protocol errors', async () => {
  const rpc = client();
  try {
    const event = once(rpc, 'notification');
    await rpc.request('notify', {});
    assert.deepEqual((await event)[0], { method: 'changed', params: { value: 1 } });
    await assert.rejects(rpc.request('fail', {}), /expected failure/);
  } finally { rpc.close(); }
});

test('rejects pending calls on process exit and timeout', async () => {
  const rpc = client();
  await assert.rejects(rpc.request('exit', {}), /closed/);
  rpc.close();
  const timeout = client();
  try { await assert.rejects(timeout.request('hang', {}), /timed out/); }
  finally { timeout.close(); }
});

test('reports missing executable without an unhandled process error', async () => {
  const rpc = new JsonRpcProcess('sonora-nonexistent-executable', [], { timeoutMs: 500 });
  await assert.rejects(rpc.request('echo', {}), /start|ENOENT/);
  rpc.close();
});
