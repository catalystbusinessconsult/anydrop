import { networkInterfaces } from "node:os";

/** RFC1918 private ranges + link-local + loopback, per docs/security.md §1. */
export function isPrivateOrLoopbackIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return true;
  return false;
}

/** Real LAN-reachable addresses (excludes loopback) — what mDNS advertises to other devices. */
export function listLanAddresses(): string[] {
  const nets = networkInterfaces();
  const addresses: string[] = [];
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === "IPv4" && !info.internal && isPrivateOrLoopbackIPv4(info.address)) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}

/** Addresses the WebSocket server actually binds: LAN addresses plus loopback for same-machine/dev use. */
export function listBindAddresses(): string[] {
  return [...listLanAddresses(), "127.0.0.1"];
}

/** Gate applied to every incoming connection's remote address, per docs/security.md §1. */
export function isAllowedRemoteAddress(address: string): boolean {
  // Strip an IPv4-mapped IPv6 prefix (::ffff:192.168.1.5), which Node reports for dual-stack sockets.
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (normalized === "::1") return true; // IPv6 loopback
  return isPrivateOrLoopbackIPv4(normalized);
}
