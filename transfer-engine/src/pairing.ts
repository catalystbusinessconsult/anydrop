/**
 * Device-pair trust, per docs/security.md §2. Deliberately lightweight —
 * defends against "an unintended device on the same wifi silently shows up
 * as a target," not a sophisticated on-path attacker (WebRTC's mandatory
 * DTLS already covers transport confidentiality/integrity).
 */

export const PAIRING_TTL_MS = 24 * 60 * 60 * 1000; // 24h, per security.md §5
export const PAIRING_MAX_ATTEMPTS = 3;

export type PairingMessage =
  | { type: "pair-request"; pairingRequestId: string; senderDeviceId: string; senderNickname: string }
  | { type: "pair-verify"; pairingRequestId: string; pin: string }
  | { type: "pair-result"; pairingRequestId: string; ok: boolean };

export interface TrustedPair {
  peerDeviceId: string;
  trustedAt: number;
}

export interface PairingStore {
  isTrusted(peerDeviceId: string): Promise<boolean>;
  trust(peerDeviceId: string): Promise<void>;
}

export class MemoryPairingStore implements PairingStore {
  private pairs = new Map<string, TrustedPair>();

  async isTrusted(peerDeviceId: string): Promise<boolean> {
    const pair = this.pairs.get(peerDeviceId);
    if (!pair) return false;
    if (Date.now() - pair.trustedAt > PAIRING_TTL_MS) {
      this.pairs.delete(peerDeviceId);
      return false;
    }
    return true;
  }

  async trust(peerDeviceId: string): Promise<void> {
    this.pairs.set(peerDeviceId, { peerDeviceId, trustedAt: Date.now() });
  }
}

const STORAGE_PREFIX = "anydrop:trust:";

/** localStorage-backed PairingStore for the browser/PWA. */
export class LocalStoragePairingStore implements PairingStore {
  constructor(private readonly storage: Storage = globalThis.localStorage) {}

  async isTrusted(peerDeviceId: string): Promise<boolean> {
    const raw = this.storage.getItem(STORAGE_PREFIX + peerDeviceId);
    if (!raw) return false;
    const pair = JSON.parse(raw) as TrustedPair;
    if (Date.now() - pair.trustedAt > PAIRING_TTL_MS) {
      this.storage.removeItem(STORAGE_PREFIX + peerDeviceId);
      return false;
    }
    return true;
  }

  async trust(peerDeviceId: string): Promise<void> {
    this.storage.setItem(STORAGE_PREFIX + peerDeviceId, JSON.stringify({ peerDeviceId, trustedAt: Date.now() }));
  }
}

export function generatePin(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return n.toString().padStart(6, "0");
}

export function generatePairingRequestId(): string {
  return crypto.randomUUID();
}
