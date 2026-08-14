import { describe, expect, it } from "vitest";
import { finalFileHash, hashChunk, hashOfHashes } from "../src/hash.js";

describe("hash", () => {
  it("hashChunk is deterministic and content-sensitive", async () => {
    const a = await hashChunk(new Uint8Array([1, 2, 3]));
    const b = await hashChunk(new Uint8Array([1, 2, 3]));
    const c = await hashChunk(new Uint8Array([1, 2, 4]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("hashOfHashes is order-sensitive", async () => {
    const h1 = await hashChunk(new Uint8Array([1]));
    const h2 = await hashChunk(new Uint8Array([2]));
    const forward = await hashOfHashes([h1, h2]);
    const reversed = await hashOfHashes([h2, h1]);
    expect(forward).not.toBe(reversed);
  });

  it("finalFileHash throws on a missing chunk hash", async () => {
    await expect(finalFileHash({ 0: "x" }, 2)).rejects.toThrow(/missing hash/);
  });

  it("finalFileHash matches hashOfHashes over the ordered chunk hashes", async () => {
    const h0 = await hashChunk(new Uint8Array([9, 9]));
    const h1 = await hashChunk(new Uint8Array([8, 8]));
    const expected = await hashOfHashes([h0, h1]);
    const actual = await finalFileHash({ 1: h1, 0: h0 }, 2);
    expect(actual).toBe(expected);
  });
});
