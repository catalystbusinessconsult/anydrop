import { buildFileMeta, readChunk } from "./chunking.js";
import { finalFileHash, hashChunk, hashOfHashes } from "./hash.js";
import { createMessageBus, decodeChunkFrame, encodeChunkFrame, type MessageBus } from "./messageBus.js";
import { resumeFromChunk } from "./resume.js";
import type {
  DataChannelLike,
  DiskWriter,
  FileMeta,
  FileSource,
  ResumeState,
  ResumeStore,
  TransferControlMessage,
  TransferEvent,
} from "./types.js";

function isControlMessage(msg: unknown): msg is TransferControlMessage {
  return typeof msg === "object" && msg !== null && typeof (msg as { type?: unknown }).type === "string";
}

async function waitForControl<T extends TransferControlMessage["type"]>(
  bus: MessageBus,
  type: T,
  fileId: string,
  timeoutMs = 30_000,
): Promise<Extract<TransferControlMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    const unsubscribe = bus.onJson((msg) => {
      if (!isControlMessage(msg)) return;
      if (msg.type === type && "fileId" in msg && msg.fileId === fileId) {
        clearTimeout(timer);
        unsubscribe();
        resolve(msg as Extract<TransferControlMessage, { type: T }>);
      }
      if (msg.type === "transfer-reject" && msg.fileId === fileId && type !== "transfer-reject") {
        clearTimeout(timer);
        unsubscribe();
        reject(new RejectedError(msg.fileId, msg.reason));
      }
      if (msg.type === "transfer-abort" && msg.fileId === fileId) {
        clearTimeout(timer);
        unsubscribe();
        reject(new CancelledError(msg.fileId));
      }
    });
  });
}

/** Never settles unless/until `signal` aborts, then rejects — a Promise.race participant. */
function waitForAbortSignal(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(new CancelledError());
      return;
    }
    signal.addEventListener("abort", () => reject(new CancelledError()), { once: true });
  });
}

export class RejectedError extends Error {
  constructor(
    public readonly fileId: string,
    public readonly reason: string,
  ) {
    super(`transfer rejected: ${reason}`);
  }
}

export class CancelledError extends Error {
  constructor(public readonly fileId?: string) {
    super("transfer cancelled");
  }
}

export interface SendOptions {
  onEvent?: (event: TransferEvent) => void;
  /** Abort to cancel a send in progress — cleanly notifies the receiver via transfer-abort. */
  signal?: AbortSignal;
}

/**
 * Sends `source` to the peer at the other end of `channel`. Resolves once
 * the receiver has verified the final hash. Skipped-but-still-hashed
 * chunks (already durably written on a resumed transfer) are re-read and
 * re-hashed locally so the final file hash always covers every chunk, even
 * though only the missing ones are put on the wire.
 */
export async function sendFile(
  channel: DataChannelLike,
  source: FileSource,
  senderDeviceId: string,
  receiverDeviceId: string,
  opts: SendOptions = {},
): Promise<void> {
  const bus = createMessageBus(channel);
  const meta = await buildFileMeta(source, senderDeviceId, receiverDeviceId);

  // Cancellation can come from this side (opts.signal) or the other side
  // (an incoming transfer-abort) — both funnel through the same check so
  // the send loop only needs one guard.
  let remoteAborted = false;
  const unsubscribeRemoteAbort = bus.onJson((msg) => {
    if (isControlMessage(msg) && msg.type === "transfer-abort" && "fileId" in msg && msg.fileId === meta.fileId) {
      remoteAborted = true;
    }
  });

  async function bailIfCancelled(): Promise<boolean> {
    if (!opts.signal?.aborted && !remoteAborted) return false;
    if (!remoteAborted) {
      bus.sendJson({ type: "transfer-abort", fileId: meta.fileId, reason: "cancelled by sender" } satisfies TransferControlMessage);
    }
    opts.onEvent?.({ kind: "cancelled", fileId: meta.fileId });
    return true;
  }

  try {
    bus.sendJson({ type: "transfer-offer", meta } satisfies TransferControlMessage);

    let resumeFrom = 0;
    try {
      const accept = await Promise.race([waitForControl(bus, "transfer-accept", meta.fileId), waitForAbortSignal(opts.signal)]);
      resumeFrom = accept.resumeFromChunk;
    } catch (err) {
      if (err instanceof RejectedError) {
        opts.onEvent?.({ kind: "rejected", fileId: meta.fileId, reason: err.reason });
        return;
      }
      if (err instanceof CancelledError) {
        await bailIfCancelled();
        return;
      }
      throw err;
    }

    const chunkHashes: string[] = new Array(meta.totalChunks);
    for (let i = 0; i < meta.totalChunks; i++) {
      if (await bailIfCancelled()) return;
      const bytes = await readChunk(source, i, meta);
      chunkHashes[i] = await hashChunk(bytes);
      if (i >= resumeFrom) {
        await bus.waitForBufferDrain();
        if (await bailIfCancelled()) return;
        bus.sendBinary(encodeChunkFrame(i, bytes));
        opts.onEvent?.({
          kind: "progress",
          progress: {
            fileId: meta.fileId,
            bytesTransferred: Math.min((i + 1) * meta.chunkSize, meta.size),
            totalBytes: meta.size,
            chunksTransferred: i + 1,
            totalChunks: meta.totalChunks,
          },
        });
      }
    }
    if (await bailIfCancelled()) return;

    const fileHash = await hashOfHashes(chunkHashes);
    bus.sendJson({ type: "transfer-complete", fileId: meta.fileId, fileHash } satisfies TransferControlMessage);

    let verified: Extract<TransferControlMessage, { type: "transfer-verified" }>;
    try {
      verified = await waitForControl(bus, "transfer-verified", meta.fileId);
    } catch (err) {
      if (err instanceof CancelledError) {
        await bailIfCancelled();
        return;
      }
      throw err;
    }
    if (!verified.ok) {
      opts.onEvent?.({ kind: "error", fileId: meta.fileId, message: "receiver failed hash verification" });
      throw new Error("transfer failed hash verification on receiver");
    }
    opts.onEvent?.({ kind: "complete", fileId: meta.fileId });
  } finally {
    unsubscribeRemoteAbort();
  }
}

