/** Default chunk size for file transfer, within the 64-256KB target range. */
export const DEFAULT_CHUNK_SIZE = 128 * 1024;

/** High-water mark for RTCDataChannel.bufferedAmount before pausing sends. */
export const BACKPRESSURE_HIGH_WATER_MARK = 4 * 1024 * 1024;
/** Threshold at which 'bufferedamountlow' fires and sending resumes. */
export const BACKPRESSURE_LOW_WATER_MARK = 1 * 1024 * 1024;

export interface FileMeta {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
}

/** Platform-agnostic readable source for a file to be sent. */
export interface FileSource {
  name: string;
  size: number;
  type: string;
  /** Read bytes in [start, end). end is exclusive, clamped to size. */
  slice(start: number, end: number): Promise<Uint8Array>;
}

/** Abstraction over "write bytes to durable storage," one impl per platform. */
export interface DiskWriter {
  open(meta: FileMeta): Promise<void>;
  writeChunk(index: number, data: Uint8Array): Promise<void>;
  finalize(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

/** Subset of RTCDataChannel this package depends on — lets tests use a fake. */
export interface DataChannelLike {
  readonly readyState: "connecting" | "open" | "closing" | "closed";
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onbufferedamountlow: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  send(data: ArrayBuffer): void;
  send(data: Uint8Array): void;
  close(): void;
}

export interface ResumeState {
  fileMeta: FileMeta;
  /** Sorted, de-duplicated indices of chunks durably written so far. */
  receivedChunkIndices: number[];
  /** chunkIndex -> base64 sha-256 of that chunk's bytes. */
  chunkHashes: Record<number, string>;
  updatedAt: number;
}

export interface ResumeStore {
  load(fileId: string): Promise<ResumeState | null>;
  save(state: ResumeState): Promise<void>;
  clear(fileId: string): Promise<void>;
}

export type TransferControlMessage =
  | { type: "transfer-offer"; meta: FileMeta }
  | { type: "transfer-accept"; fileId: string; resumeFromChunk: number }
  | { type: "transfer-reject"; fileId: string; reason: string }
  | { type: "chunk-ack"; fileId: string; upToChunk: number }
  | { type: "transfer-complete"; fileId: string; fileHash: string }
  | { type: "transfer-verified"; fileId: string; ok: boolean }
  | { type: "transfer-abort"; fileId: string; reason: string };

export interface TransferProgress {
  fileId: string;
  bytesTransferred: number;
  totalBytes: number;
  chunksTransferred: number;
  totalChunks: number;
}

export type TransferEvent =
  | { kind: "progress"; progress: TransferProgress }
  | { kind: "complete"; fileId: string }
  | { kind: "error"; fileId: string; message: string }
  | { kind: "rejected"; fileId: string; reason: string }
  | { kind: "cancelled"; fileId: string };
