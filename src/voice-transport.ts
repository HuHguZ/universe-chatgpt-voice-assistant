import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

export type AudioChunk = { data: string; sampleRate: number; numChannels: number };

export class VoiceTransport extends EventEmitter {
  private browser!: Browser;
  private page!: Page;

  static async create(): Promise<VoiceTransport> {
    const transport = new VoiceTransport();
    const origin = createServer((_request, response) => response.end('<!doctype html><title>Universe audio transport</title>'));
    await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
    try {
      transport.browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
      transport.page = await transport.browser.newPage();
      await transport.page.exposeFunction('sonoraAudio', (audio: AudioChunk) => transport.emit('audio', audio));
      await transport.page.goto(`http://127.0.0.1:${(origin.address() as AddressInfo).port}`);
      await transport.page.evaluate(async () => {
        const context = new AudioContext({ sampleRate: 48000 });
        await context.audioWorklet.addModule(URL.createObjectURL(new Blob([`
          class Capture extends AudioWorkletProcessor {
            constructor(){super();this.block=new Int16Array(960);this.at=0;}
            process(inputs){const input=inputs[0];if(input?.[0])for(let i=0;i<input[0].length;i++){
              let x=0;for(const channel of input)x+=channel[i]/input.length;
              this.block[this.at++]=Math.max(-32768,Math.min(32767,Math.round(x*32767)));
              if(this.at===960){this.port.postMessage(this.block.buffer);this.block=new Int16Array(960);this.at=0;}
            }return true;}
          } registerProcessor('sonora-capture',Capture);
        `], { type: 'text/javascript' })));
        const destination = context.createMediaStreamDestination();
        const keepAlive = context.createOscillator();
        const quietInput = context.createGain(); quietInput.gain.value = 0;
        keepAlive.connect(quietInput).connect(destination); keepAlive.start();
        const pc = new RTCPeerConnection();
        pc.addTrack(destination.stream.getAudioTracks()[0]!, destination.stream);
        const dc = pc.createDataChannel('oai-events', { negotiated: true, id: 0 });
        const eventTypes: Record<string, number> = {};
        dc.onmessage = event => {
          try {
            let message = JSON.parse(event.data);
            if (message.type === 'data_message') message = JSON.parse(message.data);
            const type = String(message.type ?? 'unknown');
            eventTypes[type] = (eventTypes[type] ?? 0) + 1;
          } catch { /* Ignore non-JSON telemetry. */ }
        };
        const capture = new AudioWorkletNode(context, 'sonora-capture');
        capture.port.onmessage = event => {
          const bytes = new Uint8Array(event.data);
          let encoded = ''; for (const byte of bytes) encoded += String.fromCharCode(byte);
          (window as any).sonoraAudio({ data: btoa(encoded), sampleRate: 48000, numChannels: 1 });
        };
        capture.connect(context.destination); // The worklet emits silence while recording its input.
        const remoteTracks: MediaStreamTrack[] = [];
        pc.ontrack = event => {
          remoteTracks.push(event.track);
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          const element = document.createElement('audio'); element.autoplay = true; element.srcObject = stream;
          document.body.append(element); void element.play();
          context.createMediaStreamSource(stream).connect(capture);
        };
        await context.resume();
        (window as any).sonora = { context, destination, pc, dc, eventTypes, remoteTracks, next: 0, inputFrames: 0, gapSeconds: 0, inputEnergy: 0 };
      });
      return transport;
    } catch (error) { await transport.close(); throw error; }
    finally { origin.close(); }
  }

  async offer(): Promise<string> {
    return this.page.evaluate(async () => {
      const { pc } = (window as any).sonora;
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceGatheringState !== 'complete') await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 2000);
        pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
      });
      return pc.localDescription.sdp;
    });
  }

  async answer(sdp: string): Promise<void> {
    await this.page.evaluate(sdp => (window as any).sonora.pc.setRemoteDescription({ type: 'answer', sdp }), sdp);
  }

  async ready(): Promise<void> {
    await this.page.waitForFunction(() => (window as any).sonora.dc.readyState === 'open', undefined, { timeout: 20_000 });
  }

  async input(audio: AudioChunk): Promise<void> {
    await this.page.evaluate(audio => {
      const state = (window as any).sonora;
      const raw = atob(audio.data);
      const samples = new DataView(Uint8Array.from(raw, c => c.charCodeAt(0)).buffer);
      const frames = raw.length / (2 * audio.numChannels);
      const buffer = state.context.createBuffer(1, frames, audio.sampleRate);
      const output = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) {
        let sample = 0;
        for (let channel = 0; channel < audio.numChannels; channel++) sample += samples.getInt16((i * audio.numChannels + channel) * 2, true) / (32768 * audio.numChannels);
        output[i] = sample;
        state.inputEnergy += sample * sample / audio.sampleRate;
      }
      const now = state.context.currentTime;
      state.inputFrames += frames;
      if (state.next && state.next < now) state.gapSeconds += now - state.next;
      state.next = Math.max(now + 0.03, state.next);
      if (state.next + buffer.duration > now + 2) throw new Error('Voice audio queue is full');
      const source = state.context.createBufferSource(); source.buffer = buffer; source.connect(state.destination);
      source.onended = () => source.disconnect();
      source.start(state.next); state.next += buffer.duration;
    }, audio);
  }

  async close(): Promise<void> { await this.browser?.close(); }

  async diagnostics(): Promise<unknown> {
    return this.page.evaluate(async () => {
      const { pc, dc, eventTypes, context, remoteTracks, inputFrames, gapSeconds, inputEnergy } = (window as any).sonora;
      const media: unknown[] = [];
      (await pc.getStats()).forEach((stat: any) => {
        if (['inbound-rtp', 'outbound-rtp', 'data-channel', 'media-source'].includes(stat.type)) media.push({ type: stat.type, bytesReceived: stat.bytesReceived, bytesSent: stat.bytesSent, packetsReceived: stat.packetsReceived, packetsSent: stat.packetsSent, messagesReceived: stat.messagesReceived, messagesSent: stat.messagesSent, totalAudioEnergy: stat.totalAudioEnergy, totalSamplesReceived: stat.totalSamplesReceived, totalSamplesDuration: stat.totalSamplesDuration, audioLevel: stat.audioLevel });
      });
      return { peerState: pc.connectionState, channelState: dc.readyState, audioContext: context.state, tracks: remoteTracks.map((track: MediaStreamTrack) => ({ muted: track.muted, enabled: track.enabled, state: track.readyState })), inputFrames, gapSeconds, inputEnergy, eventTypes, media };
    });
  }
}
