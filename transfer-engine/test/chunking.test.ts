import { describe, expect, it } from "vitest";
import { bytesAsFileSource, buildFileMeta, chunkBounds, computeFileId, readChunk, totalChunksFor } from "../src/chunking.js";

describe("chunking", () => {
  it("totalChunksFor rounds up, and is 0 for an empty file", () => {
    expect(totalChunksFor(0, 100)).toBe(0);
    expect(totalChunksFor(1, 100)).toBe(1);
    expect(totalChunksFor(100, 100)).toBe(1);
    expect(totalChunksFor(101, 100)).toBe(2);
  });

  it("chunkBounds clamps the final chunk to file size", () => {
    expect(chunkBounds(0, { size: 250, chunkSize: 100 })).toEqual([0, 100]);
    expect(chunkBounds(2, { size: 250, chunkSize: 100 })).toEqual([200, 250]);
  });

  it("computeFileId is stable for the same (sender, receiver, file) and differs otherwise", async () => {
    const source = { name: "a.txt", size: 10, type: "text/plain" };
    const id1 = await computeFileId(source, "s1", "r1");
    const id2 = await computeFileId(source, "s1", "r1");
    const id3 = await computeFileId(source, "s2", "r1");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });

  it("buildFileMeta + readChunk round-trips real bytes", async () => {
    const bytes = new Uint8Array(250).map((_, i) => i % 256);
    const source = bytesAsFileSource("f.bin", "application/octet-stream", bytes);
    const meta = await buildFileMeta(source, "s", "r", 100);
    expect(meta.totalChunks).toBe(3);
    const chunk2 = await readChunk(source, 2, meta);
    expect(chunk2).toEqual(bytes.subarray(200, 250));
  });
});
