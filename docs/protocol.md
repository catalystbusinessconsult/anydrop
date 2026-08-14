# Anydrop — Signaling Protocol v1

Status: **finalized for v1 implementation**. Every client (web PWA, Tauri
desktop) implements exactly this contract against the coordinator. The
coordinator only ever sees this JSON traffic and raw WebRTC signaling
payloads — it never touches file bytes.

## 1. Transport

- One WebSocket connection per client, opened to whichever coordinator is
  currently advertised (`ws://anydrop.local:<port>` or `wss://` once local
  HTTPS via mkcert is wired up — see [`security.md`](./security.md)).
- Messages are UTF-8 JSON, one object per WebSocket frame. No batching, no
  newline-delimited framing.
- Every message has a `type` field. Unknown `type` values MUST be ignored
  (not error) by both sides, so the protocol can grow without breaking older
  clients on the same LAN.

## 2. Identity

- `deviceId`: a UUID v4, generated once per install and persisted locally
  (localStorage for the PWA, app-local storage for the Tauri app). Stable
  across reconnects and across coordinator failover.
- `nickname`: user-editable display name (default: `"<platform> device"`).
- `deviceType`: `"laptop" | "phone"`. Only `"laptop"` instances are eligible
  to run a coordinator (see [`election.md`](./election.md)); this field does
  not restrict who can send/receive files.

## 3. Message catalogue

### Client → Coordinator

```jsonc
// Sent once, immediately after the WebSocket opens. Must be the first
// message on the connection — the coordinator ignores everything else
// from a connection that hasn't registered yet.
{ "type": "register", "deviceId": "uuid", "nickname": "string", "deviceType": "laptop" | "phone", "protocolVersion": 1 }

// Relay envelope for WebRTC negotiation. `payload` is opaque to the
// coordinator — it is forwarded byte-for-byte to `to`.
{ "type": "signal", "to": "deviceId", "payload": { "kind": "offer" | "answer" | "ice-candidate", "sdp": "...", "candidate": {} } }

// Sent every HEARTBEAT_INTERVAL_MS (see §4). deviceId is redundant with the
// connection identity but kept explicit so the message is self-describing
// in logs/tests.
{ "type": "heartbeat", "deviceId": "uuid" }

// Optional: client tells the coordinator it is leaving cleanly (tab close,
// app quit). Coordinator still applies the same cleanup as a timeout, but
// this makes peer-left broadcast immediately instead of waiting out the
// timeout window.
{ "type": "unregister", "deviceId": "uuid" }

// Sent by a laptop client that just won an election and switched into the
// coordinator role, to any coordinator connection it still holds open
// during handoff (see election doc, §3 "overlap window").
{ "type": "coordinator-announce", "deviceId": "uuid", "epoch": 12 }
```

### Coordinator → Client

```jsonc
// Full snapshot, sent to a client right after it registers, and again any
// time the peer set changes (join/leave/timeout). Not a diff — always the
// complete list, excluding the recipient itself.
{ "type": "peer-list", "peers": [{ "deviceId": "uuid", "nickname": "string", "deviceType": "laptop" | "phone" }] }

// Forwarded signaling payload, opaque passthrough of what `from` sent.
{ "type": "signal", "from": "deviceId", "payload": { } }

// A peer disconnected (timeout or explicit unregister).
{ "type": "peer-left", "deviceId": "uuid" }

// Reply to a heartbeat. Optional in v1 (clients don't need it to stay
// alive — see §4), but the coordinator sends it so clients can measure
// round-trip latency and detect a half-open socket faster than TCP would.
{ "type": "heartbeat-ack", "deviceId": "uuid", "serverTime": 1699999999999 }

// Sent when a `register` is rejected for an unsupported protocolVersion.
// Registering with a deviceId that already has a live connection is NOT
// rejected — see the note below.
{ "type": "register-rejected", "reason": "unsupported-version" }
```

