import { createClient, ClientEvent, SyncState, EventType } from 'matrix-js-sdk';
import { MatrixRTCSessionEvent } from 'matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js';
import { BaseKeyProvider, createKeyMaterialFromBuffer, Room, RoomEvent, Track, LocalAudioTrack } from 'livekit-client';
import type { Logger } from 'matrix-js-sdk/lib/logger.js';
import type { AudioChunk } from '../voice-transport.ts';
import type { MatrixAudioOptions } from './transport.ts';
import { pcmToMono } from './pcm.ts';

// SDK HTTP diagnostics can include credentials. Only counts/status leave this browser.
const quiet: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild() { return quiet; } };

class ParticipantKeys extends BaseKeyProvider {
  constructor() { super({ sharedKey: false, ratchetWindowSize: 10, keyringSize: 256 }); }
  async set(key: Uint8Array<ArrayBuffer>, index: number, identity: string): Promise<void> {
    this.onSetEncryptionKey(await createKeyMaterialFromBuffer(key.slice().buffer), identity, index);
  }
}

(window as any).sonoraMatrix = {
  async start(options: MatrixAudioOptions, idle = false) {
    let stage = 'crypto';
    const client = createClient({ baseUrl: options.homeserver, userId: options.userId, deviceId: options.deviceId, accessToken: options.accessToken, logger: quiet });
    const context = new AudioContext({ sampleRate: 48000 });
    const keys = new ParticipantKeys();
    const worker = new Worker('/e2ee-worker.js', { type: 'module' });
    const livekit = new Room({ e2ee: { keyProvider: keys, worker }, adaptiveStream: false, dynacast: false });
    const state = { client, context, keys, livekit, worker, options, published: null as any, joined: false, closed: false, finishInitialSync: () => {}, microphone: undefined as MediaStream | undefined, session: null as any, destination: context.createMediaStreamDestination(), next: 0, sources: new Set<AudioBufferSourceNode>(), keyParticipants: new Set<string>(), keyUpdates: 0, localKeyIndex: -1, failure: false };
    const ensureOpen = () => { if (state.closed) throw new Error('Call closed'); };
    (window as any).sonoraMatrix.state = state;
    try {
      // The native adapter keeps this crypto client synced while idle, before callers send encrypted memberships.
      await client.initRustCrypto({ useIndexedDB: false });
      ensureOpen();
      stage = 'initial sync';
      const synced = new Promise<void>((resolve, reject) => {
        state.finishInitialSync = resolve;
        client.on(ClientEvent.Sync, sync => {
          if (sync === SyncState.Prepared) resolve();
          if (sync === SyncState.Error) reject(new Error('sync failed'));
        });
      });
      await client.startClient({ initialSyncLimit: 0 });
      await synced;
      ensureOpen();
      await (window as any).sonoraMatrixReady?.();
      ensureOpen();
      stage = 'encrypted room';
      const room = client.getRoom(options.roomId);
      if (!room || !room.hasMembershipState(options.userId, 'join') || !client.getCrypto()?.isEncryptionEnabledInRoom(options.roomId)) throw new Error('encrypted joined room required');
      stage = 'transport discovery';
      const transports = await client._unstable_getRTCTransports();
      const advertised = transports.find(t => t.type === 'livekit' && typeof t.url === 'string');
      if (!advertised || typeof advertised.url !== 'string') throw new Error('MSC4195 transport URL required');
      const published = { type: 'livekit', url: advertised.url, server_name: typeof advertised.server_name === 'string' ? advertised.server_name : options.userId.slice(options.userId.indexOf(':') + 1) };
      state.published = published;
      stage = 'session';
      const session = client.matrixRTC.getRoomSession(room); state.session = session;
      await session.initialMembershipCalculated;
      if (!await client.doesServerSupportUnstableFeature('org.matrix.msc4354')) throw new Error('sticky memberships required');
      const notifyMemberships = () => {
        const remote = session.memberships.filter(member => member.userId !== options.userId);
        if (options.callerUserId && remote.some(member => member.userId !== options.callerUserId)) {
          state.failure = true; (window as any).sonoraMatrixError('Unexpected Matrix call participant'); return;
        }
        (window as any).sonoraMatrixMemberships?.(remote.length);
      };
      session.on(MatrixRTCSessionEvent.MembershipsChanged, notifyMemberships);
      notifyMemberships();
      session.on(MatrixRTCSessionEvent.EncryptionKeyChanged, (key, index, membership, backendIdentity) => {
        void (async () => {
          await keys.set(key, index, backendIdentity);
          state.keyParticipants.add(backendIdentity); state.keyUpdates++;
          if (membership.userId === options.userId && membership.deviceId === options.deviceId) state.localKeyIndex = index;
        })().catch(() => { state.failure = true; (window as any).sonoraMatrixError('Matrix media key setup failed'); });
      });
      session.on(MatrixRTCSessionEvent.MembershipManagerError, () => { state.failure = true; (window as any).sonoraMatrixError('Matrix call membership failed'); });
      livekit.on(RoomEvent.EncryptionError, error => {
        // Early encrypted packets can precede their Matrix to-device key; LiveKit drops them until it arrives.
        if (error.message.startsWith('MissingKey:')) return;
        state.failure = true; (window as any).sonoraMatrixError('Matrix media encryption failed');
      });
      stage = 'audio capture';
      await context.audioWorklet.addModule('/capture.js');
      const capture = new AudioWorkletNode(context, 'sonora-matrix-capture');
      capture.connect(context.destination);
      capture.port.onmessage = event => {
        let raw = ''; for (const byte of new Uint8Array(event.data)) raw += String.fromCharCode(byte);
        (window as any).sonoraMatrixAudio({ data: btoa(raw), sampleRate: 48000, numChannels: 1 });
      };
      livekit.on(RoomEvent.TrackSubscribed, (track, publication) => {
        if (!publication.isEncrypted) { state.failure = true; (window as any).sonoraMatrixError('Unencrypted Matrix media refused'); return; }
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach(); document.body.append(element); void element.play().catch(() => {});
          context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(capture);
        }
      });
      if (!idle) await (window as any).sonoraMatrix.join();
    } catch {
      throw new Error(`Matrix audio initialization failed at ${stage}`);
    }
  },
  async join() {
    const state = (window as any).sonoraMatrix.state;
    if (state.closed || state.joined) throw new Error('Matrix call is unavailable');
    const { client, context, livekit, session, published, options } = state;
    state.joined = true;
    const ensureOpen = () => { if (state.closed || !state.joined) throw new Error('Call closed'); };
    let stage = 'RTC slot';
    try {
      if (!session.getRtcSlot()) await session.ensureRtcSlotOpen({ encryption: { type: 'org.matrix.msc4143.per_member' } });
      const slot = await client.getStateEvent(options.roomId, EventType.RTCSlot, session.slotId);
      if (slot.encryption?.type !== 'org.matrix.msc4143.per_member') throw new Error('per-member E2EE required');
      const memberId = crypto.randomUUID();
      const identity = { userId: options.userId, deviceId: options.deviceId, memberId };
      stage = 'SFU authorization';
      const token = await client._unstable_getLivekitToken({ ...published, room_id: options.roomId, slot_id: session.slotId, member_id: memberId });
      ensureOpen();
      stage = 'encrypted SFU connection';
      await livekit.setE2EEEnabled(true);
      await livekit.connect(published.url, token.jwt, { autoSubscribe: true });
      ensureOpen();
      await context.resume();
      session.join(identity, [published], { manageMediaKeys: true, unstableSendStickyEvents: true, callIntent: 'audio', callCapabilities: ['m.render_audio'] });
      stage = 'publishing encrypted audio';
      await livekit.localParticipant.publishTrack(new LocalAudioTrack(state.destination.stream.getAudioTracks()[0]!, undefined, true), { source: Track.Source.Microphone, audioPreset: { maxBitrate: 64000 }, dtx: false, red: false });
      if (!livekit.isE2EEEnabled || !livekit.localParticipant.isE2EEEnabled) throw new Error('E2EE was not enabled');
    } catch {
      await (window as any).sonoraMatrix.leave();
      throw new Error(`Matrix call join failed at ${stage}`);
    }
  },
  async leave() {
    const state = (window as any).sonoraMatrix.state;
    if (!state) return;
    state.joined = false;
    state.microphone?.getTracks().forEach((track: MediaStreamTrack) => track.stop());
    for (const source of state.sources ?? []) source.stop();
    state.sources?.clear(); state.next = 0;
    await Promise.allSettled([state.session?.leave(3000), state.livekit.disconnect(false)]);
    state.keyParticipants?.clear(); state.localKeyIndex = -1;
    document.querySelectorAll('audio').forEach(element => element.remove());
  },
  async enableMicrophone() {
    const state = (window as any).sonoraMatrix.state;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (state.closed) { stream.getTracks().forEach(track => track.stop()); throw new Error('Call closed'); }
    state.microphone = stream;
    state.context.createMediaStreamSource(stream).connect(state.destination);
    await state.context.resume();
    await Promise.allSettled(Array.from(document.querySelectorAll('audio')).map(element => element.play()));
  },
  input(audio: AudioChunk) {
    const state = (window as any).sonoraMatrix.state;
    if (state.failure || state.livekit.state !== 'connected') throw new Error('Matrix audio is disconnected');
    const mono = pcmToMono(audio);
    const buffer = state.context.createBuffer(1, mono.length, audio.sampleRate);
    buffer.copyToChannel(mono, 0);
    const now = state.context.currentTime;
    state.next = Math.max(now + 0.03, state.next);
    if (state.next + buffer.duration > now + 2) throw new Error('Matrix audio queue is full');
    const source = state.context.createBufferSource(); source.buffer = buffer; source.connect(state.destination);
    state.sources.add(source); source.onended = () => { state.sources.delete(source); source.disconnect(); };
    source.start(state.next); state.next += buffer.duration;
  },
  interrupt() {
    const state = (window as any).sonoraMatrix.state;
    for (const source of state.sources) source.stop();
    state.sources.clear(); state.next = 0;
  },
  status() {
    const state = (window as any).sonoraMatrix.state;
    // Element may keep a second, unpublished transport connection while migrating RTC auth.
    const remote = (Array.from(state.livekit.remoteParticipants.values()) as any[]).filter(participant => participant.trackPublications.size > 0);
    return { connected: state.livekit.state === 'connected', encrypted: state.livekit.isE2EEEnabled, remoteEncrypted: remote.length > 0 && remote.every(p => p.isEncrypted), memberships: state.session?.memberships.length ?? 0, keyParticipants: state.keyParticipants.size, keyUpdates: state.keyUpdates, localKeyIndex: state.localKeyIndex, failed: state.failure, sticky: state.session ? Array.from(state.session.room._unstable_getStickyEvents()).length : 0, keysSent: state.session?.statistics.counters.roomEventEncryptionKeysSent ?? 0, keysReceived: state.session?.statistics.counters.roomEventEncryptionKeysReceived ?? 0 };
  },
  async close() {
    const state = (window as any).sonoraMatrix.state;
    if (!state) return;
    state.closed = true;
    state.finishInitialSync();
    await (window as any).sonoraMatrix.leave();
    state.worker.terminate();
    state.client.stopClient();
    if (state.context.state !== 'closed') await state.context.close();
  },
};
