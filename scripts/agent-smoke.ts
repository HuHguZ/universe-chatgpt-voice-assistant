import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { totalmem } from 'node:os';
import { readFile, unlink } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createSonoraServer } from '../src/server.ts';
import { SonoraSession } from '../src/session.ts';
import { startCodex } from '../src/codex.ts';

const backend: Record<string, number> = {};
const app = createSonoraServer({ sessionFactory: send => new SonoraSession(send, { startCodex: async () => {
  const rpc = await startCodex();
  rpc.on('notification', message => {
    backend[message.method!] = (backend[message.method!] ?? 0) + 1;
    if (message.method === 'item/completed' && message.params.item?.type === 'commandExecution') {
      const item = message.params.item;
      const output = item.aggregatedOutput ?? '';
      console.log(JSON.stringify({ nativeCommand: true, status: item.status, exitCode: item.exitCode, workspace: item.cwd === process.cwd(), sandboxError: /sandbox/i.test(output), denied: /denied|отказан|Unauthorized/i.test(output), invalidPath: /not find|not found|не удается найти/i.test(output) }));
    }
  });
  rpc.on('request', message => { console.log(JSON.stringify({ requestMethod: message.method })); });
  return rpc;
} }) });
app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
const ws = new WebSocket(`ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/session`);
const marker = `universe-agent-${randomUUID()}`;
const file = `runtime/${marker}.txt`;
let text = '';
let commands = 0;
try {
  await once(ws, 'open');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native agent smoke timed out')), 90000);
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'session.started') ws.send(JSON.stringify({ type: 'input.text', text: `Проверь реальную общую и свободную оперативную память этого компьютера с помощью штатного shell-инструмента. Нужна память всей системы, не процесса Node. Затем создай только файл ${file} с точным содержимым ${marker}. В конце верни JSON {"totalBytes": число, "freeBytes": число}, без markdown. Выполни действия реально, не имитируй и не отказывайся без попытки использовать инструменты.` }));
      if (event.type === 'task.progress') text += event.delta;
      if (event.type === 'tool.completed' && event.name === 'shell' && event.success) commands++;
      if (event.type === 'error') { clearTimeout(timer); reject(new Error(event.message)); }
      if (event.type === 'task.completed') { clearTimeout(timer); event.status === 'completed' ? resolve() : reject(new Error('Agent task failed')); }
    });
    ws.send(JSON.stringify({ type: 'session.start', voice: false }));
  });
  assert.ok(commands >= 1, 'No native command actually completed');
  const json = text.match(/\{[^{}]*"totalBytes"[^{}]*\}/g)?.at(-1);
  assert.ok(json, 'Missing actual memory result');
  const memory = JSON.parse(json);
  assert.ok(Number.isFinite(memory.totalBytes) && Math.abs(memory.totalBytes - totalmem()) < totalmem() * 0.05, 'Memory did not match the actual host');
  assert.ok(memory.freeBytes > 0 && memory.freeBytes <= memory.totalBytes);
  assert.equal((await readFile(file, 'utf8')).trim(), marker, 'Native agent did not actually write its file');
  console.log(JSON.stringify({ nativeCommands: commands, realRamGiB: Math.round(memory.totalBytes / 1024 ** 3), actualFileWrite: true }));
} finally {
  console.log(JSON.stringify({ backendEvents: backend }));
  ws.terminate(); await app.close(); await unlink(file).catch(() => {});
}
