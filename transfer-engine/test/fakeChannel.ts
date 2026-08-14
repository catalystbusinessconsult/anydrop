import type { DataChannelLike } from "../src/types.js";

/** In-memory pair of linked DataChannelLike endpoints, for testing transferSession without real WebRTC. */
export function createFakeChannelPair(): [DataChannelLike, DataChannelLike] {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class FakeChannel implements DataChannelLike {
  readyState: "connecting" | "open" | "closing" | "closed" = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onbufferedamountlow: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  peer: FakeChannel | null = null;

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== "open") throw new Error("channel not open");
    // Deliver asynchronously, like a real network hop, so ordering bugs
    // that only manifest with real async delivery surface in tests too.
    queueMicrotask(() => {
      const payload = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
      this.peer?.onmessage?.({ data: payload });
    });
  }

  close(): void {
    this.readyState = "closed";
    this.onclose?.();
  }
}