A `register` for a `deviceId` that's already registered is treated as a
reconnect (page refresh, brief network blip), not a collision: the
coordinator closes the old connection and adopts the new one. A live
re-register from the same device is far more common than a genuine
collision between two different devices, and UUIDv4 `deviceId`s make a real
collision astronomically unlikely — so there is no `"duplicate-device"`
rejection reason in v1.

## 4. Heartbeat, timeout, reconnect (pinned down)

| Parameter | Value | Rationale |
|---|---|---|
| `HEARTBEAT_INTERVAL_MS` | 5000 | Frequent enough to detect a dropped wifi association within one exam-room-sized delay budget, cheap enough (~tens of bytes/5s/peer) to not matter on a LAN. |
| `HEARTBEAT_TIMEOUT_MS` | 15000 (3 missed beats) | Requiring 3 consecutive misses avoids evicting a peer over a single delayed frame (GC pause, wifi roam) while still failing in well under 20s. |
| Coordinator sweep interval | 5000 | The coordinator checks all connections' `lastHeartbeatAt` on the same cadence as the heartbeat itself — no separate timer drift to reason about. |
| Client reconnect backoff | 500ms, ×2 per attempt, cap 10000ms, ±20% jitter | Standard decorrelated-ish exponential backoff. Jitter avoids every phone in the room retrying in lockstep after a coordinator restart. |
| Reconnect attempts before re-running discovery | 5 | After 5 failed reconnects to the same host:port, the client drops back to mDNS probe / QR re-scan instead of hammering a coordinator that may have failed over elsewhere. |

Notes:
- The coordinator is the source of truth for liveness: it evicts on
  `HEARTBEAT_TIMEOUT_MS`, not on WebSocket close alone (a close event fires
  immediately and is also honored, but the timer covers half-open sockets
  where no close event ever arrives).
- Clients do **not** need to wait for `heartbeat-ack` to consider the
  connection healthy; only the underlying WebSocket `readyState` and receipt
  of *any* server message count. `heartbeat-ack` is a diagnostic/latency
  signal, not a keepalive gate.

## 5. Election & failover (summary — full detail in [`election.md`](./election.md))

- Only `deviceType: "laptop"` instances run the coordinator's WebSocket
  server + mDNS advertisement. On launch, a laptop instance browses for an
  existing `_anydrop._tcp.local` service for `ELECTION_PROBE_MS` (1500ms);
  if one answers, it joins as an ordinary client. If nothing answers, it
  binds the coordinator port and starts advertising.
- If a laptop's coordinator process disappears (peers stop getting
  heartbeat-acks / the WebSocket closes for everyone at once), every
  remaining laptop client independently starts the same probe-then-bind
  sequence after a randomized `FAILOVER_DELAY_MS` (0–2000ms jitter) so they
  don't all race the port bind at once.
- `epoch` on `coordinator-announce` is a monotonically increasing integer a
  new coordinator picks as `previousEpoch + 1` (persisted in the mDNS TXT
  record so a freshly-launched instance can read it without having been
  present for the handoff). It exists purely so clients can log/ignore a
  stale announce if two coordinators briefly overlap; it is not used for
  conflict resolution — first successful port bind always wins.

## 6. Pairing PIN (summary — full detail in [`security.md`](./security.md))

The signaling protocol above is unauthenticated at the transport level (any
device on the LAN can register). Trust is established one level up, per
device-pair, the first time two specific devices attempt a transfer: the
receiving device displays a 6-digit PIN, the sender must enter it before the
WebRTC offer is accepted. This is carried as part of the `signal` payload's
`kind: "offer"` handshake, not as a new top-level message type — see
`security.md` §2 for the exact payload shape.

## 7. Versioning

`protocolVersion` starts at `1`. A coordinator that receives a `register`
with a higher `protocolVersion` than it implements MUST still accept the
connection and relay signaling (it never inspects `signal` payloads), so a
future protocol bump only breaks new-feature negotiation, not basic
transfer, across a mixed-version LAN. `register-rejected` with
`unsupported-version` is reserved for a future breaking change, not used in
v1.
