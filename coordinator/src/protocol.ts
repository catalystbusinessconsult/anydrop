// Mirrors docs/protocol.md §3 exactly — this file IS the contract.

export type DeviceType = "laptop" | "phone";

export interface PeerInfo {
  deviceId: string;
  nickname: string;
  deviceType: DeviceType;
}

export type ClientMessage =
  | { type: "register"; deviceId: string; nickname: string; deviceType: DeviceType; protocolVersion: number }
  | { type: "signal"; to: string; payload: unknown }
  | { type: "heartbeat"; deviceId: string }
  | { type: "unregister"; deviceId: string }
  | { type: "coordinator-announce"; deviceId: string; epoch: number };

export type ServerMessage =
  | { type: "peer-list"; peers: PeerInfo[] }
  | { type: "signal"; from: string; payload: unknown }
  | { type: "peer-left"; deviceId: string }
  | { type: "heartbeat-ack"; deviceId: string; serverTime: number }
  // "duplicate-device" was dropped: a live re-register under the same
  // deviceId is treated as a reconnect (old connection replaced), not
  // rejected — see the "register" handler in server.ts.
  | { type: "register-rejected"; reason: "unsupported-version" };

export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
    return null;
  }
  return parsed as ClientMessage;
}
