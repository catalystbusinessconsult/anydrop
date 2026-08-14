import type { DataChannelLike } from "./types.js";

/**
 * WebRTC connection setup from signaling messages. LAN-only by design, so
 * no STUN/TURN servers are configured — ICE gathers host candidates on the
 * local network interfaces only, which is all a same-LAN peer needs.
 */

export interface SignalPayload {
  kind: "offer" | "answer" | "ice-candidate";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export interface SignalTransport {
  send(to: string, payload: SignalPayload): void;
  onSignal(handler: (from: string, payload: SignalPayload) => void): () => void;
}

export interface ConnectOptions {
  peerDeviceId: string;
  transport: SignalTransport;
  /** The device that initiates (creates the offer + data channel) — by convention, the sender. */
  isInitiator: boolean;
  dataChannelLabel?: string;
  onIceStateChange?: (state: RTCIceConnectionState) => void;
}

const DEFAULT_LABEL = "cbc-transfer";

/** Resolves once a bidirectional RTCDataChannel is open with `peerDeviceId`. */
export function connectToPeer(opts: ConnectOptions): Promise<DataChannelLike> {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const pendingCandidates: RTCIceCandidateInit[] = [];
  let remoteDescriptionSet = false;

  pc.oniceconnectionstatechange = () => {
    opts.onIceStateChange?.(pc.iceConnectionState);
  };
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      opts.transport.send(opts.peerDeviceId, { kind: "ice-candidate", candidate: ev.candidate.toJSON() });
    }
  };

  const unsubscribe = opts.transport.onSignal((from, payload) => {
    if (from !== opts.peerDeviceId) return;
    void handleSignal(payload);
  });

  async function handleSignal(payload: SignalPayload): Promise<void> {
    if (payload.kind === "offer" && payload.sdp) {
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      remoteDescriptionSet = true;
      await drainPendingCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      opts.transport.send(opts.peerDeviceId, { kind: "answer", sdp: answer.sdp });
    } else if (payload.kind === "answer" && payload.sdp) {
      await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      remoteDescriptionSet = true;
      await drainPendingCandidates();
    } else if (payload.kind === "ice-candidate" && payload.candidate) {
      if (remoteDescriptionSet) {
        await pc.addIceCandidate(payload.candidate);
      } else {
        pendingCandidates.push(payload.candidate);
      }
    }
  }

  async function drainPendingCandidates(): Promise<void> {
    while (pendingCandidates.length) {
      const candidate = pendingCandidates.shift()!;
      await pc.addIceCandidate(candidate);
    }
  }

  return new Promise<DataChannelLike>((resolve, reject) => {
    // RTCDataChannel structurally satisfies DataChannelLike at runtime, but
    // lib.dom.d.ts types its on* handlers with a `this` parameter that
    // defeats plain structural assignability — cast once here rather than
    // at every call site that consumes the resolved channel.
    const onOpen = (channel: RTCDataChannel) => {
      unsubscribe();
      resolve(channel as unknown as DataChannelLike);
    };

    if (opts.isInitiator) {
      const channel = pc.createDataChannel(opts.dataChannelLabel ?? DEFAULT_LABEL, { ordered: true });
      channel.onopen = () => onOpen(channel);
      channel.onerror = (ev) => reject(ev);
      pc.createOffer()
        .then(async (offer) => {
          await pc.setLocalDescription(offer);
          opts.transport.send(opts.peerDeviceId, { kind: "offer", sdp: offer.sdp });
        })
        .catch(reject);
    } else {
      pc.ondatachannel = (ev) => {
        const channel = ev.channel;
        channel.onopen = () => onOpen(channel);
        channel.onerror = (err) => reject(err);
      };
    }
  });
}
