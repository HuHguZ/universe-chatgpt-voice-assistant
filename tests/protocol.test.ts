import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, ToolCalls } from '../src/protocol.ts';

test('accepts PCM16 audio and rejects malformed, excessive or inconsistent frames', () => {
  const frame = { type: 'input.audio', data: Buffer.alloc(1920).toString('base64'), sampleRate: 48000, numChannels: 1 };
  assert.equal(parseInput(JSON.stringify(frame)).type, 'input.audio');
  for (const invalid of [{ ...frame, data: '???' }, { ...frame, sampleRate: 1 }, { ...frame, numChannels: 0 }, { ...frame, data: 'AA==' }, { ...frame, data: Buffer.alloc(100000).toString('base64') }]) {
    assert.throws(() => parseInput(JSON.stringify(invalid)), /audio/);
  }
  assert.throws(() => parseInput('x'.repeat(262145)), /large/);
  assert.throws(() => parseInput('{'), /JSON/);
  assert.throws(() => parseInput('{"type":"unknown"}'), /Unknown/);
});

test('validates registered tools and text at the API boundary', () => {
  assert.equal(parseInput('{"type":"session.start","voice":false}').type, 'session.start');
  assert.throws(() => parseInput(JSON.stringify({ type: 'input.text', text: '' })), /text/);
  assert.throws(() => parseInput(JSON.stringify({ type: 'session.start', tools: [{ name: '../shell' }] })), /tool/);
  const tool = { name: 'hello', description: 'Hello', inputSchema: { type: 'object' } };
  assert.throws(() => parseInput(JSON.stringify({ type: 'session.start', tools: [tool, tool] })), /Duplicate/);
});

test('deduplicates in-flight actions and rejects conflicting reuse of a call id', async () => {
  const tools = new ToolCalls();
  let executed = 0;
  const run = async () => { executed++; return { success: true, contentItems: [{ type: 'inputText' as const, text: 'done' }] }; };
  const first = tools.run('call-1', 'example', {}, run);
  const repeated = tools.run('call-1', 'example', {}, run);
  assert.deepEqual(await first, await repeated);
  assert.equal(executed, 1);
  await assert.rejects(tools.run('call-1', 'example', { different: true }, run), /Conflicting/);
});
