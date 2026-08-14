import type { DiskWriter, FileMeta } from "../types.js";

const DB_NAME = "cbc-lan-share";
const STORE = "chunks";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * iOS Safari has no streaming-write-to-disk API, so chunks are staged in
 * IndexedDB as they arrive (bounded by device storage, not RAM) and
 * assembled into a single Blob only at finalize(), which is then handed to
 * the browser's normal download flow. This is the documented iOS
 * constraint from the project spec — flagged again in docs/testing-matrix.md.
 */
export class IndexedDbWriter implements DiskWriter {
  private meta: FileMeta | null = null;
  private db: IDBDatabase | null = null;

  async open(meta: FileMeta): Promise<void> {
    this.meta = meta;
    this.db = await openDb();
  }

  private key(index: number): string {
    return `${this.meta!.fileId}:${index}`;
  }

  async writeChunk(index: number, data: Uint8Array): Promise<void> {
    if (!this.db || !this.meta) throw new Error("not opened");
    const db = this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ key: this.key(index), fileId: this.meta!.fileId, index, data });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async hasChunk(index: number): Promise<boolean> {
    if (!this.db || !this.meta) return false;
    const db = this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(this.key(index));
      req.onsuccess = () => resolve(!!req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Assembles all chunks into one Blob and triggers a browser download. */
  async finalize(): Promise<void> {
    if (!this.db || !this.meta) throw new Error("not opened");
    const meta = this.meta;
    const db = this.db;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < meta.totalChunks; i++) {
      const chunk = await new Promise<Uint8Array>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(`${meta.fileId}:${i}`);
        req.onsuccess = () => {
          if (!req.result) reject(new Error(`missing chunk ${i}`));
          else resolve(req.result.data);
        };
        req.onerror = () => reject(req.error);
      });
      parts.push(chunk);
    }
    const blob = new Blob(parts as BlobPart[], { type: meta.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = meta.name;
    a.click();
    URL.revokeObjectURL(url);
    await this.clearChunks();
  }

  async abort(): Promise<void> {
    await this.clearChunks();
  }

  private async clearChunks(): Promise<void> {
    if (!this.db || !this.meta) return;
    const meta = this.meta;
    const db = this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      for (let i = 0; i < meta.totalChunks; i++) tx.objectStore(STORE).delete(`${meta.fileId}:${i}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
