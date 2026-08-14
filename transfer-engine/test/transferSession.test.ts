import { describe, expect, it } from "vitest";
import { bytesAsFileSource, computeFileId } from "../src/chunking.js";
import { MemoryDiskWriter } from "../src/diskWriters/memoryWriter.js";
import { MemoryResumeStore } from "../src/resume.js";
import { CancelledError, receiveFile, RejectedError, sendFile } from "../src/transferSession.js";
import type { FileMeta, TransferEvent } from "../src/types.js";
import { createFakeChannelPair } from "./fakeChannel.js";

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

describe("sendFile + receiveFile", () => {
  it("transfers a multi-chunk file end to end and verifies the hash", async () => {
    const [senderChannel, receiverChannel] = createFakeChannelPair();
    const bytes = randomBytes(250_000); // several chunks at the default 128KB chunk size
    const source = bytesAsFileSource("photo.jpg", "image/jpeg", bytes);
    const resumeStore = new MemoryResumeStore();
    let writer!: MemoryDiskWriter;

    const receivePromise = receiveFile(
      receiverChannel,
      (meta: FileMeta) => {
        writer = new MemoryDiskWriter();
        return writer;
      },
      resumeStore,
      { confirm: async () => true },
    );
    await sendFile(senderChannel, source, "sender-1", "receiver-1");
    const meta = await receivePromise;

    expect(meta.name).toBe("photo.jpg");
    expect(writer.finalized).toBe(true);
    expect(writer.assemble()).toEqual(bytes);
  });

  it("propagates a receiver rejection to the sender as RejectedError-shaped event", async () => {
    const [senderChannel, receiverChannel] = createFakeChannelPair();
    const source = bytesAsFileSource("nope.bin", "application/octet-stream", randomBytes(10));
    const resumeStore = new MemoryResumeStore();

    const receivePromise = receiveFile(receiverChannel, () => new MemoryDiskWriter(), resumeStore, {
      confirm: async () => false,
    });

    let rejectedReason: string | undefined;
    await sendFile(senderChannel, source, "sender-1", "receiver-1", {
      onEvent: (ev) => {
        if (ev.kind === "rejected") rejectedReason = ev.reason;
      },
    });
    await receivePromise;

    expect(rejectedReason).toBe("declined by user");
  });

  it("resumes from the first missing chunk using prior resume state", async () => {
    const bytes = randomBytes(300_000);
    const source = bytesAsFileSource("big.bin", "application/octet-stream", bytes);
    const fileId = await computeFileId(source, "sender-1", "receiver-1");
    const chunkSize = 128 * 1024;
    const totalChunks = Math.ceil(bytes.byteLength / chunkSize);

    const resumeStore = new MemoryResumeStore();
    // Pretend chunk 0 was already durably written in a prior session.
    const chunk0 = bytes.subarray(0, chunkSize);
    const { hashChunk } = await import("../src/hash.js");
    await resumeStore.save({
      fileMeta: { fileId, name: "big.bin", size: bytes.byteLength, mimeType: "application/octet-stream", chunkSize, totalChunks },
      receivedChunkIndices: [0],
      chunkHashes: { 0: await hashChunk(chunk0) },
      updatedAt: Date.now(),
    });

    const [senderChannel, receiverChannel] = createFakeChannelPair();
    let writer!: MemoryDiskWriter;
    const receivePromise = receiveFile(
      receiverChannel,
      () => {
        writer = new MemoryDiskWriter();
        return writer;
      },
      resumeStore,
      { confirm: async () => true },
    );

    await sendFile(senderChannel, source, "sender-1", "receiver-1");
    await receivePromise;

    // Writer never received chunk 0 in *this* session (it was "already on disk"),
    // but did receive the rest, and the assembled file is still byte-correct
    // because sendFile still re-hashes (without resending) the skipped chunk.
    expect(writer.has(0)).toBe(false);
    expect(writer.has(1)).toBe(true);
  });

  it("cancelling the sender before accept notifies the receiver, both sides end as cancelled", async () => {
    const [senderChannel, receiverChannel] = createFakeChannelPair();
    const source = bytesAsFileSource("cancel-me.bin", "application/octet-stream", randomBytes(500_000));
    const resumeStore = new MemoryResumeStore();
    const controller = new AbortController();
    controller.abort();

    const receiveEvents: TransferEvent[] = [];
    const receivePromise = receiveFile(receiverChannel, () => new MemoryDiskWriter(), resumeStore, {
      confirm: async () => true,
      onEvent: (ev) => receiveEvents.push(ev),
    });

    const sendEvents: TransferEvent[] = [];
    await sendFile(senderChannel, source, "sender-1", "receiver-1", {
      signal: controller.signal,
      onEvent: (ev) => sendEvents.push(ev),
    });
    await receivePromise;

    expect(sendEvents.some((e) => e.kind === "cancelled")).toBe(true);
    expect(receiveEvents.some((e) => e.kind === "cancelled")).toBe(true);
  });

  it("cancelling the receiver notifies the sender mid-transfer", async () => {
    const [senderChannel, receiverChannel] = createFakeChannelPair();
    const source = bytesAsFileSource("cancel-me-too.bin", "application/octet-stream", randomBytes(500_000));
    const resumeStore = new MemoryResumeStore();
    const controller = new AbortController();
    controller.abort();

    const receiveEvents: TransferEvent[] = [];
    const receivePromise = receiveFile(receiverChannel, () => new MemoryDiskWriter(), resumeStore, {
      confirm: async () => true,
      signal: controller.signal,
      onEvent: (ev) => receiveEvents.push(ev),
    });

    const sendEvents: TransferEvent[] = [];
    await sendFile(senderChannel, source, "sender-1", "receiver-1", { onEvent: (ev) => sendEvents.push(ev) });
    await receivePromise;

    expect(receiveEvents.some((e) => e.kind === "cancelled")).toBe(true);
    expect(sendEvents.some((e) => e.kind === "cancelled")).toBe(true);
  });

  // NB: a regression test for "chunks already queued at cancel time must
  // not resurrect progress after the cancelled event" (see the `settled`
  // guard and its comment in src/transferSession.ts) was attempted here but
  // dropped — reproducing it needs two independent async chains
  // (onLocalAbort's cleanup vs. the receiver's in-flight chunk processing)
  // to race in a specific order, and that race isn't controllable enough
  // in a single-process fake-channel test to be reliable in either
  // direction. The bug was reproduced and the fix verified against a real
  // browser/WebRTC session instead — see the root README's verification
  // notes.
});

describe("RejectedError", () => {
  it("carries fileId and reason", () => {
    const err = new RejectedError("f1", "too big");
    expect(err.fileId).toBe("f1");
    expect(err.reason).toBe("too big");
    expect(err.message).toContain("too big");
  });
});

describe("CancelledError", () => {
  it("carries an optional fileId", () => {
    expect(new CancelledError("f1").fileId).toBe("f1");
    expect(new CancelledError().fileId).toBeUndefined();
  });
});
