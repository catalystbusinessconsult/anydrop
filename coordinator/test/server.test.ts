import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { startCoordinatorServer, type CoordinatorServerHandle } from "../src/server.js";
import type { ClientMessage, ServerMessage } from "../src/protocol.js";

let nextPort = 48100;
let handle: CoordinatorServerHandle | null = null;
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of openSockets) ws.close();
  openSockets.length = 0;
  await handle?.close();
  handle = null;
});

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    openSockets.push(ws);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
}

function send(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

describe("coordinator server (real WebSocket clients over loopback)", () => {
  it("registers a client and sends it an empty peer-list", async () => {
    const port = nextPort++;
    handle = await startCoordinatorServer({ port, logger: { info() {}, warn() {}, error() {} } });
    const ws = await connect(port);

    const peerListPromise = nextMessage(ws);
    send(ws, { type: "register", deviceId: "d1", nickname: "Alice", deviceType: "laptop", protocolVersion: 1 });
    const msg = await peerListPromise;

    expect(msg).toEqual({ type: "peer-list", peers: [] });
    expect(handle.registry.has("d1")).toBe(true);
  });

  it("broadcasts an updated peer-list to existing clients when a new one registers", async () => {
    const port = nextPort++;
    handle = await startCoordinatorServer({ port, logger: { info() {}, warn() {}, error() {} } });

    const wsA = await connect(port);
    send(wsA, { type: "register", deviceId: "a", nickname: "Alice", deviceType: "laptop", protocolVersion: 1 });
    await nextMessage(wsA); // a's own initial (empty) peer-list

    const secondPeerListForA = nextMessage(wsA);
    const wsB = await connect(port);
    const firstPeerListForB = nextMessage(wsB);
    send(wsB, { type: "register", deviceId: "b", nickname: "Bob", deviceType: "phone", protocolVersion: 1 });

    const [aSees, bSees] = await Promise.all([secondPeerListForA, firstPeerListForB]);
    expect(aSees).toEqual({ type: "peer-list", peers: [{ deviceId: "b", nickname: "Bob", deviceType: "phone" }] });
    expect(bSees).toEqual({ type: "peer-list", peers: [{ deviceId: "a", nickname: "Alice", deviceType: "laptop" }] });
  });

  it("relays a signal message from one peer to another by deviceId", async () => {
    const port = nextPort++;
    handle = await startCoordinatorServer({ port, logger: { info() {}, warn() {}, error() {} } });

    const wsA = await connect(port);
    send(wsA, { type: "register", deviceId: "a", nickname: "Alice", deviceType: "laptop", protocolVersion: 1 });
    await nextMessage(wsA);

    // Both the a-update and b's-own-initial peer-list broadcasts fire
    // synchronously server-side right after b registers, so both listeners
    // must be attached *before* triggering registration — attaching one
    // reactively after awaiting the other risks missing it.
    const aUpdate = nextMessage(wsA); // peer-list update after b joins
    const wsB = await connect(port);
    const bInitial = nextMessage(wsB);
    send(wsB, { type: "register", deviceId: "b", nickname: "Bob", deviceType: "phone", protocolVersion: 1 });
    await Promise.all([aUpdate, bInitial]);

    const relayed = nextMessage(wsB);
    send(wsA, { type: "signal", to: "b", payload: { kind: "offer", sdp: "v=0..." } });
    const msg = await relayed;
    expect(msg).toEqual({ type: "signal", from: "a", payload: { kind: "offer", sdp: "v=0..." } });
  });

  it("replaces a stale connection when the same deviceId re-registers (reconnect, not a rejection)", async () => {
    const port = nextPort++;
    handle = await startCoordinatorServer({ port, logger: { info() {}, warn() {}, error() {} } });

    const wsOld = await connect(port);
    send(wsOld, { type: "register", deviceId: "d1", nickname: "Alice", deviceType: "laptop", protocolVersion: 1 });
    await nextMessage(wsOld);

    const oldClosed = new Promise<void>((resolve) => wsOld.once("close", resolve));
    const wsNew = await connect(port);
    const newRegistered = nextMessage(wsNew);
    send(wsNew, { type: "register", deviceId: "d1", nickname: "Alice", deviceType: "laptop", protocolVersion: 1 });

    await Promise.all([oldClosed, newRegistered]);
    expect(handle.registry.has("d1")).toBe(true);
    expect(handle.registry.size()).toBe(1);
  });

  it("acks a heartbeat", async () => {
    const port = nextPort++;
    handle = await startCoordinatorServer({ port, logger: { info() {}, warn() {}, error() {} } });
    const ws = await connect(port);
    send(ws, { type: "register", deviceId: "d1", nickname: "Alice", deviceType: "laptop", protocolVersion: 1 });
    await nextMessage(ws);

    const ackPromise = nextMessage(ws);
    send(ws, { type: "heartbeat", deviceId: "d1" });
    const ack = await ackPromise;
    expect(ack.type).toBe("heartbeat-ack");
  });

  it("broadcasts peer-left when a client disconnects", async () => {
    const port = nextPort++;
    handle = await startCoordinatorServer({ port, logger: { info() {}, warn() {}, error() {} } });

    const wsA = await connect(port);
    send(wsA, { type: "register", deviceId: "a", nickname: "Alice", deviceType: "laptop", protocolVersion: 1 });
    await nextMessage(wsA);

    const aUpdate = nextMessage(wsA); // peer-list update after b joins
    const wsB = await connect(port);
    const bInitial = nextMessage(wsB);
    send(wsB, { type: "register", deviceId: "b", nickname: "Bob", deviceType: "phone", protocolVersion: 1 });
    await Promise.all([aUpdate, bInitial]);

    const peerLeft = nextMessage(wsA);
    wsB.close();
    const msg = await peerLeft;
    expect(msg).toEqual({ type: "peer-left", deviceId: "b" });
  });
});
