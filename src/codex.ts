import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message: string } };

export class JsonRpcProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = '';
  private stopped = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private timeoutMs: number;

  constructor(command: string, args: string[], options: SpawnOptionsWithoutStdio & { timeoutMs?: number } = {}) {
    super();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    this.child.stderr.resume(); // Upstream stderr may contain private task context.
    this.child.on('error', error => this.finish(new Error(`Codex failed to start: ${error.message}`)));
    this.child.on('exit', () => this.finish(new Error('Codex process closed')));
    this.child.stdin.on('error', () => this.finish(new Error('Codex input closed')));
  }

  request<T = any>(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Codex process closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  send(message: RpcMessage): void {
    if (this.stopped) throw new Error('Codex process closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  close(): void {
    if (this.stopped) return;
    this.finish(new Error('Codex process closed'));
    this.child.stdin.end();
    this.child.kill();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) { this.close(); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: RpcMessage;
      try { message = JSON.parse(line); }
      catch { this.close(); return; }
      if (!message || typeof message !== 'object') { this.close(); return; }
      if (message.method) this.emit(message.id === undefined ? 'notification' : 'request', message);
      else if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    }
  }

  private finish(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('closed', error);
  }
}

export function codexExecutable(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (process.platform !== 'win32') return 'codex';
  const shim = execFileSync('where.exe', ['codex.cmd'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]!;
  const root = join(dirname(shim), 'node_modules', '@openai', 'codex');
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const require = createRequire(join(root, 'package.json'));
  let vendor = join(root, 'vendor');
  try { vendor = join(dirname(require.resolve(`@openai/codex-win32-${process.arch}/package.json`)), 'vendor'); }
  catch { /* Older Codex packages embed vendor binaries. */ }
  const binary = join(vendor, target, 'bin', 'codex.exe');
  if (!existsSync(binary)) throw new Error('Cannot locate Codex executable; set CODEX_BIN to its executable path');
  return binary;
}

export async function startCodex(): Promise<JsonRpcProcess> {
  const rpc = new JsonRpcProcess(codexExecutable(), ['app-server', '--enable', 'realtime_conversation', '-c', 'mcp_servers={}', '-c', 'features.plugins=false', '-c', 'features.apps=false']);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'universe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized', params: {} });
    return rpc;
  } catch (error) { rpc.close(); throw error; }
}

export async function isolatedToolsConfig(rpc: JsonRpcProcess): Promise<Record<string, unknown>> {
  const { config } = await rpc.request('config/read', { includeLayers: false });
  return { mcp_servers: Object.fromEntries(Object.keys(config.mcp_servers ?? {}).map(name => [name, { enabled: false }])) };
}
