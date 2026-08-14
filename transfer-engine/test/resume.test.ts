import { describe, expect, it, vi } from "vitest";
import { MemoryResumeStore, resumeFromChunk } from "../src/resume.js";
import type { FileMeta } from "../src/types.js";

const meta: FileMeta = { fileId: "f1", name: "a", size: 300, mimeType: "text/plain", chunkSize: 100, totalChunks: 3 };

describe("resumeFromChunk", () => {
  it("returns 0 when nothing received", () => {
    expect(resumeFromChunk([])).toBe(0);
  });

  it("returns the first gap, ignoring out-of-order later indices", () => {
    expect(resumeFromChunk([0, 1, 3, 4])).toBe(2);
  });

  it("returns totalReceived when contiguous from zero", () => {
    expect(resumeFromChunk([0, 1, 2])).toBe(3);
  });
});

describe("MemoryResumeStore", () => {
  it("round-trips save/load and clear", async () => {
    const store = new MemoryResumeStore();
    expect(await store.load("f1")).toBeNull();
    await store.save({ fileMeta: meta, receivedChunkIndices: [0], chunkHashes: { 0: "h0" }, updatedAt: Date.now() });
    const loaded = await store.load("f1");
    expect(loaded?.receivedChunkIndices).toEqual([0]);
    await store.clear("f1");
    expect(await store.load("f1")).toBeNull();
  });

  it("expires state older than the TTL", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryResumeStore();
      await store.save({ fileMeta: meta, receivedChunkIndices: [0], chunkHashes: {}, updatedAt: Date.now() });
      vi.advanceTimersByTime(61 * 60 * 1000);
      expect(await store.load("f1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
