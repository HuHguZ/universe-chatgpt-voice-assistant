import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolSpec, ToolResult } from '../src/protocol.ts';

export const nodeVersionTool: ToolSpec = { name: 'node_version', description: 'Execute the installed Node.js --version command on this computer and return its actual version. Takes no arguments.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };

export async function runNodeVersion(name: string, args: unknown): Promise<ToolResult> {
  assert.equal(name, nodeVersionTool.name);
  assert.deepEqual(args, {});
  const { stdout } = await promisify(execFile)(process.execPath, ['--version'], { windowsHide: true, timeout: 5000 });
  assert.match(stdout.trim(), /^v\d+\.\d+\.\d+$/);
  return { success: true, contentItems: [{ type: 'inputText', text: stdout.trim() }] };
}
