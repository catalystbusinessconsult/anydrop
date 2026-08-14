import type { DeviceType, PeerInfo } from "./protocol.js";

export interface RegisteredPeer extends PeerInfo {
  lastHeartbeatAt: number;
  /** Opaque handle back to the transport (a WebSocket instance in production, a fake in tests). */
  connectionId: symbol;
}

/**
 * Pure in-memory peer state, deliberately decoupled from `ws` so the
 * heartbeat/timeout/register logic (the interesting part) is unit-testable
 * without opening real sockets.
 */
export class PeerRegistry {
  private peers = new Map<string, RegisteredPeer>();

  register(deviceId: string, nickname: string, deviceType: DeviceType, connectionId: symbol, now = Date.now()): void {
    this.peers.set(deviceId, { deviceId, nickname, deviceType, lastHeartbeatAt: now, connectionId });
  }

  has(deviceId: string): boolean {
    return this.peers.has(deviceId);
  }

  get(deviceId: string): RegisteredPeer | undefined {
    return this.peers.get(deviceId);
  }

  touchHeartbeat(deviceId: string, now = Date.now()): void {
    const peer = this.peers.get(deviceId);
    if (peer) peer.lastHeartbeatAt = now;
  }

  remove(deviceId: string): void {
    this.peers.delete(deviceId);
  }

  removeByConnection(connectionId: symbol): string | null {
    for (const peer of this.peers.values()) {
      if (peer.connectionId === connectionId) {
        this.peers.delete(peer.deviceId);
        return peer.deviceId;
      }
    }
    return null;
  }

  /** Peers whose last heartbeat is older than `timeoutMs` — caller evicts + broadcasts peer-left. */
  findStale(timeoutMs: number, now = Date.now()): RegisteredPeer[] {
    return [...this.peers.values()].filter((p) => now - p.lastHeartbeatAt > timeoutMs);
  }

  listExcept(deviceId: string): PeerInfo[] {
    return [...this.peers.values()]
      .filter((p) => p.deviceId !== deviceId)
      .map(({ deviceId, nickname, deviceType }) => ({ deviceId, nickname, deviceType }));
  }

  list(): PeerInfo[] {
    return [...this.peers.values()].map(({ deviceId, nickname, deviceType }) => ({ deviceId, nickname, deviceType }));
  }

  size(): number {
    return this.peers.size;
  }
}
