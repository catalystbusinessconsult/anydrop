import type { SignalPayload, SignalTransport } from "@cbc-lan-share/transfer-engine";

export type DeviceType = "laptop" | "phone";

export interface PeerInfo {
  deviceId: string;
  nickname: string;
  deviceType: DeviceType;
}

export type ConnectionState = "connecting" | "open" | "reconnecting" | "offline";

// Mirrors docs/protocol.md §4.
const HEARTBEAT_INTERVAL_MS = 5000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const RECONNECT_ATTEMPTS_BEFORE_GIVING_UP = 5;

type ClientMessage =
  | { type: "register"; deviceId: string; nickname: string; deviceType: DeviceType; protocolVersion: number }
  | { type: "signal"; to: string; payload: unknown }
  | { type: "heartbeat"; deviceId: string }
  | { type: "unregister"; deviceId: string };

type ServerMessage =
  | { type: "peer-list"; peers: PeerInfo[] }
  | { type: "signal"; from: string; payload: unknown }
  | { type: "peer-left"; deviceId: string }
  | { type: "heartbeat-ack"; deviceId: string; serverTime: number }
  | { type: "register-rejected"; reason: string };

export interface CoordinatorClientOptions {
  url: string;
  deviceId: string;
  nickname: string;
  deviceType: DeviceType;
}

/**
 * Browser-side implementation of docs/protocol.md, and the SignalTransport
 * the transfer-engine's connectToPeer() needs for WebRTC signaling relay.
 */
export class CoordinatorClient implements SignalTransport {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private manuallyStopped = false;

  private peers: PeerInfo[] = [];
  private peersListeners = new Set<(peers: PeerInfo[]) => void>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private signalListeners = new Set<(from: string, payload: SignalPayload) => void>();
  private state: ConnectionState = "connecting";

  constructor(private readonly opts: CoordinatorClientOptions) {}

  connect(): void {
    this.manuallyStopped = false;
    this.open();
  }

  disconnect(): void {
    this.manuallyStopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: "unregister", deviceId: this.opts.deviceId });
    }
    this.ws?.close();
    this.ws = null;
  }

  send(to: string, payload: SignalPayload): void;
  send(msg: ClientMessage): void;
  send(a: string | ClientMessage, b?: SignalPayload): void {
    const msg: ClientMessage = typeof a === "string" ? { type: "signal", to: a, payload: b } : a;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onSignal(handler: (from: string, payload: SignalPayload) => void): () => void {
    this.signalListeners.add(handler);
    return () => this.signalListeners.delete(handler);
  }

  onPeersChanged(handler: (peers: PeerInfo[]) => void): () => void {
    this.peersListeners.add(handler);
    handler(this.peers);
    return () => this.peersListeners.delete(handler);
  }

  onStateChanged(handler: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(handler);
    handler(this.state);
    return () => this.stateListeners.delete(handler);
  }

  currentPeers(): PeerInfo[] {
    return this.peers;
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const l of this.stateListeners) l(state);
  }

  private open(): void {
    this.setState(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    // disconnect()/reconnect can abandon a socket that's still mid-handshake
    // (close() on a CONNECTING socket doesn't guarantee its events stop
    // firing) — every handler below checks it's still `this.ws` before
    // acting, so a superseded socket's late open/message/close is a no-op
    // instead of triggering a second, redundant reconnect cycle.
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.send({
        type: "register",
        deviceId: this.opts.deviceId,
        nickname: this.opts.nickname,
        deviceType: this.opts.deviceType,
        protocolVersion: 1,
      });
      this.setState("open");
      this.heartbeatTimer = setInterval(() => {
        this.send({ type: "heartbeat", deviceId: this.opts.deviceId });
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "peer-list":
          this.peers = msg.peers;
          for (const l of this.peersListeners) l(this.peers);
          break;
        case "signal":
          for (const l of this.signalListeners) l(msg.from, msg.payload as SignalPayload);
          break;
        case "peer-left":
          this.peers = this.peers.filter((p) => p.deviceId !== msg.deviceId);
          for (const l of this.peersListeners) l(this.peers);
          break;
        case "register-rejected":
          console.error("registration rejected:", msg.reason);
          break;
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.handleDisconnect();
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      ws.close();
    };
  }

  private handleDisconnect(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.manuallyStopped) {
      this.setState("offline");
      return;
    }
    this.peers = [];
    for (const l of this.peersListeners) l(this.peers);

    if (this.reconnectAttempt >= RECONNECT_ATTEMPTS_BEFORE_GIVING_UP) {
      this.setState("offline");
      return;
    }
    this.setState("reconnecting");
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    const jitter = backoff * (0.8 + Math.random() * 0.4);
    this.reconnectAttempt++;
    setTimeout(() => {
      if (!this.manuallyStopped) this.open();
    }, jitter);
  }

  /** Called by the UI's "try again" action after `offline` — resets the backoff counter and re-resolves the hostname. */
  retry(): void {
    this.reconnectAttempt = 0;
    this.open();
  }
}
