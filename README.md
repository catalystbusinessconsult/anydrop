# Anydrop

Peer-to-peer local file transfer, built for the CBC Africa office network (Abule-Oja,
Lagos). No dedicated server, no internet dependency — any laptop on the LAN
can transparently host the coordinator role, and files move directly between
devices over WebRTC.

**Features:** peer discovery over mDNS/WebSocket, pairing-PIN trust per
device-pair, drag-and-drop multi-file send (queued sequentially per peer),
cancel an in-progress transfer from either side, resume-on-reconnect, and
QR-code pairing so a phone can join without typing a hostname.

See [`docs/protocol.md`](./docs/protocol.md) for the finalized signaling
contract, [`docs/election.md`](./docs/election.md) for how coordinator
failover works, and [`docs/security.md`](./docs/security.md) for the pairing
PIN / LAN-binding model. `docs/testing-matrix.md` tracks real-device
verification status (not yet run — see "What's verified" below).

## Repo layout

```
/coordinator        # standalone signaling + mDNS service (Node), testable headless
/transfer-engine     # shared TS module: WebRTC connection, chunking, disk writes, resume, hashing
/web                 # PWA — peer list, send/receive UI, progress
/desktop             # Tauri wrapper, bundles /coordinator as sidecar + tray + drag-drop
/docs
```

## Getting started (dev)

```bash
npm install
npm run dev:coordinator   # terminal 1 — starts the signaling service on :47811
npm run dev:web           # terminal 2 — Vite dev server on :5173
```

Open `http://localhost:5173` in two browser tabs (or two devices on the same
LAN once `anydrop.local` resolves — see `desktop/README.md` for the mkcert
HTTPS setup iOS Safari needs) to see two "devices" discover each other and
transfer a file over a real `RTCDataChannel`.

```bash
npm test    # runs transfer-engine + coordinator unit/integration test suites
npm run lint  # tsc --noEmit across all packages
```

## What's verified vs. scaffolded

Built and tested in this environment (no external toolchain required beyond
Node — see `npm test`):
- `transfer-engine`: chunking, per-chunk + final-file hashing, resume
  bookkeeping, pairing-PIN trust store, and a full send→receive round trip
  (including a simulated resume-from-partial-state case) against a fake
  in-memory data channel.
- `coordinator`: peer registry (register/heartbeat/timeout/eviction), the
  private-IP/loopback address allowlist, and the WebSocket protocol itself
  (register, peer-list broadcast, signal relay, reconnect-replaces-stale,
  heartbeat-ack, peer-left on disconnect) against **real** `ws` clients over
  loopback.
- `web` + the full stack together: driven live in two real browser tabs
  against a real running coordinator and real `RTCPeerConnection`s — peer
  discovery, the pairing-PIN handshake, accept/reject, chunked transfer,
  multi-file queued sends, cancel-in-progress, and hash verification all
  completed successfully end to end (`Done`/`Cancelled` on both sides, bytes
  matching). Two live passes caught and fixed real bugs that only showed up
  under actual browser/network conditions, none of which the fake-channel
  unit tests exposed:
  - A WebSocket reconnect storm from orphaned sockets still calling back
    into a superseded client (`coordinatorClient.ts` now guards every
    handler on `this.ws === ws`), plus the coordinator now treats a
    same-`deviceId` re-register as a reconnect (replaces the stale
    connection) instead of rejecting it — see `docs/protocol.md` §3.
  - A crash reassigning the read-only `File.name` getter before handing a
    file to the transfer engine, a receiver-side progress counter that
    overshot 100% on the final partial chunk, and `pickWriter()` now falls
    back past the File System Access API if `createWritable()` throws.
  - A per-peer "one incoming transfer at a time" guard that raced the
    sender's multi-file queue and silently dropped the second file's offer
    — removed, since each transfer already gets its own `RTCPeerConnection`.
  - `TransferEvent`'s `progress` variant nests `fileId` under `.progress`,
    unlike every other variant — a `"fileId" in event` check silently missed
    it, collapsing every in-flight transfer's progress onto one shared `""`
    key once more than one transfer could be active in a session.
  - `receiveFile()` resolves with `meta` on every terminal outcome
    (complete/rejected/cancelled alike); a leftover `.then()` in the UI
    blindly re-applied a "complete" event over whatever the real outcome
    was — removed, since `onEvent` already reports the real terminal state.
  - Cancelling mid-transfer: chunks already queued when cancellation lands
    keep draining (unsubscribing only stops *new* chunks), and a chunk
    handler already past its "are we done yet?" check when the terminal
    state lands would still fire its progress event afterward — both are
    now guarded in `transferSession.ts`, checked once before and once after
    the chunk's async work. Also fixed: `sendFile()`'s final wait for the
    receiver's hash verification didn't handle a late-arriving cancellation,
    throwing instead of resolving cleanly.

Scaffolded but **not** build/run-verified here, because this environment has
neither a Rust toolchain nor `mkcert` installed:
- `desktop` (Tauri): `tauri.conf.json`, the Rust `src-tauri/` skeleton
  (system tray, sidecar spawn, auto-launch), and capabilities are written
  against the documented Tauri v2 API surface but have never been compiled.
  Needs Rust + a packaged coordinator sidecar binary — see
  `desktop/README.md` for the concrete next step.
- Local HTTPS via mkcert (needed for full iOS Safari compatibility).
- Everything in `docs/testing-matrix.md` — real hardware (iPhone Safari,
  Android Chrome, the packaged `.exe`) hasn't been touched, only localhost
  browser tabs.

## Constants worth knowing

Pinned down in `docs/protocol.md` §4 and `docs/election.md` §1 — coordinator
port `47811`, heartbeat every 5s with a 15s (3-miss) eviction timeout,
election probe window 1.5s, jittered 0-2s failover delay. Change them in one
place: `coordinator/src/constants.ts`.
