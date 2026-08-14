import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { WebSocket, WebSocketServer } from "ws";
import { COORDINATOR_SWEEP_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, PROTOCOL_VERSION } from "./constants.js";
import { isAllowedRemoteAddress, listBindAddresses } from "./network.js";
import { PeerRegistry } from "./peerRegistry.js";
import { parseClientMessage, type ServerMessage } from "./protocol.js";

export interface CoordinatorServerOptions {
  port: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
  // When set, the coordinator speaks wss:// instead of ws:// — needed so a
  // web app loaded over https:// (required for crypto.subtle/randomUUID on
  // a LAN address, see web/vite.config.ts) isn't blocked from opening a
  // plain ws:// connection back to it as mixed content.
  tls?: { cert: Buffer; key: Buffer };
}

export interface CoordinatorServerHandle {
  registry: PeerRegistry;
  close(): Promise<void>;
  boundAddresses: string[];
}

/**
 * Starts the coordinator's WebSocket server, bound only to private/loopback
 * interfaces (docs/security.md §1). Returns a handle with the live registry
 * (useful for tests/inspection) and a close() for clean shutdown.
 */
export function startCoordinatorServer(opts: CoordinatorServerOptions): Promise<CoordinatorServerHandle> {
  const log = opts.logger ?? console;
  const registry = new PeerRegistry();
  const sockets = new Map<symbol, WebSocket>();
  const addresses = listBindAddresses();

  return new Promise((resolve, reject) => {
    const servers: HttpServer[] = [];
    const wsServers: WebSocketServer[] = [];
    let remaining = addresses.length;
    let settled = false;

    if (remaining === 0) {
      reject(new Error("no private/loopback network interfaces to bind"));
      return;
    }

    for (const address of addresses) {
      const httpServer = opts.tls ? createHttpsServer({ cert: opts.tls.cert, key: opts.tls.key }) : createHttpServer();
      const wss = new WebSocketServer({ server: httpServer });
      servers.push(httpServer);
      wsServers.push(wss);

      wss.on("connection", (ws, req) => {
        const remote = req.socket.remoteAddress ?? "";
        if (!isAllowedRemoteAddress(remote)) {
          log.warn?.(`rejected connection from non-private address ${remote}`);
          ws.close(1008, "forbidden");
          return;
        }
        handleConnection(ws, registry, sockets, log);
      });

      httpServer.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      httpServer.listen(opts.port, address, () => {
        remaining--;
        if (remaining === 0 && !settled) {
          settled = true;
          const sweepTimer = setInterval(() => sweepStalePeers(registry, sockets, log), COORDINATOR_SWEEP_INTERVAL_MS);
          resolve({
            registry,
            boundAddresses: addresses,
            async close() {
              clearInterval(sweepTimer);
              for (const ws of sockets.values()) ws.close();
              await Promise.all(wsServers.map((s) => new Promise<void>((res) => s.close(() => res()))));
              await Promise.all(servers.map((s) => new Promise<void>((res) => s.close(() => res()))));
            },
          });
        }
      });
    }
  });
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function handleConnection(ws: WebSocket, registry: PeerRegistry, sockets: Map<symbol, WebSocket>, log: Pick<Console, "info" | "warn" | "error">): void {
  const connectionId = Symbol("connection");
  let deviceId: string | null = null;

  ws.on("message", (raw) => {
    const msg = parseClientMessage(raw.toString());
    if (!msg) return;

    switch (msg.type) {
      case "register": {
        if (msg.protocolVersion > PROTOCOL_VERSION) {
          send(ws, { type: "register-rejected", reason: "unsupported-version" });
          return;
        }
        // A live re-register under the same deviceId (page refresh, brief
        // network blip) is far more common than a genuine collision
        // between two different devices — UUIDv4 deviceIds make the latter
        // astronomically unlikely. So treat any existing registration as
        // stale and replace it, closing its old socket, rather than
        // rejecting the new (almost always legitimate) connection.
        const existing = registry.get(msg.deviceId);
        if (existing && existing.connectionId !== connectionId) {
          const staleWs = sockets.get(existing.connectionId);
          sockets.delete(existing.connectionId);
          staleWs?.close();
        }
        deviceId = msg.deviceId;
        sockets.set(connectionId, ws);
        registry.register(msg.deviceId, msg.nickname, msg.deviceType, connectionId);
        log.info?.(`registered ${msg.deviceId} (${msg.deviceType}) — ${registry.size()} peer(s)`);
        broadcastPeerListToAll(registry, sockets);
        break;
      }
      case "heartbeat": {
        registry.touchHeartbeat(msg.deviceId);
        send(ws, { type: "heartbeat-ack", deviceId: msg.deviceId, serverTime: Date.now() });
        break;
      }
      case "signal": {
        if (!deviceId) return;
        const target = registry.get(msg.to);
        if (!target) return;
        const targetWs = sockets.get(target.connectionId);
        if (targetWs) send(targetWs, { type: "signal", from: deviceId, payload: msg.payload });
        break;
      }
      case "unregister": {
        cleanupConnection(connectionId, registry, sockets);
        break;
      }
      case "coordinator-announce": {
        // Diagnostic only, per docs/election.md §3 — no action needed beyond logging.
        log.info?.(`coordinator-announce from ${msg.deviceId} epoch=${msg.epoch}`);
        break;
      }
    }
  });

  ws.on("close", () => cleanupConnection(connectionId, registry, sockets, log));
  ws.on("error", () => cleanupConnection(connectionId, registry, sockets, log));
}

function cleanupConnection(
  connectionId: symbol,
  registry: PeerRegistry,
  sockets: Map<symbol, WebSocket>,
  log?: Pick<Console, "info" | "warn" | "error">,
): void {
  sockets.delete(connectionId);
  const removedDeviceId = registry.removeByConnection(connectionId);
  if (removedDeviceId) {
    log?.info?.(`unregistered ${removedDeviceId} — ${registry.size()} peer(s)`);
    broadcastPeerLeftToAll(removedDeviceId, sockets);
    broadcastPeerListToAll(registry, sockets);
  }
}

function broadcastPeerListToAll(registry: PeerRegistry, sockets: Map<symbol, WebSocket>): void {
  for (const peer of registry.list()) {
    const ws = sockets.get(registryConnectionId(registry, peer.deviceId));
    if (ws) send(ws, { type: "peer-list", peers: registry.listExcept(peer.deviceId) });
  }
}

function broadcastPeerLeftToAll(deviceId: string, sockets: Map<symbol, WebSocket>): void {
  for (const ws of sockets.values()) send(ws, { type: "peer-left", deviceId });
}

function registryConnectionId(registry: PeerRegistry, deviceId: string): symbol {
  return registry.get(deviceId)!.connectionId;
}

function sweepStalePeers(registry: PeerRegistry, sockets: Map<symbol, WebSocket>, log: Pick<Console, "info" | "warn" | "error">): void {
  for (const peer of registry.findStale(HEARTBEAT_TIMEOUT_MS)) {
    log.warn?.(`evicting ${peer.deviceId} — missed heartbeat timeout`);
    sockets.get(peer.connectionId)?.close();
    cleanupConnection(peer.connectionId, registry, sockets, log);
  }
}
