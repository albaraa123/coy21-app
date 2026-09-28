// src/lib/import/seed-derivation.ts
//
// Derives a deterministic, reproducible random seed for runClustering from
// an import batch's UUID. Kept separate from src/lib/import/normalization.ts
// (which is exclusively row-value normalization: email/phone/yes-no/
// multi-select parsing and dedup fingerprinting) since this concern —
// batch-id -> clustering seed — is unrelated to row data and belongs with
// Task 17's downstream-processing code instead.
//
// Uses a simple, well-known string hash (djb2 variant) rather than pulling
// in a crypto hash — this seed only needs to be stable and well-distributed
// across different batch ids, not cryptographically secure, and the same
// batch id must always produce the same seed (required for the "identical
// seed+k+input -> identical clustering output" reproducibility guarantee
// runClustering documents).

/**
 * Derive a stable positive int32 seed from a batch UUID string. The same
 * batchId always produces the same seed (reproducibility for runClustering).
 */
export function deriveSeedFromBatchId(batchId: string): number {
  // djb2 hash, computed over 32-bit unsigned arithmetic via `>>> 0` so it
  // never overflows into an unsafe float or goes negative mid-computation.
  let hash = 5381;
  for (let i = 0; i < batchId.length; i++) {
    hash = ((hash * 33) ^ batchId.charCodeAt(i)) >>> 0;
  }
  // Mask off the sign bit so the result is always a positive int32
  // (0 .. 2^31 - 1), matching "truncated to a positive int32".
  return hash & 0x7fffffff;
}
