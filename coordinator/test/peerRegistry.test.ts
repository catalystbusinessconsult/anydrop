import { describe, expect, it } from "vitest";
import { PeerRegistry } from "../src/peerRegistry.js";

describe("PeerRegistry", () => {
  it("registers and lists peers, excluding the asking peer from listExcept", () => {
    const registry = new PeerRegistry();
    registry.register("d1", "Alice", "laptop", Symbol());
    registry.register("d2", "Bob", "phone", Symbol());

    expect(registry.size()).toBe(2);
    expect(registry.list().map((p) => p.deviceId).sort()).toEqual(["d1", "d2"]);
    expect(registry.listExcept("d1").map((p) => p.deviceId)).toEqual(["d2"]);
  });

  it("rejects nothing itself, but has() reflects duplicate registration attempts", () => {
    const registry = new PeerRegistry();
    registry.register("d1", "Alice", "laptop", Symbol());
    expect(registry.has("d1")).toBe(true);
    expect(registry.has("d2")).toBe(false);
  });

  it("touchHeartbeat updates lastHeartbeatAt", () => {
    const registry = new PeerRegistry();
    registry.register("d1", "Alice", "laptop", Symbol(), 1000);
    registry.touchHeartbeat("d1", 5000);
    expect(registry.get("d1")?.lastHeartbeatAt).toBe(5000);
  });

  it("findStale returns peers past the timeout and leaves fresh ones", () => {
    const registry = new PeerRegistry();
    registry.register("stale", "Old", "laptop", Symbol(), 0);
    registry.register("fresh", "New", "laptop", Symbol(), 9000);
    const stale = registry.findStale(15_000, 20_000);
    expect(stale.map((p) => p.deviceId)).toEqual(["stale"]);
  });

  it("removeByConnection removes the right peer and returns its deviceId", () => {
    const registry = new PeerRegistry();
    const connA = Symbol("a");
    const connB = Symbol("b");
    registry.register("d1", "Alice", "laptop", connA);
    registry.register("d2", "Bob", "phone", connB);

    const removed = registry.removeByConnection(connA);
    expect(removed).toBe("d1");
    expect(registry.has("d1")).toBe(false);
    expect(registry.has("d2")).toBe(true);
  });

  it("removeByConnection returns null for an unknown connection", () => {
    const registry = new PeerRegistry();
    expect(registry.removeByConnection(Symbol("unknown"))).toBeNull();
  });
});
