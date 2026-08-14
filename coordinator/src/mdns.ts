import { Bonjour, type Service } from "bonjour-service";
import { ELECTION_PROBE_MS, MDNS_SERVICE_TYPE } from "./constants.js";

export interface DiscoveredCoordinator {
  host: string;
  port: number;
  epoch: number;
}

/**
 * The sender's actual IP (from the mDNS response packet itself) beats the
 * advertised hostname whenever it's available — `service.host` is always
 * the literal string "anydrop.local" (see advertiseCoordinator below),
 * which depends on the *client's* OS having a working mDNS resolver to be
 * useful at all, unlike a real IP. Used both for the initial one-shot
 * probe and election.ts's ongoing background watch — those used to
 * resolve hosts differently (the watch fell back to the advertised name
 * a probe would have avoided), harmless while nothing ever re-read a
 * live update, but a real bug now that onHostChange means a client can
 * reconnect based on it.
 */
export function resolveServiceHost(service: Service): string {
  return service.referer?.address ?? service.host ?? "anydrop.local";
}

/** Browses for an existing coordinator for up to `timeoutMs`. Resolves null if none answers. */
export function probeForCoordinator(bonjour: Bonjour, timeoutMs = ELECTION_PROBE_MS): Promise<DiscoveredCoordinator | null> {
  return new Promise((resolve) => {
    const browser = bonjour.find({ type: MDNS_SERVICE_TYPE }, (service: Service) => {
      const epoch = Number(service.txt?.epoch ?? 0);
      const host = resolveServiceHost(service);
      const port = service.port;
      clearTimeout(timer);
      browser.stop();
      resolve({ host, port, epoch });
    });
    const timer = setTimeout(() => {
      browser.stop();
      resolve(null);
    }, timeoutMs);
  });
}

/**
 * Advertises this instance as the coordinator, bound to `anydrop.local`.
 * bonjour-service auto-detects and publishes A records for every non-
 * internal network interface address under that host name — no need to
 * pass addresses explicitly.
 */
export function advertiseCoordinator(bonjour: Bonjour, port: number, epoch: number): Service {
  return bonjour.publish({
    name: "Anydrop Coordinator",
    type: MDNS_SERVICE_TYPE,
    host: "anydrop.local",
    port,
    txt: { epoch: String(epoch) },
  });
}
