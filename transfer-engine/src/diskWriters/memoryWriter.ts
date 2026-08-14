import type { DiskWriter, FileMeta } from "../types.js";

/** In-memory DiskWriter for unit tests — never used in production. */
export class MemoryDiskWriter implements DiskWriter {
  private chunks = new Map<number, Uint8Array>();
  private meta: FileMeta | null = null;
  aborted = false;
  finalized = false;

  async open(meta: FileMeta): Promise<void> {
    this.meta = meta;
  }

  async writeChunk(index: number, data: Uint8Array): Promise<void> {
    this.chunks.set(index, data);
  }

  async finalize(): Promise<void> {
    this.finalized = true;
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  assemble(): Uint8Array {
    if (!this.meta) throw new Error("not opened");
    const out = new Uint8Array(this.meta.size);
    let offset = 0;
    for (let i = 0; i < this.meta.totalChunks; i++) {
      const chunk = this.chunks.get(i);
      if (!chunk) throw new Error(`missing chunk ${i}`);
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  has(index: number): boolean {
    return this.chunks.has(index);
  }
}
