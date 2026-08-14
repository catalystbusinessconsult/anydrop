import type { DiskWriter, FileMeta } from "../types.js";

/**
 * Positional-write DiskWriter for the Tauri desktop app, via the
 * `@tauri-apps/plugin-fs` sidecar API. Structurally complete against the
 * Tauri v2 fs plugin surface, but not build-verified in this environment
 * (no Rust/Tauri toolchain here — see desktop/README.md).
 */
export interface TauriFsHandleLike {
  write(data: Uint8Array, opts: { position: number }): Promise<number>;
  close(): Promise<void>;
}

export type TauriFsOpenFn = (path: string, opts: { write: true; create: true }) => Promise<TauriFsHandleLike>;

export class TauriFsWriter implements DiskWriter {
  private handle: TauriFsHandleLike | null = null;
  private meta: FileMeta | null = null;

  constructor(
    private readonly path: string,
    private readonly openFile: TauriFsOpenFn,
  ) {}

  async open(meta: FileMeta): Promise<void> {
    this.meta = meta;
    this.handle = await this.openFile(this.path, { write: true, create: true });
  }

  async writeChunk(index: number, data: Uint8Array): Promise<void> {
    if (!this.handle || !this.meta) throw new Error("not opened");
    const position = index * this.meta.chunkSize;
    await this.handle.write(data, { position });
  }

  async finalize(): Promise<void> {
    await this.handle?.close();
    this.handle = null;
  }

  async abort(): Promise<void> {
    await this.handle?.close();
    this.handle = null;
  }
}
