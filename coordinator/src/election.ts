import { Bonjour } from "bonjour-service";
import { BIND_RETRY_MS, COORDINATOR_PORT, ELECTION_PROBE_MS, FAILOVER_DELAY_MAX_MS, FAILOVER_DELAY_MIN_MS, MDNS_SERVICE_TYPE } from "./constants.js";
import { advertiseCoordinator, probeForCoordinator, type DiscoveredCoordinator } from "./mdns.js";
import { startCoordinatorServer, type CoordinatorServerHandle } from "./server.js";

export type CoordinatorRole = "coordinator" | "client";

export interface ElectionHandle {
  role(): CoordinatorRole;
  currentEpoch(): number;
  serverHandle(): CoordinatorServerHandle | null;
  /**
   * The host a same-machine UI should open its WebSocket to: "localhost"
   * when this instance won the election, or the discovered coordinator's
   * advertised host when it didn't — a client instance runs no server of
   * its own, so pointing its UI at "localhost" would just connect to
   * nothing. Null only in the brief/rare window before the initial probe
   * has resolved either way.
   */
  coordinatorHost(): string | null;
  stop(): Promise<void>;
}

export interface ElectionOptions {
  port?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
  tls?: { cert: Buffer; key: Buffer };
}

function jitter(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Implements docs/election.md end to end: probe on startup, bind+advertise
 * if nothing answers, and re-attempt (with jittered backoff) whenever the
 * currently-tracked coordinator's mDNS record disappears.
 */
export async function runElection(opts: ElectionOptions = {}): Promise<ElectionHandle> {
  const port = opts.port ?? COORDINATOR_PORT;
  const log = opts.logger ?? console;
  const bonjour = new Bonjour();

  let role: CoordinatorRole = "client";
  let epoch = 0;
  let server: CoordinatorServerHandle | null = null;
  let tracked: DiscoveredCoordinator | null = null;
  let attemptingFailover = false;

  async function tryBecomeCoordinator(nextEpoch: number): Promise<boolean> {
    try {
      server = await startCoordinatorServer({ port, logger: log, tls: opts.tls });
      epoch = nextEpoch;
      role = "coordinator";
      advertiseCoordinator(bonjour, port, epoch);
      log.info?.(`became coordinator (epoch ${epoch}) on ${server.boundAddresses.join(", ")}`);
      return true;
    } catch (err) {
      log.warn?.(`failed to bind coordinator port: ${(err as Error).message}`);
      return false;
    }
  }

  // --- initial probe ---
  const initial = await probeForCoordinator(bonjour, ELECTION_PROBE_MS);
  if (initial) {
    tracked = initial;
    epoch = initial.epoch;
    role = "client";
    log.info?.(`found existing coordinator at ${initial.host}:${initial.port} (epoch ${initial.epoch})`);
  } else {
    const won = await tryBecomeCoordinator(1);
    if (!won) {
      await new Promise((r) => setTimeout(r, BIND_RETRY_MS));
      const recheck = await probeForCoordinator(bonjour, ELECTION_PROBE_MS);
      if (recheck) {
        tracked = recheck;
        epoch = recheck.epoch;
      }
    }
  }

  // --- continuous watch for the tracked coordinator disappearing ---
  const browser = bonjour.find({ type: MDNS_SERVICE_TYPE });
  browser.on("up", (service) => {
    if (role === "coordinator") return;
    tracked = { host: service.host ?? "anydrop.local", port: service.port, epoch: Number(service.txt?.epoch ?? epoch) };
    epoch = tracked.epoch;
  });
  browser.on("down", (service) => {
    if (role === "coordinator" || attemptingFailover) return;
    if (tracked && service.port !== tracked.port) return; // not the one we're tracking
    void attemptFailover();
  });

  async function attemptFailover(): Promise<void> {
    attemptingFailover = true;
    try {
      await new Promise((r) => setTimeout(r, jitter(FAILOVER_DELAY_MIN_MS, FAILOVER_DELAY_MAX_MS)));
      if ((role as CoordinatorRole) === "coordinator") return;
      const won = await tryBecomeCoordinator(epoch + 1);
      if (!won) {
        await new Promise((r) => setTimeout(r, BIND_RETRY_MS));
        const recheck = await probeForCoordinator(bonjour, ELECTION_PROBE_MS);
        if (recheck) {
          tracked = recheck;
          epoch = recheck.epoch;
        }
      }
    } finally {
      attemptingFailover = false;
    }
  }

  return {
    role: () => role,
    currentEpoch: () => epoch,
    serverHandle: () => server,
    coordinatorHost: () => (role === "coordinator" ? "localhost" : (tracked?.host ?? null)),
    async stop() {
      browser.stop();
      bonjour.unpublishAll(() => bonjour.destroy());
      await server?.close();
    },
  };
}
