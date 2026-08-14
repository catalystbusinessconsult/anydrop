import type { DiskWriter, FileMeta } from "../types.js";

/**
 * Streams chunks straight to disk via the File System Access API
 * (desktop Chrome/Edge, and the Tauri webview). Writes are positional so
 * out-of-order or resumed chunks land at the right offset without buffering
 * the whole file in memory.
 */
export class FileSystemAccessWriter implements DiskWriter {
  private handle: FileSystemFileHandle | null = null;
  private stream: FileSystemWritableFileStream | null = null;
  private meta: FileMeta | null = null;

  /** Caller obtains the handle via window.showSaveFilePicker() (needs a user gesture). */
  constructor(handle: FileSystemFileHandle) {
    this.handle = handle;
  }

  async open(meta: FileMeta): Promise<void> {
    if (!this.handle) throw new Error("no file handle");
    this.meta = meta;
    // keepExistingData lets a resumed transfer reopen the partial file
    // without truncating bytes already written from a prior session.
    this.stream = await this.handle.createWritable({ keepExistingData: true });
  }

  async writeChunk(index: number, data: Uint8Array): Promise<void> {
    if (!this.stream || !this.meta) throw new Error("not opened");
    const position = index * this.meta.chunkSize;
    await this.stream.write({ type: "write", position, data: data as unknown as BufferSource });
  }

  async finalize(): Promise<void> {
    await this.stream?.close();
    this.stream = null;
  }

  async abort(): Promise<void> {
    try {
      await this.stream?.abort();
    } finally {
      this.stream = null;
    }
  }
}

export async function pickSaveHandle(suggestedName: string): Promise<FileSystemFileHandle> {
  if (!("showSaveFilePicker" in window)) {
    throw new Error("File System Access API unavailable in this browser");
  }
  return await (window as unknown as {
    showSaveFilePicker(opts: { suggestedName: string }): Promise<FileSystemFileHandle>;
  }).showSaveFilePicker({ suggestedName });
}
