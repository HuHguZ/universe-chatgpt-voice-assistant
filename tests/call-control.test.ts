import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptEndCall } from '../src/call-control.ts';

test('end_call accepts only an empty arguments object', () => {
  assert.equal(acceptEndCall({}).success, true);
  for (const args of [undefined, null, [], '', 1, { room: 'another call' }]) assert.equal(acceptEndCall(args).success, false);
});
