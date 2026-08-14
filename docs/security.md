# Security requirements

## 1. LAN-only binding

- The coordinator's WebSocket server binds only to interfaces with a
  private-range address (RFC1918: `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, plus link-local `169.254.0.0/16`). On startup it
  enumerates OS network interfaces, picks the private-range ones, and binds
  explicitly to each of those addresses rather than `0.0.0.0` — a laptop
  that also has a public/VPN interface up must not expose the coordinator
  there.
- Every incoming WebSocket upgrade request is checked against the same
  private-range allowlist using the *remote* address the OS reports for
  the socket; anything else is rejected at the TCP level before the
  WebSocket handshake completes. This is defense in depth on top of the
  bind restriction (covers e.g. a misconfigured router doing NAT loopback
  weirdness).
- mDNS advertisement (`bonjour-service`) is likewise scoped to the private
  interfaces only.

## 2. Pairing PIN

Registering with the coordinator and appearing in the peer list requires no
authentication — that's by design, it's just presence on the LAN. Trust is
established per device-pair, lazily, the first time two specific devices
try to actually move a file:

1. Sender picks a peer and a file, and sends a `signal` with
   `payload.kind: "offer"` as normal, but the SDP offer's companion
   application data (sent over the same channel once it's open, before any
   file bytes) includes a freshly generated `{ pairingRequestId, senderNickname }`.
2. The **receiving** device generates a random 6-digit PIN, displays it
   full-screen ("Share this code with the sender: 482913"), and does *not*
   yet accept the data channel for file traffic.
3. The sender's UI prompts the human sending the file to type in the PIN
   they were told (out of band — read aloud, shown on the receiver's
   screen across the room, etc). The PIN travels back over the already-
   established (DTLS-encrypted) data channel as a small control message.
4. If it matches, the receiver marks that `deviceId` pair as trusted for
   `PAIRING_TTL_MS` (24h, persisted locally on the receiver only — the
   coordinator never sees the PIN or the trust decision) and the transfer
   proceeds. If it doesn't match within 3 attempts, the connection is torn
   down and the sender must re-initiate.
5. Subsequent transfers between the same already-trusted pair, within the
   TTL, skip the PIN prompt and go straight to the existing accept/reject
   confirmation (§3).

This is intentionally lightweight (not a cryptographic pairing protocol) —
the threat it defends against is "a device that shouldn't be able to send
me files silently shows up as a target because it's on the same wifi," not
a sophisticated on-path attacker. WebRTC's mandatory DTLS already covers
transport confidentiality/integrity.

## 3. Per-transfer accept/reject

Independent of pairing trust, *every* incoming transfer (even from an
already-trusted device) shows the receiver a confirmation prompt with the
sender's nickname, file name, size, and type before any chunk is written to
disk. There is no "auto-accept" mode in v1.

## 4. No file persistence on the coordinator

The coordinator process never has a file handle, a chunk buffer, or a
temp-file path in its address space — `signal` payloads it relays contain
only SDP/ICE text, never file data. This is enforced structurally (the
coordinator's message handler only has cases for the message types in
`protocol.md` §3, all of which are signaling/presence), not by a runtime
check, so there's no filter to bypass.

## 5. Retention / expiry

| State | Expires after |
|---|---|
| Peer registry entry | `HEARTBEAT_TIMEOUT_MS` (15s) of missed heartbeats, or immediate on clean `unregister`/socket close |
| In-flight transfer session state (chunk offsets, for resume) | 1 hour of inactivity, then the partial file and its resume record are deleted from the receiver's local storage |
| Device pairing trust (§2) | `PAIRING_TTL_MS`, 24h, sliding — refreshed on each successful transfer between the pair |

None of this state lives on the coordinator; all of it is local to each
client, since the coordinator restarts (via failover) far more often than
any of these windows and must not be a place transfer state depends on.

## 6. Transport encryption

DTLS is mandatory and automatic for every `RTCDataChannel` — there is no
"insecure" mode to accidentally select. The signaling WebSocket itself
should run over `wss://` using a locally-trusted cert issued by `mkcert`
(see root README "Local HTTPS" section) both because iOS Safari gates
several PWA APIs behind a secure context and because it keeps the SDP/ICE
exchange itself off plaintext WebSocket, even though its payload is not
file data.
