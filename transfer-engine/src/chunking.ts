import { DEFAULT_CHUNK_SIZE, type FileMeta, type FileSource } from "./types.js";

/**
 * Deterministic per file-pair id, so re-attempting the same file between
 * the same two devices maps to the same fileId and resume lookups work
 * even though nothing is persisted on the coordinator.
 */
export async function computeFileId(
  source: Pick<FileSource, "name" | "size" | "type">,
  senderDeviceId: string,
  receiverDeviceId: string,
): Promise<string> {
  const key = `${senderDeviceId}:${receiverDeviceId}:${source.name}:${source.size}:${source.type}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key) as unknown as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

export function totalChunksFor(size: number, chunkSize: number): number {
  return size === 0 ? 0 : Math.ceil(size / chunkSize);
}

export async function buildFileMeta(
  source: FileSource,
  senderDeviceId: string,
  receiverDeviceId: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<FileMeta> {
  const fileId = await computeFileId(source, senderDeviceId, receiverDeviceId);
  return {
    fileId,
    name: source.name,
    size: source.size,
    mimeType: source.type || "application/octet-stream",
    chunkSize,
    totalChunks: totalChunksFor(source.size, chunkSize),
  };
}

export function chunkBounds(index: number, meta: Pick<FileMeta, "size" | "chunkSize">): [start: number, end: number] {
  const start = index * meta.chunkSize;
  const end = Math.min(start + meta.chunkSize, meta.size);
  return [start, end];
}

export async function readChunk(source: FileSource, index: number, meta: Pick<FileMeta, "size" | "chunkSize">): Promise<Uint8Array> {
  const [start, end] = chunkBounds(index, meta);
  return source.slice(start, end);
}

/** Wraps a plain byte array as a FileSource, for tests and small in-memory sends. */
export function bytesAsFileSource(name: string, type: string, bytes: Uint8Array): FileSource {
  return {
    name,
    size: bytes.byteLength,
    type,
    async slice(start: number, end: number): Promise<Uint8Array> {
      return bytes.subarray(start, Math.min(end, bytes.byteLength));
    },
  };
}

/** Wraps a browser Blob/File as a FileSource. */
export function blobAsFileSource(blob: Blob & { name?: string }): FileSource {
  return {
    name: blob.name ?? "file",
    size: blob.size,
    type: blob.type,
    async slice(start: number, end: number): Promise<Uint8Array> {
      const buf = await blob.slice(start, end).arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}
