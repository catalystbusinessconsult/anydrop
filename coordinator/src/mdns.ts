import { Bonjour, type Service } from "bonjour-service";
import { ELECTION_PROBE_MS, MDNS_SERVICE_TYPE } from "./constants.js";

export interface DiscoveredCoordinator {
  host: string;
  port: number;
  epoch: number;
}

/** Browses for an existing coordinator for up to `timeoutMs`. Resolves null if none answers. */
export function probeForCoordinator(bonjour: Bonjour, timeoutMs = ELECTION_PROBE_MS): Promise<DiscoveredCoordinator | null> {
  return new Promise((resolve) => {
    const browser = bonjour.find({ type: MDNS_SERVICE_TYPE }, (service: Service) => {
      const epoch = Number(service.txt?.epoch ?? 0);
      const host = service.referer?.address ?? service.host ?? "cbcshare.local";
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
 * Advertises this instance as the coordinator, bound to `cbcshare.local`.
 * bonjour-service auto-detects and publishes A records for every non-
 * internal network interface address under that host name — no need to
 * pass addresses explicitly.
 */
export function advertiseCoordinator(bonjour: Bonjour, port: number, epoch: number): Service {
  return bonjour.publish({
    name: "CBC LAN Share Coordinator",
    type: MDNS_SERVICE_TYPE,
    host: "cbcshare.local",
    port,
    txt: { epoch: String(epoch) },
  });
}
