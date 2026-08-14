import { useEffect, useMemo, useRef, useState } from "react";
import { computeFileId, type FileMeta, type TransferEvent } from "@anydrop/transfer-engine";
import { CoordinatorClient, type ConnectionState, type PeerInfo } from "./lib/coordinatorClient";
import { resolveCoordinatorUrl, setManualHost } from "./lib/discovery";
import { getDeviceId, getDeviceType, getNickname, setNickname } from "./lib/identity";
import { listenForNextIncomingTransfer, sendFileToPeer } from "./lib/peerSession";
import { PeerList } from "./components/PeerList";
import { LoadingScreen } from "./components/LoadingScreen";
import { QrPairingPanel } from "./components/QrPairingPanel";
import { PinModal, type PinModalState } from "./components/PinModal";
import { IncomingConfirmModal } from "./components/IncomingConfirmModal";
import { TransferList, type TransferRecord } from "./components/TransferList";

const deviceId = getDeviceId();
const deviceType = getDeviceType();

// TransferEvent's "progress" variant nests fileId under `.progress`, unlike
// every other variant which carries it at the top level — a plain
// `"fileId" in event` check silently misses it there.
function eventFileId(event: TransferEvent): string {
  return event.kind === "progress" ? event.progress.fileId : event.fileId;
}

