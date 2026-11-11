import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { MatrixAudioTransport } from './transport.ts';
import type { MatrixAudioStatus } from './transport.ts';
import type { AudioChunk } from '../voice-transport.ts';
import { setRobotProfile } from './profile.ts';
import { endCallTool, acceptEndCall } from '../call-control.ts';

type AudioTransport = EventEmitter & { join(): Promise<void>; leave(): Promise<void>; input(audio: AudioChunk): Promise<void>; interrupt(): Promise<void>; status(): Promise<MatrixAudioStatus> };

/** One warm Matrix device; only an active encrypted call owns a universal API session. */
export class NativeMatrixCall {
  phase = 'idle';
  sessionsStarted = 0;
  remoteMembers = 0;
  private closed = false;
  private queue = Promise.resolve();
  private output = Promise.resolve();
  private ws?: WebSocket;
  private generation = 0;
  private audioGeneration = 0;
  private endedByRequest = false;
  private endCalls = new Set<string>();
  private matrix: AudioTransport;
  private apiUrl: string;

  constructor(matrix: AudioTransport, apiUrl: string) {
    const url = new URL(apiUrl);
    if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/session' || url.username || url.password) throw new Error('A loopback universal session API is required');
    this.matrix = matrix; this.apiUrl = apiUrl;
    matrix.on('memberships', this.memberships);
    matrix.on('audio', this.audio);
    matrix.on('transportError', this.fail);
  }

  private readonly audio = (audio: AudioChunk) => {
    if (this.phase !== 'ready' || this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 1024 * 1024) { this.fail(); return; }
    this.ws.send(JSON.stringify({ type: 'input.audio', ...audio }));
  };

  private readonly memberships = (remoteMembers: number) => {
    if (this.closed || remoteMembers === this.remoteMembers) return;
    this.remoteMembers = remoteMembers;
    if (!remoteMembers) { this.endedByRequest = false; this.endCalls.clear(); this.generation++; this.ws?.terminate(); }
    this.queue = this.queue.then(() => this.reconcile(remoteMembers === 0)).catch(() => this.fail());
  };

  private readonly fail = () => {
    if (this.closed) return;
    this.generation++; this.endCalls.clear(); this.ws?.terminate(); this.ws = undefined;
    this.phase = 'error';
    void this.matrix.leave().catch(() => {});
  };

  private async reconcile(leaving = false, deadline = Date.now() + 45_000): Promise<void> {
    if (leaving || !this.remoteMembers || this.closed) {
      this.endCalls.clear();
      this.ws?.terminate(); this.ws = undefined;
      await this.matrix.leave();
      if (!this.closed) this.phase = 'idle';
      return;
    }
    // A caller may stay connected after asking the bot to leave. Wait for a fresh call.
    if (this.endedByRequest) return;
    if (this.phase === 'joining' || this.phase === 'voice' || this.phase === 'ready') return;
    const generation = ++this.generation;
    const current = () => !this.closed && this.remoteMembers > 0 && generation === this.generation;
    // Stay absent from the call until the backend can accept the caller's first words.
    this.phase = 'voice';
    const ws = this.ws = new WebSocket(this.apiUrl);
    const ready = Promise.withResolvers<void>();
    let busy = false;
    const timer = setTimeout(() => ready.reject(new Error('Universal voice startup timed out')), Math.max(1, deadline - Date.now()));
    ws.on('unexpected-response', (_request, response) => {
      busy = response.statusCode === 409;
      response.resume(); ready.reject(new Error('Universal API refused the connection')); ws.terminate();
    });
    ws.on('error', () => { ready.reject(new Error('Universal API unavailable')); if (current() && !busy) this.fail(); });
    ws.on('close', () => { ready.reject(new Error('Universal session closed')); if (current() && !busy) this.fail(); });
    ws.on('message', raw => {
      if (!current()) return;
      let event: any;
      try { event = JSON.parse(raw.toString()); } catch { this.fail(); return; }
      if (event.type === 'session.started') { this.sessionsStarted++; ready.resolve(); }
      if (event.type === 'error' || event.type === 'session.closed') { ready.reject(new Error('Universal voice failed')); this.fail(); }
      if (event.type === 'output.audio' && this.phase === 'ready') {
        const audioGeneration = this.audioGeneration;
        this.output = this.output.then(() => current() && audioGeneration === this.audioGeneration ? this.matrix.input(event) : undefined).catch(() => this.fail());
      }
      if (event.type === 'output.reset' && this.phase === 'ready') {
        this.audioGeneration++;
        this.output = this.output.then(() => current() ? this.matrix.interrupt() : undefined).catch(() => this.fail());
      }
      if (event.type === 'tool.call' && event.name === endCallTool.name) {
        const result = acceptEndCall(event.arguments);
        if (result.success) this.endCalls.add(event.callId);
        ws.send(JSON.stringify({ type: 'tool.result', callId: event.callId, result }));
      }
      if (event.type === 'tool.completed' && event.name === endCallTool.name && event.success && this.endCalls.has(event.callId)) {
        this.endedByRequest = true; this.endCalls.clear();
        this.generation++; this.audioGeneration++; this.phase = 'leaving';
        ws.close(); this.ws = undefined;
        this.queue = this.queue.then(() => this.reconcile(true)).catch(() => this.fail());
      }
      // Native Codex tools execute behind the universal API; this adapter does not run commands.
    });
    ws.once('open', () => { if (current()) ws.send(JSON.stringify({ type: 'session.start', voice: true, tools: [endCallTool] })); else ws.terminate(); });
    try { await ready.promise; }
    catch (error) {
      // RTC can redial before the previous backend has released its single session slot.
      if (!busy || Date.now() >= deadline) throw error;
      await delay(100);
      if (!current()) return;
      this.phase = 'idle';
      return this.reconcile(false, deadline);
    } finally { clearTimeout(timer); }
    if (!current()) return;
    this.phase = 'joining';
    await this.matrix.join();
    for (let n = 0;; n++) {
      if (!current()) { await this.matrix.leave(); return; }
      const status = await this.matrix.status();
      if (status.failed) throw new Error('Encrypted Matrix call failed');
      // A muted caller need not publish a track. Incoming published tracks are separately required to be E2EE.
      if (status.connected && status.encrypted && status.keyParticipants >= 2 && status.memberships >= 2) break;
      if (n >= 150) throw new Error('Encrypted Matrix call timed out');
      await delay(100);
    }
    this.phase = 'ready';
  }

