# Coordinator election & failover

Only `deviceType: "laptop"` instances are eligible to run the coordinator
role (mobile browsers cannot host a WebSocket server or bind a port). This
doc pins down exactly how a laptop decides whether to become the coordinator
and how the group recovers when the current coordinator disappears.

## 1. Constants

| Name | Value |
|---|---|
| `COORDINATOR_PORT` | `47811` (fixed, so `anydrop.local:47811` is stable across elections) |
| `MDNS_SERVICE_TYPE` | `_anydrop._tcp.local` |
| `ELECTION_PROBE_MS` | 1500 — how long a freshly-launched laptop browses mDNS before concluding "no coordinator exists" |
| `FAILOVER_DELAY_MS` | random(0, 2000) — jitter applied before a laptop attempts to become the *new* coordinator after detecting the old one is gone |
| `BIND_RETRY_MS` | 300 — if two laptops jitter into the same window and both attempt to bind, the loser retries after this delay, by which point the winner's mDNS record is up and the loser's probe (re-run before every bind attempt) will find it |

## 2. Startup sequence (every laptop instance)

```
1. Generate/load deviceId (persisted).
2. Browse mDNS for MDNS_SERVICE_TYPE for up to ELECTION_PROBE_MS.
3. If a service answers:
     -> resolve its host:port, connect as an ordinary WebSocket client.
4. If nothing answers within ELECTION_PROBE_MS:
     -> attempt to bind COORDINATOR_PORT on 0.0.0.0 (LAN interfaces only —
        see security.md §1).
     -> on success: start the WebSocket server, advertise via mDNS with
        TXT record { epoch: 1, deviceId }, connect to *itself* as a client
        so the coordinator's own UI works identically to any other client.
     -> on EADDRINUSE (another laptop won a race in the last few ms):
        wait BIND_RETRY_MS, re-run step 2 once, then join as a client.
```

Phones always run step 2 only, with no fallback to step 4 (they are never
election-eligible). If a phone's probe finds nothing, it shows a "no Anydrop
device found on this network yet — open the app on a laptop first" state and
keeps retrying the probe on a slow interval (10s) in the
background.

## 3. Detecting coordinator loss

Every client (including the coordinator's own loopback client connection)
watches its single WebSocket connection to the coordinator. Loss is
detected by *either*:

- the WebSocket `close`/`error` event, or
- `HEARTBEAT_TIMEOUT_MS` (15000ms, see `protocol.md` §4) elapsing with no
  message received from the coordinator at all (covers a half-open TCP
  connection where no close event ever fires).

On detecting loss, a **laptop** client:

1. Waits `FAILOVER_DELAY_MS` (fresh random jitter each time).
2. Re-runs the full startup sequence from §2 step 2. If another laptop
   already won (jittered lower), this client simply reconnects to the new
   coordinator as a client — no special "demotion" logic needed, since a
   losing bind attempt always falls through to "join as client."
3. Whichever laptop does end up binding increments `epoch` from the last
   value it saw in any TXT record during its browse (or `1` if it never
   saw one), and broadcasts it in its own TXT record and in the
   `coordinator-announce` message.

A **phone** client on coordinator loss simply re-runs its mDNS probe (step 2
only) on the same 10s slow-retry loop described in §2 — it never attempts a
bind.

### Overlap window

Because election is fully decentralized (no consensus round — first
successful port bind wins), it's possible for two laptops to both believe
they're about to become coordinator for a few hundred milliseconds. This is
harmless: the loser's `bind()` call fails with `EADDRINUSE`, and *nothing
about peer state is lost*, because the coordinator holds no state that
matters beyond the current WebSocket connections and peer list — every
client re-`register`s against whichever coordinator it ends up connected
to. `epoch` exists only so a client can log "coordinator changed (epoch 3
→ 4)" for diagnostics; no message is ever rejected because of it.

## 4. In-flight transfers during failover

Transfers never touch the coordinator (strictly P2P over an already-open
`RTCDataChannel`), so an in-progress transfer is **unaffected** by a
coordinator failover — the sender and receiver keep streaming to each
other even while the coordinator WebSocket they used for signaling is being
re-elected underneath them. Only *starting a new* transfer (which needs a
live signaling channel to exchange SDP/ICE) has to wait out the failover
window, typically ≤ `ELECTION_PROBE_MS + FAILOVER_DELAY_MS` (~3.5s worst
case).

## 5. Why no real consensus algorithm

A LAN of a handful to a few dozen laptops in one office, where "coordinator"
only means "holds an ephemeral peer list and relays SDP blobs," doesn't
need Raft/Paxos-grade guarantees — the cost of two coordinators briefly
overlapping is zero (see §3), and the cost of implementing/testing real
consensus correctly is high. First-bind-wins plus jittered retry is the
right amount of engineering for what's actually at stake here.