export default function App() {
  const [nickname, setNicknameState] = useState(getNickname());
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [pinModal, setPinModal] = useState<PinModalState | null>(null);
  const [incomingConfirm, setIncomingConfirm] = useState<{ meta: FileMeta; resolve: (accept: boolean) => void } | null>(null);
  const [busyPeerIds, setBusyPeerIds] = useState<Set<string>>(new Set());
  const [manualHostInput, setManualHostInput] = useState("");

  const client = useMemo(
    // file: (the Electron desktop app's page origin) also needs wss:// —
    // the coordinator runs TLS-only now that phones need it too, so only
    // plain http: dev mode should ever ask for a plain ws:// connection.
    () => new CoordinatorClient({ url: resolveCoordinatorUrl(window.location.protocol !== "http:"), deviceId, nickname, deviceType }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const unsubPeers = client.onPeersChanged(setPeers);
    const unsubState = client.onStateChanged(setConnectionState);
    client.connect();
    return () => {
      unsubPeers();
      unsubState();
      client.disconnect();
    };
  }, [client]);

  function upsertTransfer(record: TransferRecord) {
    setTransfers((prev) => {
      const idx = prev.findIndex((t) => t.fileId === record.fileId);
      if (idx === -1) return [record, ...prev];
      const next = [...prev];
      next[idx] = record;
      return next;
    });
  }

  function applyEvent(fileId: string, direction: "send" | "receive", peerNickname: string, fileName: string, totalBytes: number, event: TransferEvent) {
    if (event.kind === "progress") {
      upsertTransfer({
        fileId,
        fileName,
        direction,
        peerNickname,
        bytesTransferred: event.progress.bytesTransferred,
        totalBytes: event.progress.totalBytes,
        status: "in-progress",
      });
    } else if (event.kind === "complete") {
      upsertTransfer({ fileId, fileName, direction, peerNickname, bytesTransferred: totalBytes, totalBytes, status: "complete" });
    } else if (event.kind === "error") {
      upsertTransfer({ fileId, fileName, direction, peerNickname, bytesTransferred: 0, totalBytes, status: "error", message: event.message });
    } else if (event.kind === "rejected") {
      upsertTransfer({ fileId, fileName, direction, peerNickname, bytesTransferred: 0, totalBytes, status: "rejected" });
    } else if (event.kind === "cancelled") {
      upsertTransfer({ fileId, fileName, direction, peerNickname, bytesTransferred: 0, totalBytes, status: "cancelled" });
    }
  }

  function handleCancelTransfer(fileId: string) {
    abortControllers.current.get(fileId)?.abort();
  }

  async function handleSendFiles(peer: PeerInfo, files: File[]) {
    setBusyPeerIds((prev) => new Set(prev).add(peer.deviceId));
    try {
      // Chunk frames on the wire carry no fileId (see docs/protocol.md), so
      // only one transfer can be in flight per data channel at a time —
      // multiple files to the same peer are sent as a sequential queue,
      // each getting its own fresh RTCPeerConnection.
      for (const file of files) {
        const controller = new AbortController();
        const fileId = await computeFileId(file, deviceId, peer.deviceId);
        abortControllers.current.set(fileId, controller);
        try {
          await sendFileToPeer(file, peer.deviceId, deviceId, nickname, client, {
            signal: controller.signal,
            promptForPin: () =>
              new Promise<string>((resolve) => {
                setPinModal({ mode: "enter", onSubmit: (pin) => { setPinModal(null); resolve(pin); } });
              }),
            onEvent: (event) => {
              applyEvent(eventFileId(event), "send", peer.nickname, file.name, file.size, event);
            },
          });
        } catch (err) {
          console.error("send failed:", err);
        } finally {
          abortControllers.current.delete(fileId);
        }
      }
    } finally {
      setBusyPeerIds((prev) => {
        const next = new Set(prev);
        next.delete(peer.deviceId);
        return next;
      });
    }
  }

  useEffect(() => {
    const unsubscribe = client.onSignal((from, payload) => {
      if (payload.kind !== "offer") return;

      const peerNickname = peers.find((p) => p.deviceId === from)?.nickname ?? "Unknown device";
      // FileMeta is only known once the transfer-offer arrives (in
      // confirmTransfer below); onEvent only carries a fileId, so it's
      // captured here rather than re-read from React state, which would be
      // stale inside this closure.
      let currentMeta: FileMeta | null = null;
      const controller = new AbortController();

      listenForNextIncomingTransfer(deviceId, from, client, {
        signal: controller.signal,
        showPin: (pin, senderNickname) => setPinModal({ mode: "show", pin, senderNickname }),
        hidePin: () => setPinModal(null),
        confirmTransfer: (meta) =>
          new Promise<boolean>((resolve) => {
            currentMeta = meta;
            abortControllers.current.set(meta.fileId, controller);
            setIncomingConfirm({ meta, resolve: (accept) => { setIncomingConfirm(null); resolve(accept); } });
          }),
        onEvent: (event) => {
          applyEvent(eventFileId(event), "receive", peerNickname, currentMeta?.name ?? eventFileId(event), currentMeta?.size ?? 0, event);
        },
      })
        // receiveFile() resolves with `meta` on every terminal outcome —
        // complete, rejected, and cancelled alike — so the real state is
        // whatever onEvent already reported above; nothing more to apply
        // here. Only genuine failures (thrown, not returned) land in catch.
        .catch((err) => console.error("incoming transfer failed:", err))
        .finally(() => {
          if (currentMeta) abortControllers.current.delete(currentMeta.fileId);
        });
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, peers]);

  // Only the very first connection attempt gets the full-screen takeover —
  // later reconnects keep the normal layout (with its own small status
  // pill) since by then the user already has a peer list worth not
  // yanking away from under them.
  if (connectionState === "connecting") {
    return <LoadingScreen />;
  }

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <span className="app__logo" aria-hidden>
            ⇄
          </span>
          <h1>Anydrop</h1>
        </div>
        <p className={`connection-status connection-status--${connectionState}`}>
          <span className="connection-status__dot" aria-hidden />
          {connectionState === "open" && "Connected"}
          {connectionState === "reconnecting" && "Reconnecting…"}
          {connectionState === "offline" && "Offline"}
        </p>
      </header>

      <section className="panel identity-panel">
        <label>
          Your name on this network
          <input
            value={nickname}
            onChange={(ev) => {
              setNicknameState(ev.target.value);
              setNickname(ev.target.value);
            }}
          />
        </label>
        {deviceType === "laptop" && <QrPairingPanel />}
      </section>

      {connectionState === "offline" && (
        <section className="panel manual-host-panel">
          <p>Couldn't reach a coordinator at this address. If you have the laptop's IP, enter it here:</p>
          <div className="manual-host-panel__row">
            <input placeholder="192.168.1.42" value={manualHostInput} onChange={(ev) => setManualHostInput(ev.target.value)} />
            <button
              className="button--primary"
              onClick={() => {
                setManualHost(manualHostInput);
                window.location.reload();
              }}
            >
              Connect
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Devices on this network</h2>
        <PeerList peers={peers} onPickFilesFor={handleSendFiles} onDropFilesFor={handleSendFiles} busyPeerIds={busyPeerIds} />
      </section>

      <section className="panel">
        <h2>Transfers</h2>
        <TransferList transfers={transfers} onCancel={handleCancelTransfer} />
      </section>

      {pinModal && <PinModal state={pinModal} />}
      {incomingConfirm && <IncomingConfirmModal meta={incomingConfirm.meta} onDecision={incomingConfirm.resolve} />}
    </div>
  );
}