  async settled(): Promise<void> { await this.queue; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.generation++; this.ws?.terminate();
    this.matrix.off('memberships', this.memberships); this.matrix.off('audio', this.audio); this.matrix.off('transportError', this.fail);
    await this.queue; await this.output; await this.matrix.leave(); this.phase = 'closed';
  }
}

export async function createNativeMatrixServer(apiUrl = 'ws://127.0.0.1:18793/session') {
  const { createLabUser, createLabRoom, matrixRequest, MATRIX_URL } = await import(pathToFileURL(resolve('infra/lab.mjs')).href);
  const users: any[] = [];
  let matrix: MatrixAudioTransport | undefined;
  let call: NativeMatrixCall | undefined;
  const logout = () => Promise.allSettled(users.map(user => matrixRequest('/_matrix/client/v3/logout/all', { method: 'POST', token: user.accessToken, body: {} })));
  try {
    users.push(await createLabUser(undefined, 'Universe'));
    users.push(await createLabUser(undefined, 'Вы'));
    await setRobotProfile(MATRIX_URL, users[0]);
    const roomId = await createLabRoom(users[0], users[1]);
    const roomPath = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`;
    const power = await matrixRequest(`${roomPath}/m.room.power_levels/`, { token: users[0].accessToken });
    power.users[users[1].userId] = 50;
    power.invite = 100; power.kick = 100; power.ban = 100;
    await matrixRequest(`${roomPath}/m.room.power_levels/`, { method: 'PUT', token: users[0].accessToken, body: power });
    await matrixRequest(`${roomPath}/m.room.name/`, { method: 'PUT', token: users[0].accessToken, body: { name: 'Universe' } });
    await matrixRequest(`/_matrix/client/v3/user/${encodeURIComponent(users[1].userId)}/account_data/m.direct`, { method: 'PUT', token: users[1].accessToken, body: { [users[0].userId]: [roomId] } });
    await matrixRequest(`${roomPath}/org.matrix.msc4143.rtc.slot/${encodeURIComponent('m.call#ROOM')}`, { method: 'PUT', token: users[0].accessToken, body: { status: 'open', application: { type: 'm.call' }, encryption: { type: 'org.matrix.msc4143.per_member' } } });
    matrix = await MatrixAudioTransport.create({ homeserver: MATRIX_URL, ...users[0], roomId, callerUserId: users[1].userId }, undefined, true);
    call = new NativeMatrixCall(matrix, apiUrl);
    const elementUrl = `http://127.0.0.1:18081/#/room/${encodeURIComponent(roomId)}`;
    const server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Referrer-Policy', 'no-referrer');
      const port = (server.address() as AddressInfo).port;
      const userNavigation = request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document' && request.headers['sec-fetch-user'] === '?1';
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host ?? '') || (request.headers['sec-fetch-site'] === 'cross-site' && !userNavigation)) { response.writeHead(403).end(); return; }
      try {
        if (request.method === 'GET' && (request.url === '/' || request.url === '/matrix')) {
          const login = await matrixRequest('/_matrix/client/v1/login/get_token', { method: 'POST', token: users[1].accessToken, body: {} });
          if (typeof login.login_token !== 'string') throw new Error('Matrix login unavailable');
          const target = new URL('http://127.0.0.1:18081/universe-login.html'); target.hash = new URLSearchParams({ token: login.login_token, room: roomId }).toString();
          response.writeHead(302, { Location: target.href }).end(); return;
        }
        if (request.method === 'GET' && request.url === '/status') {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ phase: call!.phase, remoteMembers: call!.remoteMembers, sessionsStarted: call!.sessionsStarted, matrix: await matrix!.status(), elementUrl })); return;
        }
        response.writeHead(404).end();
      } catch { response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"Matrix is unavailable"}'); }
    });
    return { server, call, elementUrl, async close() { await call!.close(); await matrix!.close(); await logout(); await new Promise<void>(resolve => server.close(() => resolve())); } };
  } catch (error) { await call?.close(); await matrix?.close(); await logout(); throw error; }
}
