import {
  bytesAsFileSource,
  blobAsFileSource,
  connectToPeer,
  createMessageBus,
  FileSystemAccessWriter,
  generatePairingRequestId,
  generatePin,
  IndexedDbWriter,
  LocalStoragePairingStore,
  LocalStorageResumeStore,
  MemoryDiskWriter,
  pickSaveHandle,
  receiveFile,
  sendFile,
  type DiskWriter,
  type FileMeta,
  type PairingMessage,
  type PairingStore,
  type SignalTransport,
  type TransferEvent,
} from "@anydrop/transfer-engine";

const pairingStore: PairingStore = new LocalStoragePairingStore();
const resumeStore = new LocalStorageResumeStore();

function supportsFileSystemAccess(): boolean {
  return typeof window !== "undefined" && "showSaveFilePicker" in window;
}

function isIOSSafari(): boolean {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

async function pickWriter(meta: FileMeta): Promise<DiskWriter> {
  if (supportsFileSystemAccess()) {
    try {
      const handle = await pickSaveHandle(meta.name);
      // Some environments report the File System Access API as present
      // but reject actual writes (e.g. a permissions policy or automation
      // context) — createWritable() is where that surfaces, not the
      // picker call, so probe it here rather than failing deep inside
      // receiveFile once the transfer is already underway.
      const probe = await handle.createWritable({ keepExistingData: true });
      await probe.abort();
      return new FileSystemAccessWriter(handle);
    } catch (err) {
      console.warn("File System Access API unavailable at write time, falling back:", err);
    }
  }
  if (isIOSSafari()) {
    return new IndexedDbWriter();
  }
  // Last-resort fallback for browsers without either API (small files only).
  return new MemoryDiskWriter();
}

async function waitForPairingMessage<T extends PairingMessage["type"]>(
  bus: ReturnType<typeof createMessageBus>,
  type: T,
  pairingRequestId: string,
): Promise<Extract<PairingMessage, { type: T }>> {
  return new Promise((resolve) => {
    const unsubscribe = bus.onJson((msg) => {
      const m = msg as PairingMessage;
      if (m && m.type === type && "pairingRequestId" in m && m.pairingRequestId === pairingRequestId) {
        unsubscribe();
        resolve(m as Extract<PairingMessage, { type: T }>);
      }
    });
  });
}

export interface SendCallbacks {
  onEvent?: (event: TransferEvent) => void;
  /** Called if pairing is required — resolve with the PIN the sending human read off the receiver's screen. */
  promptForPin: () => Promise<string>;
  onIceStateChange?: (state: RTCIceConnectionState) => void;
  /** Abort to cancel the send in progress. */
  signal?: AbortSignal;
}

export async function sendFileToPeer(
  file: File,
  peerDeviceId: string,
  selfDeviceId: string,
  selfNickname: string,
  transport: SignalTransport,
  cb: SendCallbacks,
): Promise<void> {
  const channel = await connectToPeer({
    peerDeviceId,
    transport,
    isInitiator: true,
    onIceStateChange: cb.onIceStateChange,
  });
  const bus = createMessageBus(channel);

  const trusted = await pairingStore.isTrusted(peerDeviceId);
  if (!trusted) {
    const pairingRequestId = generatePairingRequestId();
    bus.sendJson({ type: "pair-request", pairingRequestId, senderDeviceId: selfDeviceId, senderNickname: selfNickname } satisfies PairingMessage);

    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const pin = await cb.promptForPin();
      bus.sendJson({ type: "pair-verify", pairingRequestId, pin } satisfies PairingMessage);
      const result = await waitForPairingMessage(bus, "pair-result", pairingRequestId);
      ok = result.ok;
    }
    if (!ok) {
      channel.close();
      throw new Error("pairing PIN verification failed");
    }
    await pairingStore.trust(peerDeviceId);
  }

  const source = blobAsFileSource(file);
  try {
    await sendFile(channel, source, selfDeviceId, peerDeviceId, { onEvent: cb.onEvent, signal: cb.signal });
  } finally {
    // One connectToPeer() per file — always tear down after this attempt
    // settles (whatever the outcome) so a multi-file queue doesn't leak an
    // RTCPeerConnection per file sent in the session.
    channel.close();
  }
}

export interface ReceiveCallbacks {
  onEvent?: (event: TransferEvent) => void;
  /** Show this PIN to the human and keep it up until pairing resolves. */
  showPin: (pin: string, senderNickname: string) => void;
  hidePin: () => void;
  /** Ask the human whether to accept this specific incoming file. */
  confirmTransfer: (meta: FileMeta) => Promise<boolean>;
  /** Abort to cancel the receive in progress. */
  signal?: AbortSignal;
}

/**
 * Waits for exactly one inbound connection + (optional pairing) + transfer.
 * Call this in a loop from the UI to keep listening for the next peer.
 */
export async function listenForNextIncomingTransfer(
  selfDeviceId: string,
  incomingPeerDeviceId: string,
  transport: SignalTransport,
  cb: ReceiveCallbacks,
): Promise<FileMeta> {
  const channel = await connectToPeer({
    peerDeviceId: incomingPeerDeviceId,
    transport,
    isInitiator: false,
  });
  const bus = createMessageBus(channel);

  const trusted = await pairingStore.isTrusted(incomingPeerDeviceId);
  if (!trusted) {
    const request = await new Promise<Extract<PairingMessage, { type: "pair-request" }>>((resolve) => {
      const unsubscribe = bus.onJson((msg) => {
        const m = msg as PairingMessage;
        if (m?.type === "pair-request") {
          unsubscribe();
          resolve(m);
        }
      });
    });

    const pin = generatePin();
    cb.showPin(pin, request.senderNickname);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const verify = await waitForPairingMessage(bus, "pair-verify", request.pairingRequestId);
      ok = verify.pin === pin;
      bus.sendJson({ type: "pair-result", pairingRequestId: request.pairingRequestId, ok } satisfies PairingMessage);
    }
    cb.hidePin();
    if (!ok) {
      channel.close();
      throw new Error("pairing PIN verification failed");
    }
    await pairingStore.trust(incomingPeerDeviceId);
  }

  // pickWriter() needs the file meta (only known once the offer arrives) but
  // also needs to run within the "accept" click's transient activation
  // window (showSaveFilePicker requires a recent user gesture) — so it's
  // resolved inside the confirm callback, right after the human accepts,
  // and handed to receiveFile's synchronous writerFactory from there.
  let resolvedWriter: DiskWriter | null = null;
  const confirmAndPrepareWriter = async (meta: FileMeta): Promise<boolean> => {
    const accepted = await cb.confirmTransfer(meta);
    if (accepted) {
      resolvedWriter = await pickWriter(meta);
    }
    return accepted;
  };

  try {
    return await receiveFile(
      channel,
      () => {
        if (!resolvedWriter) throw new Error("writer not ready — confirm must resolve before writerFactory runs");
        return resolvedWriter;
      },
      resumeStore,
      { confirm: confirmAndPrepareWriter, onEvent: cb.onEvent, signal: cb.signal },
    );
  } finally {
    channel.close();
  }
}

export { pickWriter };
export { bytesAsFileSource };
