import { startCodex, isolatedToolsConfig } from './codex.ts';
import type { JsonRpcProcess, RpcMessage } from './codex.ts';
import { VoiceTransport } from './voice-transport.ts';
import { ToolCalls } from './protocol.ts';
import type { Input, ToolSpec, ToolResult } from './protocol.ts';

export const timeTool: ToolSpec = { name: 'system_time', description: 'Read the actual current time on this computer', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
export const backendPrompt = 'You are Universe, a local Codex agent on this computer. Use system_time for time questions. When the user explicitly asks to finish, hang up or leave the current voice call, use the registered end_call tool if available; keep the assistant service running and never kill host processes to hang up. Prefer registered tools when they cover the requested operation; otherwise use your built-in shell and file tools to inspect the computer and carry out requested actions. For RAM, CPU, installed programs, files and other machine-specific questions, inspect the actual host before answering. Do not claim lack of access without trying the relevant tool. Work within the configured workspace permissions, never read unrelated private files or credentials, and report the actual result briefly in Russian.';
export const voicePrompt = 'You are Universe, a Russian-speaking voice assistant backed by a local Codex agent on this computer. For any question about this computer, including RAM, CPU, disk, files, installed apps, launching programs or commands, and for current facts, delegate the request to the backend Codex agent. It has native shell and file tools, system_time and other registered tools. When the user explicitly asks to finish, hang up or leave the current call, delegate that request to the backend to invoke end_call; saying goodbye alone does not end a call. Speak its confirmed result briefly. Never invent hardware information or say you cannot access the computer before the backend has attempted the request.';
const failedTool = (text: string): ToolResult => ({ success: false, contentItems: [{ type: 'inputText', text }] });

export class SonoraSession {
  private rpc?: JsonRpcProcess;
  private voice?: VoiceTransport;
  private state: 'new' | 'starting' | 'ready' | 'closed' = 'new';
  private closing?: Promise<void>;
  private threadId?: string;
  private turnId?: string;
  private voiceEnabled = false;
  private tools: ToolSpec[] = [];
  private calls = new ToolCalls();
  private waiting = new Map<string, { resolve: (result: ToolResult) => void; timer: NodeJS.Timeout }>();
  private send: (event: Record<string, unknown>) => void;
  private dependencies: { startCodex: typeof startCodex; createVoice: typeof VoiceTransport.create };

  constructor(send: (event: Record<string, unknown>) => void, dependencies: Partial<SonoraSession['dependencies']> = {}) {
    this.send = send;
    this.dependencies = { startCodex, createVoice: () => VoiceTransport.create(), ...dependencies };
  }

  async handle(input: Input): Promise<void> {
    if (input.type === 'session.close') { await this.close(); return; }
    if (input.type === 'session.start') {
      if (this.state !== 'new') throw new Error('Session already started');
      this.state = 'starting';
      try {
        this.rpc = await this.dependencies.startCodex();
        if (this.state as string === 'closed') { this.rpc.close(); throw new Error('Session closed'); }
        this.rpc.on('notification', message => this.notification(message));
        this.rpc.on('request', message => void this.toolRequest(message));
        this.rpc.on('closed', () => this.fail('Codex process closed'));
        const account = await this.rpc.request('account/read', {});
        if (account.account?.type !== 'chatgpt') throw new Error('A ChatGPT subscription login is required; run codex login');
        this.tools = [timeTool, ...(input.tools ?? [])];
        const { thread } = await this.rpc.request('thread/start', {
          cwd: process.cwd(), ephemeral: true, approvalPolicy: 'never',
          config: { ...await isolatedToolsConfig(this.rpc), model_reasoning_effort: 'medium' },
          developerInstructions: backendPrompt,
          dynamicTools: this.tools.map(tool => ({ type: 'function', ...tool })),
        });
        this.threadId = thread.id;
        this.voiceEnabled = input.voice !== false;
        if (this.voiceEnabled) await this.startVoice();
        if (this.state as string === 'closed') throw new Error('Session closed');
        this.state = 'ready';
        this.send({ type: 'session.started', sessionId: this.threadId, voice: this.voiceEnabled });
      } catch (error) { await this.close(); throw error; }
      return;
    }
    if (input.type === 'session.interrupt') {
      // shortcut: explicit interruption ends the session; add resumable cancel after its realtime protocol is verified.
      this.send({ type: 'output.reset' });
      await this.close(); return;
    }
    if (this.state !== 'ready' || !this.rpc || !this.threadId) throw new Error('Session is not ready');
    switch (input.type) {
      case 'input.text':
        if (this.turnId) await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text: input.text }] });
        else await this.rpc.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: input.text }] });
        break;
      case 'input.audio':
        if (!this.voice) throw new Error('Audio is disabled for this session');
        await this.voice.input(input);
        break;
      case 'tool.result': {
        const waiting = this.waiting.get(input.callId);
        if (!waiting) throw new Error('Unknown or completed tool call');
        clearTimeout(waiting.timer); this.waiting.delete(input.callId); waiting.resolve(input.result);
        break;
      }
    }
  }

  private async startVoice(): Promise<void> {
    const voice = await this.dependencies.createVoice();
    if (this.state === 'closed') { await voice.close(); throw new Error('Session closed'); }
    this.voice = voice;
    voice.on('audio', audio => { if (this.state === 'ready' && this.voice === voice) this.send({ type: 'output.audio', ...audio }); });
    await this.rpc!.request('thread/realtime/start', { threadId: this.threadId, outputModality: 'audio', transport: { type: 'webrtc', sdp: await voice.offer() }, version: 'v3', delegationAckFiller: false, prompt: voicePrompt });
    await voice.ready();
  }

  private notification(message: RpcMessage): void {
    if (this.state === 'closed') return;
    const params = message.params ?? {};
    switch (message.method) {
      case 'thread/realtime/sdp': void this.voice?.answer(params.sdp).catch(() => this.fail('WebRTC answer rejected')); break;
      case 'thread/realtime/error': this.fail('Codex voice session failed'); break;
      case 'thread/realtime/closed': this.fail('Codex voice session closed'); break;
      case 'thread/realtime/transcript/delta': this.send({ type: 'transcript', role: params.role, delta: params.delta }); break;
      case 'thread/realtime/transcript/done': this.send({ type: 'transcript', role: params.role, text: params.text, final: true }); break;
      case 'item/agentMessage/delta': this.send({ type: 'task.progress', delta: params.delta }); break;
      case 'item/started':
        if (['commandExecution', 'fileChange'].includes(params.item?.type)) this.send({ type: 'tool.started', callId: params.item.id, name: params.item.type === 'commandExecution' ? 'shell' : 'files' });
        break;
      case 'item/completed':
        if (['commandExecution', 'fileChange'].includes(params.item?.type)) this.send({ type: 'tool.completed', callId: params.item.id, name: params.item.type === 'commandExecution' ? 'shell' : 'files', success: params.item.status === 'completed' && (params.item.type !== 'commandExecution' || params.item.exitCode === 0) });
        break;
      case 'turn/started': this.turnId = params.turn.id; break;
      case 'turn/completed': this.turnId = undefined; this.send({ type: 'task.completed', status: params.turn.status }); break;
    }
  }

  private async toolRequest(message: RpcMessage): Promise<void> {
    if (this.state as string === 'closed') return;
    if (message.method !== 'item/tool/call') { this.rpc?.send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } }); return; }
    const { callId, tool, arguments: args } = message.params;
    try {
      const result = await this.calls.run(callId, tool, args, async () => {
        this.send({ type: 'tool.started', callId, name: tool });
        let result: ToolResult;
        if (tool === 'system_time') {
          if (!args || typeof args !== 'object' || Object.keys(args).length) result = failedTool('system_time takes no arguments');
          else result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ iso: new Date().toISOString(), platform: process.platform }) }] };
        } else if (!this.tools.some(spec => spec.name === tool)) result = failedTool('Tool is not registered');
        else result = await new Promise<ToolResult>(resolve => {
          const timer = setTimeout(() => { this.waiting.delete(callId); resolve(failedTool('Client tool timed out')); }, 30_000);
          this.waiting.set(callId, { resolve, timer });
          this.send({ type: 'tool.call', callId, name: tool, arguments: args });
        });
        if (this.state !== 'closed') this.send({ type: 'tool.completed', callId, name: tool, success: result.success });
        return result;
      });
      if (this.state !== 'closed') this.rpc?.send({ id: message.id, result });
    } catch (error) {
      if (this.state !== 'closed') this.rpc?.send({ id: message.id, result: failedTool(error instanceof Error ? error.message : 'Tool failed') });
    }
  }

  private fail(message: string): void {
    if (this.state === 'closed') return;
    this.send({ type: 'error', message });
    void this.close().catch(() => {});
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = 'closed';
    for (const waiting of this.waiting.values()) { clearTimeout(waiting.timer); waiting.resolve(failedTool('Session closed')); }
    this.waiting.clear();
    this.rpc?.close();
    this.closing = (async () => {
      try { await this.voice?.close(); }
      finally { this.send({ type: 'session.closed' }); }
    })();
    return this.closing;
  }
}
