/**
 * Per-chunk + final-file integrity checking.
 *
 * SubtleCrypto.digest() is one-shot (no incremental update in the standard
 * browser API), so "rolling hash" here means: hash each chunk independently
 * as it arrives, then hash the concatenation of chunk hashes for the final
 * file hash. This still catches truncation, reordering, and corruption of
 * any single chunk without requiring a streaming SHA-256 implementation.
 */

// btoa is a global in both browsers and Node 16+, so no Buffer fallback is
// needed — keeps this module free of a Node-only type dependency.
function toBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]!);
  return btoa(binary);
}

export async function hashChunk(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return toBase64(digest);
}

/** Combines ordered per-chunk hashes into one final file hash. */
export async function hashOfHashes(orderedChunkHashes: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const joined = encoder.encode(orderedChunkHashes.join("|"));
  const digest = await crypto.subtle.digest("SHA-256", joined as unknown as BufferSource);
  return toBase64(digest);
}

/** Convenience: compute the final file hash directly from chunkHashes keyed by index. */
export async function finalFileHash(chunkHashes: Record<number, string>, totalChunks: number): Promise<string> {
  const ordered: string[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const h = chunkHashes[i];
    if (!h) throw new Error(`missing hash for chunk ${i}`);
    ordered.push(h);
  }
  return hashOfHashes(ordered);
}
