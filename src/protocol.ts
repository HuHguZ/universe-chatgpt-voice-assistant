import type { AudioChunk } from './voice-transport.ts';

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolResult = { success: boolean; contentItems: { type: 'inputText'; text: string }[] };
export type Input =
  | { type: 'session.start'; voice?: boolean; tools?: ToolSpec[] }
  | { type: 'input.text'; text: string }
  | ({ type: 'input.audio' } & AudioChunk)
  | { type: 'session.interrupt' | 'session.close' }
  | { type: 'tool.result'; callId: string; result: ToolResult };

export function parseInput(raw: string): Input {
  if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('Message too large');
  let message: any;
  try { message = JSON.parse(raw); } catch { throw new Error('Invalid JSON'); }
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
  switch (message.type) {
    case 'session.start': {
      if (message.voice !== undefined && typeof message.voice !== 'boolean') throw new Error('Invalid voice setting');
      if (message.tools !== undefined && (!Array.isArray(message.tools) || message.tools.length > 16)) throw new Error('Invalid tools');
      const names = new Set(['system_time']);
      for (const tool of message.tools ?? []) {
        if (!tool || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || typeof tool.description !== 'string' || tool.description.length > 2000 || !tool.inputSchema || tool.inputSchema.type !== 'object') throw new Error('Invalid tool definition');
        if (names.has(tool.name)) throw new Error('Duplicate tool name');
        names.add(tool.name);
      }
      break;
    }
    case 'input.text':
      if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 16000) throw new Error('Invalid text');
      break;
    case 'input.audio': {
      if (typeof message.data !== 'string' || !message.data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data) || ![16000, 24000, 48000].includes(message.sampleRate) || ![1, 2].includes(message.numChannels)) throw new Error('Invalid audio format');
      const bytes = Buffer.from(message.data, 'base64').length;
      if (!bytes || bytes % (2 * message.numChannels) || bytes > message.sampleRate * message.numChannels * 2 / 10) throw new Error('Invalid audio frame size (maximum 100 ms)');
      break;
    }
    case 'tool.result':
      if (typeof message.callId !== 'string' || message.callId.length > 200 || !message.result || typeof message.result.success !== 'boolean' || !Array.isArray(message.result.contentItems) || message.result.contentItems.length > 8 || message.result.contentItems.some((item: any) => item?.type !== 'inputText' || typeof item.text !== 'string' || item.text.length > 16000)) throw new Error('Invalid tool result');
      break;
    case 'session.interrupt': case 'session.close': break;
    default: throw new Error('Unknown message type');
  }
  return message as Input;
}

export class ToolCalls {
  private calls = new Map<string, { fingerprint: string; result: Promise<ToolResult> }>();

  async run(callId: string, name: string, args: unknown, execute: () => Promise<ToolResult>): Promise<ToolResult> {
    const fingerprint = JSON.stringify([name, args]);
    const previous = this.calls.get(callId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Conflicting tool call id');
      return previous.result;
    }
    if (this.calls.size >= 128) throw new Error('Tool call limit reached for this session');
    const result = Promise.resolve().then(execute);
    this.calls.set(callId, { fingerprint, result });
    return result;
  }
}
