# Matrix audio adapter

`src/matrix/transport.ts` keeps Matrix and LiveKit outside the Universe session API.
For a real Element private chat and its native Voice call button, see
[the native adapter](matrix-native.md). Its bot stays crypto-warm before a call
and joins/leaves media without discarding the Matrix client between calls.
`setRobotProfile(homeserver, user)` in `src/matrix/profile.ts` separately uploads a
small PNG robot and sets the bot's name to Universe and its Matrix avatar URI. The
media transport does not mutate account profiles. The smoke verifies the uploaded
avatar URI and display name through the real profile endpoint.
Run Node from this repository root: the adapter bundles its browser entry point in
memory with esbuild. Edge runs headless in its own temporary profile on Windows;
Linux needs the Playwright Chromium executable installed. It never requests a
microphone, opens the user's browser profile, or plays the call through speakers.

```ts
import { MatrixAudioTransport } from './src/matrix/transport.ts';

const matrix = await MatrixAudioTransport.create({
  homeserver, userId, deviceId, accessToken, roomId,
});
matrix.on('audio', audio => sendToSonora({ type: 'input.audio', ...audio }));
matrix.on('transportError', error => handleFailure(error));
// Universe output.audio → await matrix.input(audio)
// Universe interruption → await matrix.interrupt()
// Session teardown → await matrix.close()
```

Credentials belong to an already joined bot device and remain in process/browser
memory. `initRustCrypto({ useIndexedDB: false })` deliberately keeps crypto keys
ephemeral. Use a fresh Matrix device per process; restarting with a device that
has lost its private keys is unsupported. The prototype does not recover a
persistent account's crypto store or automate device verification.

The room must have Megolm encryption enabled. The homeserver must support
MSC4354 sticky membership events and MSC4143 transport discovery. Discovery must
advertise a LiveKit `url`; the modern MSC4195 Client-Server `get_token` endpoint
authorizes the joined account. The SDK session supplies `slot_id` (currently
`m.call#ROOM`) and each join gets a fresh `member_id`. A first participant needs
room permission to open the RTC slot. An existing slot must declare
`org.matrix.msc4143.per_member` encryption; an unencrypted slot is rejected.

MatrixRTC distributes per-participant media keys through encrypted to-device
messages using Rust crypto. Its `EncryptionKeyChanged` events populate a LiveKit
`BaseKeyProvider` keyed by the SDK's backend participant identity. The LiveKit
worker encrypts/decrypts media frames; encryption is explicitly enabled before
connecting and publishing. SDK membership changes control media key rotation.
There is no unencrypted fallback or shared fixed passphrase. See the upstream
[MatrixRTC SDK](https://github.com/matrix-org/matrix-js-sdk/tree/develop/src/matrixrtc)
and [Element Call key provider](https://github.com/element-hq/element-call/blob/main/sdk/src/media-backend/livekit/MatrixKeyProvider.ts).

Input is base64 PCM16 little-endian, one or two channels, 8–96 kHz, at most two
seconds per chunk. Stereo is averaged and Web Audio resamples it to the 48 kHz
published track. A two-second playback backlog is rejected instead of silently
dropping speech. Incoming tracks are mixed to mono and emitted in 20 ms, 48 kHz
frames. `interrupt()` stops queued output; `close()` leaves MatrixRTC, disconnects
LiveKit and terminates the owned browser and localhost asset server.

`status()` exposes only connection/encryption flags, membership, sticky-event and
key-message counts, and the local media key index. It never returns keys, tokens
or PCM. SDK console
logs are not forwarded to Node; Matrix SDK logging is disabled because HTTP
diagnostics may contain authentication details.

Run the isolated local proof with:

```powershell
node scripts/matrix-smoke.ts
```

It provisions two temporary lab devices in an encrypted room, exchanges different
synthetic tones, checks decoded audio in both directions and requires the
remaining participant to rotate its media key after the other leaves. It logs
only sanitized counts and booleans, closes both browsers and logs out both
devices. Synthetic PCM is never written to disk. The test does not establish
compatibility with a particular Element UI version or capture a human microphone.
The separate `npm.cmd run smoke:e2e` and `npm.cmd run smoke:command` checks passed
the subscribed Codex voice bridge, including a real local command and audible
return audio through this encrypted adapter; see [architecture](architecture.md).

## Observed local results, 2026-11-11

Two runs passed with per-participant E2EE, bidirectional nonzero PCM, distinct
700/1100 Hz remote tones and a new local media key index after the peer left.
One verified run received 220/164 20 ms frames. A remote track must be attached to
a playing HTML audio element before headless Edge supplies nonzero samples to
Web Audio. The browser uses `--mute-audio`; no sound is sent to the speakers.

The successful smoke starts both crypto clients concurrently before the first
encrypted RTC membership is sent. A separate ongoing-call test remains available:

```powershell
node scripts/matrix-smoke.ts --late-join
```

It currently fails the media-key readiness assertion. A newly initialized,
unverified device cannot decrypt the first participant's previously encrypted
Megolm sticky membership. The first participant sees two memberships, the late
participant sees only its own; the late participant receives the encrypted
to-device media key but the SDK cannot associate it with an undecrypted remote
membership. Raising the timeline initial-sync limit did not help.

This is a concrete limit of the memory-only, fresh-device prototype: keep the
bot crypto-warm and online before the call. Joining an existing call needs a persistent crypto store
and the normal device verification/key-sharing workflow, which has not been
implemented here. The failing case does not fall back to plaintext.
