# Universe in Element

The native adapter opens a private encrypted chat with the Universe robot in real
Element Web. Click the chat's **Voice call** button. The adapter keeps its Matrix
crypto device synced while idle, prepares the universal voice backend, then joins
the caller's MatrixRTC session. Hanging up in Element closes the backend session
and leaves RTC while keeping the bot ready for the next call.

An explicit spoken request such as “заверши звонок” delegates to the registered
`end_call` client tool. The adapter acknowledges the request, leaves only its
current RTC call and keeps its Matrix device online. It waits for the caller to
leave the old call before answering a new one. The assistant never needs to kill
the adapter or server process to hang up. Other integrations can register this
same tool through `session.start.tools` and implement their own call exit.
An immediate redial waits for the previous backend cleanup if the API reports
its single session slot as busy, within the existing 45-second startup timeout.

Start these from the repository root:

First complete the README setup, including `npm ci` and `npm run setup:browser`.
The host adapter runs on Windows, Linux or macOS using Playwright Chromium;
Docker provides the Linux Matrix services on all three hosts.

```sh
npm run matrix:up
npm run build
npm start
# In another terminal:
node dist/matrix-native.mjs
```

Open **http://127.0.0.1:18795/matrix**. The normal Element token-login flow opens
the Universe chat on port 18081. `UNIVERSE_MATRIX_PORT` changes the bootstrap port;
`UNIVERSE_API_URL` changes the loopback universal WebSocket endpoint (default
`ws://127.0.0.1:18793/session`). This adapter runs no commands itself. The backend
handles native Codex shell/file tools and its execution policy.

The bootstrap creates two local lab accounts and their private room. Only the
designated human account may trigger the bot. The human can start calls but
cannot invite more members; unexpected RTC users are refused. Bot credentials
and crypto keys remain in memory. Element manages its own browser login/crypto
store. A 60-second, one-use login token crosses the browser redirect; request
logging is disabled for Element. Never copy a transient token-bearing URL into
logs or documentation. Closing the adapter revokes both accounts' sessions.
Restarting creates a new chat and bot device; recovery of a long-lived identity
and verified persistent crypto is outside this local prototype.

All published audio uses Matrix per-member media keys and LiveKit E2EE. Room
Megolm encryption, an encrypted RTC slot, MSC4354 sticky events and modern MSC4195
authorization are required. Unencrypted published tracks are refused. Missing
keys on early encrypted packets are retried by LiveKit while key readiness has a
bounded timeout. The idle device never requests a microphone or starts a backend
session. Audio from a muted caller does not block joining.

## Pinned Element Call widget

Element Web 1.12.33 embeds a transitional Call version whose transport identity
shape differs from SDK 45.1.0. The lab mounts the official Element Call build at
revision `96949a57da2a24f0c9ad53d63b974b82b2f04b36`, Docker digest
`sha256:438bbe669b2d36620c92a8ad37b3ab0e4a3e4a39237d7c9358a7d27caffe0539`.
It remains Element's native call widget; no custom call UI is substituted.
The full package's absolute `/assets` path is mounted from the same named volume.
`feature_element_call_react=false` selects the widget so its deployment config
can pin `matrix_rtc_mode=matrix_2_0`. No external Call/Jitsi service is used.

That pinned build has a late-device-enumeration race in
`src/state/localMediaControls.ts`: a skip-lobby call can begin before devices are
enumerated, then show its default microphone as enabled without capturing it.
`infra/call-media-ready.py` applies one exact, asserted replacement in the pinned
bundle's `followMuteState` function. It observes the enabled switch and publishes
when a device becomes available, while honoring an explicitly muted switch.
The stale gzip copy is removed. The init fails if the expected bundle changes;
review/remove this patch when upgrading to an upstream fix. The readable patch
and upstream source are linked below; review Element's license before distributing
its modified assets.

## Verification

```sh
node --test tests/native-matrix.test.ts
node scripts/matrix-native-smoke.ts
node scripts/matrix-smoke.ts
npm run smoke:native-agent
npm run smoke:hangup
```

The native smoke opens real Element with temporary browser storage and synthetic
microphone PCM. It starts a fake universal API, proves decrypted 600 Hz microphone
audio reaches that API and 1100 Hz return audio reaches Element, checks mute,
hangup and a second call, then closes its browsers/accounts. It does not start a
subscribed model. Only counts and booleans are printed; the test screenshot is
`runtime/native-element-call.png`. Native unit tests cover backend-first startup,
cancellation during startup, rapid rejoin, audio reset and loopback restrictions.

`smoke:native-agent` additionally starts the real subscribed Codex backend, opens
the real Element chat and Voice call with a synthetic spoken RAM question, and
requires native shell execution, a host-matching RAM value in the spoken
transcript, decoded audible reply in Element and native hangup. This check passed
after renaming the project directory. It consumes the account's voice/Codex limits;
the fake-API smoke above does not. Only synthetic speech is used, never a human
microphone recording. The fixed question loops during the test and is muted as
soon as the first backend command completes.

`smoke:hangup` uses the same real Element/subscribed backend path with a synthetic
spoken request to end the call. It requires a successful `end_call`, actual RTC
disconnection, an idle bot and no automatic new session. This check passed; no
manual hangup is used to satisfy its assertions.

This is a loopback lab with open registration and public development SFU secrets.
It is not a public homeserver deployment configuration. The adapter/API split is
reusable; a real deployment needs its own account provisioning and verified
device persistence. The old custom call demo remains a separate test harness.

Sources: [Element Call embedding and self-hosting](https://github.com/element-hq/element-call/blob/main/docs/self_hosting.md),
[Element Web call configuration](https://github.com/element-hq/element-web/blob/develop/docs/config.md#voipvideo-calling),
[pinned media control source](https://github.com/element-hq/element-call/blob/96949a57da2a24f0c9ad53d63b974b82b2f04b36/src/state/localMediaControls.ts),
[Element Call license](https://github.com/element-hq/element-call/blob/96949a57da2a24f0c9ad53d63b974b82b2f04b36/LICENSE-AGPL-3.0),
[Synapse one-use login settings](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#login_via_existing_session).
