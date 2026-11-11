import test from 'node:test';
import assert from 'node:assert/strict';
import { runNodeVersion } from '../scripts/demo-tool.ts';

test('demonstration command rejects unregistered names and arguments, then returns actual Node version', async () => {
  await assert.rejects(runNodeVersion('other', {}));
  await assert.rejects(runNodeVersion('node_version', { command: 'untrusted' }));
  const result = await runNodeVersion('node_version', {});
  assert.equal(result.success, true);
  assert.equal(result.contentItems[0]?.text, process.version);
});
