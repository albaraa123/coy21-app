// src/lib/allocation/scoring.ts
export interface SimilarityResult {
  score: number;
  isZeroVector: boolean;
}

// Cosine similarity between two sparse tag-weight vectors (tagId -> weight).
// Zero-vector convention (spec: Suitability Score): if either vector has
// zero magnitude, the result is mathematically undefined (0/0) — resolved to
// score 0 by convention, but distinguished via isZeroVector so callers can
// surface a different explanation than the "no overlap" case.
export function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): SimilarityResult {
  const tagIds = new Set([...Object.keys(a), ...Object.keys(b)]);

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const tagId of tagIds) {
    const av = a[tagId] ?? 0;
    const bv = b[tagId] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);

  if (magA === 0 || magB === 0) {
    return { score: 0, isZeroVector: true };
  }

  const raw = dot / (magA * magB);
  // Clamp for floating-point safety (cosine similarity of non-negative
  // weight vectors is mathematically in [0, 1], but FP rounding can push
  // slightly outside).
  return { score: Math.min(1, Math.max(0, raw)), isZeroVector: false };
}
