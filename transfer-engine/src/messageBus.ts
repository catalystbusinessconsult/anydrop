import { BACKPRESSURE_HIGH_WATER_MARK, BACKPRESSURE_LOW_WATER_MARK, type DataChannelLike } from "./types.js";

/**
 * Splits one DataChannel into independent JSON-message and binary-chunk
 * pub/sub streams (RTCDataChannel messages are naturally either strings or
 * ArrayBuffers, so no extra framing byte is needed to tell them apart) and
 * centralizes backpressure so both the pairing flow and the transfer flow
 * can share a single data channel without stepping on each other's
 * onmessage/onbufferedamountlow handlers.
 */
export interface MessageBus {
  sendJson(msg: unknown): void;
  sendBinary(data: Uint8Array): void;
  onJson(handler: (msg: unknown) => void): () => void;
  onBinary(handler: (data: Uint8Array) => void): () => void;
  /** Resolves once bufferedAmount drops back under the low water mark. */
  waitForBufferDrain(): Promise<void>;
  close(): void;
}

export function createMessageBus(channel: DataChannelLike): MessageBus {
  const jsonHandlers = new Set<(msg: unknown) => void>();
  const binaryHandlers = new Set<(data: Uint8Array) => void>();
  let drainWaiters: Array<() => void> = [];

  channel.bufferedAmountLowThreshold = BACKPRESSURE_LOW_WATER_MARK;
  channel.onbufferedamountlow = () => {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  };
  channel.onmessage = (ev: { data: unknown }) => {
    if (typeof ev.data === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const h of jsonHandlers) h(parsed);
    } else if (ev.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(ev.data);
      for (const h of binaryHandlers) h(bytes);
    } else if (ev.data instanceof Uint8Array) {
      for (const h of binaryHandlers) h(ev.data);
    }
  };

  return {
    sendJson(msg) {
      channel.send(JSON.stringify(msg));
    },
    sendBinary(data) {
      channel.send(data);
    },
    onJson(handler) {
      jsonHandlers.add(handler);
      return () => jsonHandlers.delete(handler);
    },
    onBinary(handler) {
      binaryHandlers.add(handler);
      return () => binaryHandlers.delete(handler);
    },
    async waitForBufferDrain() {
      if (channel.bufferedAmount < BACKPRESSURE_HIGH_WATER_MARK) return;
      await new Promise<void>((resolve) => drainWaiters.push(resolve));
    },
    close() {
      channel.close();
    },
  };
}

// --- binary chunk frame: 4-byte big-endian chunk index + payload bytes ---

export function encodeChunkFrame(index: number, data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + data.byteLength);
  new DataView(frame.buffer).setUint32(0, index, false);
  frame.set(data, 4);
  return frame;
}

export function decodeChunkFrame(frame: Uint8Array): { index: number; data: Uint8Array } {
  const index = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  return { index, data: frame.subarray(4) };
}
