import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import type { AudioChunk } from '../voice-transport.ts';
import { pcmToMono } from './pcm.ts';

export type MatrixAudioOptions = { homeserver: string; userId: string; deviceId: string; accessToken: string; roomId: string; callerUserId?: string };
export type MatrixAudioStatus = { connected: boolean; encrypted: boolean; remoteEncrypted: boolean; memberships: number; keyParticipants: number; keyUpdates: number; localKeyIndex: number; failed: boolean; sticky: number; keysSent: number; keysReceived: number };

const captureSource = `
class Capture extends AudioWorkletProcessor {
  constructor(){super();this.block=new Int16Array(960);this.at=0;}
  process(inputs){const input=inputs[0];if(input?.[0])for(let i=0;i<input[0].length;i++){
    let sample=0;for(const channel of input)sample+=channel[i]/input.length;
    this.block[this.at++]=Math.max(-32768,Math.min(32767,Math.round(sample*32768)));
    if(this.at===960){this.port.postMessage(this.block.buffer);this.block=new Int16Array(960);this.at=0;}
  }return true;}
}registerProcessor('sonora-matrix-capture',Capture);`;

export async function matrixAssets(): Promise<Map<string, [string, string | Uint8Array]>> {
  const require = createRequire(import.meta.url);
  // shortcut: run from the project root; package browser assets before distributing a standalone binary.
  const bundle = await build({ entryPoints: [resolve('src/matrix/browser.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023', logLevel: 'silent' });
  return new Map([
    ['/', ['text/html', '<!doctype html><title>Sonora audio</title><script type="module" src="/browser.js"></script>']],
    ['/browser.js', ['text/javascript', bundle.outputFiles[0]!.contents]],
    ['/e2ee-worker.js', ['text/javascript', await readFile(require.resolve('livekit-client/e2ee-worker'))]],
    ['/pkg/matrix_sdk_crypto_wasm_bg.wasm', ['application/wasm', await readFile(resolve(require.resolve('@matrix-org/matrix-sdk-crypto-wasm'), '../pkg/matrix_sdk_crypto_wasm_bg.wasm'))]],
    ['/capture.js', ['text/javascript', captureSource]],
  ]);
}

export class MatrixAudioTransport extends EventEmitter {
  private browser?: Browser;
  private page?: Page;
  private server?: Server;
  private closed = false;

  static async create(options: MatrixAudioOptions, onCryptoReady: () => Promise<void> = async () => {}, idle = false): Promise<MatrixAudioTransport> {
    if (Object.values(options).some(value => typeof value !== 'string' || !value)) throw new Error('Matrix credentials and room are required');
    const homeserver = new URL(options.homeserver);
    if (!['http:', 'https:'].includes(homeserver.protocol) || homeserver.username || homeserver.password) throw new Error('Invalid Matrix homeserver');
    const transport = new MatrixAudioTransport();
    try {
      const assets = await matrixAssets();
      transport.server = createServer((request, response) => {
        const asset = assets.get(request.url ?? '');
        response.writeHead(asset ? 200 : 404, { 'content-type': asset?.[0] ?? 'text/plain', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        response.end(asset?.[1] ?? 'Not found');
      });
      await new Promise<void>((resolve, reject) => { transport.server!.once('error', reject); transport.server!.listen(0, '127.0.0.1', resolve); });
      transport.browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
      transport.page = await transport.browser.newPage();
      await transport.page.exposeFunction('sonoraMatrixAudio', (audio: AudioChunk) => transport.emit('audio', audio));
      await transport.page.exposeFunction('sonoraMatrixError', (message: string) => transport.emit('transportError', new Error(message)));
      await transport.page.exposeFunction('sonoraMatrixReady', onCryptoReady);
      await transport.page.exposeFunction('sonoraMatrixMemberships', (remoteMembers: number) => transport.emit('memberships', remoteMembers));
      await transport.page.goto(`http://127.0.0.1:${(transport.server.address() as AddressInfo).port}`);
      await transport.page.waitForFunction(() => !!(window as any).sonoraMatrix);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          transport.page.evaluate(({ options, idle }) => (window as any).sonoraMatrix.start(options, idle), { options, idle }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Matrix audio initialization timed out')), 30_000); }),
        ]);
      } finally { clearTimeout(timer); }
      return transport;
    } catch (error) { await transport.close(); throw error; }
  }

  async join(): Promise<void> {
    if (this.closed || !this.page) throw new Error('Matrix audio is closed');
    await this.page.evaluate(() => (window as any).sonoraMatrix.join());
  }

  async leave(): Promise<void> { if (!this.closed) await this.page?.evaluate(() => (window as any).sonoraMatrix.leave()); }

  async input(audio: AudioChunk): Promise<void> {
    pcmToMono(audio);
    if (this.closed || !this.page) throw new Error('Matrix audio is closed');
    await this.page.evaluate(audio => (window as any).sonoraMatrix.input(audio), audio);
  }

  async interrupt(): Promise<void> { if (!this.closed) await this.page?.evaluate(() => (window as any).sonoraMatrix.interrupt()); }
  async status(): Promise<MatrixAudioStatus> {
    if (this.closed || !this.page) throw new Error('Matrix audio is closed');
    return this.page.evaluate(() => (window as any).sonoraMatrix.status());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.page?.evaluate(() => (window as any).sonoraMatrix?.close()).catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); }
    finally { clearTimeout(timer); await this.browser?.close(); await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve()); }
  }
}
