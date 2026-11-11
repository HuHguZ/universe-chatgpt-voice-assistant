import type { ToolSpec, ToolResult } from './protocol.ts';

export const endCallTool: ToolSpec = {
  name: 'end_call',
  description: 'Leave the current voice call when the user explicitly asks to end, hang up or leave it. Keep the assistant service online for future calls. No arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export function acceptEndCall(args: unknown): ToolResult {
  const success = !!args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0;
  return { success, contentItems: [{ type: 'inputText', text: success ? 'The current call is ending now.' : 'end_call takes no arguments' }] };
}
