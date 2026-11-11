# Universe Local Prototype Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. The user explicitly authorized implementation and local Docker testing; do not ask for another plan approval.

**Goal:** Run a universal local voice assistant API backed by the user's existing ChatGPT Codex login, then exercise a Matrix call through an isolated Docker stack.

**Architecture:** A Node.js process owns a Codex App Server child and exposes a localhost WebSocket API. Matrix participation and audio conversion live in an adapter, outside the core. Test one owner, one voice session, one explicitly registered demonstration tool.

**Tech Stack:** Node.js, TypeScript 7.1.0-beta, esbuild, native node:test, ws; use Matrix and LiveKit SDKs only in the adapter.

**Spec:** docs/architecture.md plus the user's explicit local development request.

## Global Constraints

- All development is in this directory; no changes to the friend's VM.
- Use existing ChatGPT login; never copy or log its tokens, and do not use a paid Voice API key.
- TypeScript 7.1.0-beta and esbuild 0.28.2 are pinned.
- Test infrastructure uses a unique Compose project and non-conflicting localhost ports.
- Credentials remain in process memory or Docker-managed data, outside project files and logs.
- Matrix-specific code does not enter the core API.

## Review Focus

- Invalid or oversized client messages must be rejected without crashing or spawning tasks.
- Codex exit, failed startup and disconnect must reject pending requests and close the owned session.
- Repeated delivery of a tool call must not execute its action twice.
- Audio format and interruption must preserve ordering and clear obsolete output.
- A browser from another origin must not gain command execution through the localhost API.

## Task 1: Codex connection and live capability probe

**Files:** package.json, tsconfig.json, scripts/build.mjs, src/codex.ts, tests/codex.test.ts, scripts/probe-codex.ts.

**Interfaces:** CodexClient.request(method, params), notification and server-request callbacks, close().

- [x] Write and run failing tests for split JSONL, request correlation, startup/exit failure and bounded timeouts.
- [x] Implement the minimum child-process JSONL connection, using the real Windows executable entry point and existing login.
- [x] Build and typecheck, then probe account state, a read-only thread, realtime startup and a short synthetic spoken response.
- [x] Record only sanitized capability results and counts, never raw account/conversation data.

## Task 2: Universal session API and demonstration tool

**Files:** src/session.ts, src/server.ts, src/protocol.ts, tests/session.test.ts, tests/server.test.ts, scripts/smoke.ts.

**Interfaces:** localhost /health and /session WebSocket; session.start, input.text, input.audio, session.interrupt, session.close; output audio, transcript, progress, tool and error events.

- [x] Write and run failing tests for message limits, invalid audio, duplicate tools and disconnect cleanup.
- [x] Implement a single owner/session API, input validation, bounded output, explicit localhost origins and a harmless demonstration tool.
- [x] Verify text-to-tool-to-result and voice output against the actual Codex process when account capabilities permit.

## Task 3: Isolated Matrix call integration

**Files:** infra/compose.yml, infra/* configs, scripts/matrix-stack.ts, src/matrix/*, tests/matrix.test.ts, scripts/matrix-smoke.ts, README.md, docs/api.md.

**Interfaces:** Matrix adapter translates room membership/audio to the same Universe session API; normal clients remain independent of Matrix SDKs.

- [x] Start one local Synapse, LiveKit and JWT service on unused ports, with Docker-managed data.
- [x] Create test-only accounts/room, set the bot's name/avatar and verify Matrix auth/discovery/JWT.
- [x] Connect two participants, prove audio flows both ways and exercise the same registered tool through Universe.
- [x] Verify E2EE with the client SDK, or document a concrete incompatibility without silently disabling encryption.
- [x] Run tests, typecheck and build; update run instructions and actual E2E evidence.
- [x] Obtain one fresh-context whole-change review, fix important findings and re-run affected checks.

## Execution record

- Initial state: documentation only, no Git repository, Docker Desktop and Codex ChatGPT login available.
- Existing Docker services occupy 7880/7881, 6379 and 3306. Universe must not stop or reuse them.
- Ruling: work in the user-selected fresh project directory on a dedicated local branch; no additional worktree is necessary.
