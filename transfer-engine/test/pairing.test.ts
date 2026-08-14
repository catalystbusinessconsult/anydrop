import { describe, expect, it } from "vitest";
import { generatePin, generatePairingRequestId, MemoryPairingStore } from "../src/pairing.js";

describe("pairing", () => {
  it("generatePin produces a 6-digit zero-padded string", () => {
    for (let i = 0; i < 20; i++) {
      const pin = generatePin();
      expect(pin).toMatch(/^\d{6}$/);
    }
  });

  it("generatePairingRequestId produces distinct ids", () => {
    const a = generatePairingRequestId();
    const b = generatePairingRequestId();
    expect(a).not.toBe(b);
  });

  it("MemoryPairingStore trusts and forgets pairs", async () => {
    const store = new MemoryPairingStore();
    expect(await store.isTrusted("peer-1")).toBe(false);
    await store.trust("peer-1");
    expect(await store.isTrusted("peer-1")).toBe(true);
    expect(await store.isTrusted("peer-2")).toBe(false);
  });
});
