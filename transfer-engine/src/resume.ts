import type { ResumeState, ResumeStore } from "./types.js";

const RESUME_TTL_MS = 60 * 60 * 1000; // 1 hour, per docs/security.md §5

export class MemoryResumeStore implements ResumeStore {
  private states = new Map<string, ResumeState>();

  async load(fileId: string): Promise<ResumeState | null> {
    const state = this.states.get(fileId);
    if (!state) return null;
    if (Date.now() - state.updatedAt > RESUME_TTL_MS) {
      this.states.delete(fileId);
      return null;
    }
    return state;
  }

  async save(state: ResumeState): Promise<void> {
    this.states.set(state.fileMeta.fileId, { ...state, updatedAt: Date.now() });
  }

  async clear(fileId: string): Promise<void> {
    this.states.delete(fileId);
  }
}

const STORAGE_PREFIX = "cbc-lan-share:resume:";

/** localStorage-backed ResumeStore for the browser/PWA. */
export class LocalStorageResumeStore implements ResumeStore {
  constructor(private readonly storage: Storage = globalThis.localStorage) {}

  async load(fileId: string): Promise<ResumeState | null> {
    const raw = this.storage.getItem(STORAGE_PREFIX + fileId);
    if (!raw) return null;
    const state = JSON.parse(raw) as ResumeState;
    if (Date.now() - state.updatedAt > RESUME_TTL_MS) {
      this.storage.removeItem(STORAGE_PREFIX + fileId);
      return null;
    }
    return state;
  }

  async save(state: ResumeState): Promise<void> {
    this.storage.setItem(STORAGE_PREFIX + state.fileMeta.fileId, JSON.stringify({ ...state, updatedAt: Date.now() }));
  }

  async clear(fileId: string): Promise<void> {
    this.storage.removeItem(STORAGE_PREFIX + fileId);
  }
}

/** Smallest contiguous-from-zero prefix length in a set of received indices. */
export function resumeFromChunk(receivedChunkIndices: number[]): number {
  const set = new Set(receivedChunkIndices);
  let i = 0;
  while (set.has(i)) i++;
  return i;
}
