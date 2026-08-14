// Kept in sync with docs/protocol.md §4 and docs/election.md §1.
export const PROTOCOL_VERSION = 1;

export const COORDINATOR_PORT = 47811;
export const MDNS_SERVICE_TYPE = "anydrop"; // bonjour-service adds the _tcp.local suffix

export const HEARTBEAT_INTERVAL_MS = 5000;
export const HEARTBEAT_TIMEOUT_MS = 15000;
export const COORDINATOR_SWEEP_INTERVAL_MS = 5000;

export const ELECTION_PROBE_MS = 1500;
export const BIND_RETRY_MS = 300;
export const FAILOVER_DELAY_MIN_MS = 0;
export const FAILOVER_DELAY_MAX_MS = 2000;
export const PHONE_RETRY_INTERVAL_MS = 10_000;