export interface ReceiveOptions {
  /** Decide whether to accept an incoming offer — show the accept/reject UI. */
  confirm: (meta: FileMeta) => Promise<boolean>;
  onEvent?: (event: TransferEvent) => void;
  /** How often (in chunks) to persist resume state. */
  checkpointEveryChunks?: number;
  /** Abort to cancel a receive in progress — cleanly notifies the sender via transfer-abort. */
  signal?: AbortSignal;
}

/** Listens on `channel` for exactly one incoming transfer offer and handles it end to end. */
export async function receiveFile(
  channel: DataChannelLike,
  writerFactory: (meta: FileMeta) => DiskWriter,
  resumeStore: ResumeStore,
  opts: ReceiveOptions,
): Promise<FileMeta> {
  const bus = createMessageBus(channel);
  const checkpointEvery = opts.checkpointEveryChunks ?? 16;

  const offerMsg = await new Promise<Extract<TransferControlMessage, { type: "transfer-offer" }>>((resolve) => {
    const unsubscribe = bus.onJson((msg) => {
      if (isControlMessage(msg) && msg.type === "transfer-offer") {
        unsubscribe();
        resolve(msg);
      }
    });
  });
  const meta = offerMsg.meta;

  // A sender-side cancel can arrive at any point from here on — including
  // while opts.confirm() is still awaiting a human decision, which can take
  // arbitrarily long. One subscription spans the whole function so that
  // window is never a gap where an incoming transfer-abort gets silently
  // dropped for lack of a listener; onRemoteAbort is swapped to the
  // in-progress handler once the main processing loop is set up below.
  let onRemoteAbort: (reason: string) => void = (reason) => {
    pendingRemoteAbortReason = reason;
  };
  let pendingRemoteAbortReason: string | null = null;
  const unsubscribeRemoteAbort = bus.onJson((msg) => {
    if (isControlMessage(msg) && msg.type === "transfer-abort" && "fileId" in msg && msg.fileId === meta.fileId) {
      onRemoteAbort(msg.reason);
    }
  });

  try {
    const accepted = await opts.confirm(meta);
    if (pendingRemoteAbortReason !== null) {
      opts.onEvent?.({ kind: "cancelled", fileId: meta.fileId });
      return meta;
    }
    if (!accepted) {
      bus.sendJson({ type: "transfer-reject", fileId: meta.fileId, reason: "declined by user" } satisfies TransferControlMessage);
      return meta;
    }

    const existing = await resumeStore.load(meta.fileId);
    const startFrom = existing ? resumeFromChunk(existing.receivedChunkIndices) : 0;
    const chunkHashes: Record<number, string> = existing?.chunkHashes ?? {};
    const receivedIndices = new Set<number>(existing?.receivedChunkIndices ?? []);

    const writer = writerFactory(meta);
    await writer.open(meta);
    if (pendingRemoteAbortReason !== null) {
      await writer.abort(pendingRemoteAbortReason);
      opts.onEvent?.({ kind: "cancelled", fileId: meta.fileId });
      return meta;
    }

    bus.sendJson({ type: "transfer-accept", fileId: meta.fileId, resumeFromChunk: startFrom } satisfies TransferControlMessage);

    await new Promise<void>((resolve, reject) => {
      let sinceCheckpoint = 0;
      let settled = false;
      // Chunk frames arrive faster than writeChunk+hashChunk can complete
      // for each one, so processing is serialized through this queue rather
      // than fired off independently — otherwise a later control message
      // (e.g. transfer-complete) can race ahead of in-flight writes for the
      // last few chunks and see an incomplete chunkHashes map.
      let processingQueue: Promise<void> = Promise.resolve();

      function finish(action: () => void): void {
        if (settled) return;
        settled = true;
        unsubscribeBinary();
        unsubscribeJson();
        opts.signal?.removeEventListener("abort", onLocalAbort);
        action();
      }

      const unsubscribeBinary = bus.onBinary((frame) => {
        processingQueue = processingQueue.then(async () => {
          // Chunks already chained onto processingQueue when a terminal
          // state (cancelled/complete/error) is reached keep draining
          // regardless — unsubscribeBinary() only stops *new* chunks from
          // being queued. A handler already past this first check when
          // settled flips true (mid-await, e.g. inside writeChunk/hashChunk)
          // would otherwise still fire its progress event afterward, so
          // it's checked again immediately before that emit too — without
          // both checks, either one alone leaves a window where a trailing
          // chunk overwrites the terminal event with no further event ever
          // correcting it.
          if (settled) return;
          const { index, data } = decodeChunkFrame(frame);
          if (receivedIndices.has(index)) return;
          await writer.writeChunk(index, data);
          chunkHashes[index] = await hashChunk(data);
          if (settled) return;
          receivedIndices.add(index);
          sinceCheckpoint++;
          opts.onEvent?.({
            kind: "progress",
            progress: {
              fileId: meta.fileId,
              // receivedIndices.size * chunkSize overcounts once the final
              // (possibly smaller) chunk is in, since every chunk but the
              // last is exactly chunkSize — clamp to the real file size.
              bytesTransferred: Math.min(receivedIndices.size * meta.chunkSize, meta.size),
              totalBytes: meta.size,
              chunksTransferred: receivedIndices.size,
              totalChunks: meta.totalChunks,
            },
          });
          if (sinceCheckpoint >= checkpointEvery) {
            sinceCheckpoint = 0;
            await saveCheckpoint();
          }
        });
        processingQueue.catch((err) => finish(() => reject(err)));
      });

      async function saveCheckpoint(): Promise<void> {
        const state: ResumeState = {
          fileMeta: meta,
          receivedChunkIndices: [...receivedIndices].sort((a, b) => a - b),
          chunkHashes,
          updatedAt: Date.now(),
        };
        await resumeStore.save(state);
      }

      function onLocalAbort(): void {
        bus.sendJson({ type: "transfer-abort", fileId: meta.fileId, reason: "cancelled by receiver" } satisfies TransferControlMessage);
        void processingQueue
          .catch(() => {})
          .then(() => writer.abort("cancelled by receiver"))
          .then(() =>
            finish(() => {
              opts.onEvent?.({ kind: "cancelled", fileId: meta.fileId });
              resolve();
            }),
          )
          .catch((err) => finish(() => reject(err)));
      }
      opts.signal?.addEventListener("abort", onLocalAbort);
      if (opts.signal?.aborted) onLocalAbort();

      // From here on, an incoming transfer-abort resolves the transfer
      // (instead of just recording a flag, as it did during the confirm()/
      // writer.open() window above).
      onRemoteAbort = (reason) => {
        void processingQueue
          .catch(() => {})
          .then(() => writer.abort(reason))
          .then(saveCheckpoint)
          .then(() =>
            finish(() => {
              opts.onEvent?.({ kind: "cancelled", fileId: meta.fileId });
              resolve();
            }),
          )
          .catch((err) => finish(() => reject(err)));
      };
      if (pendingRemoteAbortReason !== null) onRemoteAbort(pendingRemoteAbortReason);

      const unsubscribeJson = bus.onJson((msg) => {
        if (!isControlMessage(msg) || !("fileId" in msg) || msg.fileId !== meta.fileId || msg.type !== "transfer-complete") return;
        void (async () => {
          try {
            await processingQueue;
            const computed = await finalFileHash(chunkHashes, meta.totalChunks);
            const ok = computed === msg.fileHash;
            bus.sendJson({ type: "transfer-verified", fileId: meta.fileId, ok } satisfies TransferControlMessage);
            if (ok) {
              await writer.finalize();
              await resumeStore.clear(meta.fileId);
              finish(() => {
                opts.onEvent?.({ kind: "complete", fileId: meta.fileId });
                resolve();
              });
            } else {
              await writer.abort("hash mismatch");
              finish(() => {
                opts.onEvent?.({ kind: "error", fileId: meta.fileId, message: "hash mismatch" });
                reject(new Error("hash mismatch"));
              });
            }
          } catch (err) {
            finish(() => reject(err));
          }
        })();
      });
    });
  } finally {
    unsubscribeRemoteAbort();
  }

  return meta;
}
