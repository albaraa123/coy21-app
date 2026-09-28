// src/lib/allocation/clustering.ts
export interface FeatureVector {
  applicationId: string;
  weights: Record<string, number>; // tagId -> weight, sparse
}

export interface KMeansCluster {
  index: number;
  centroid: Record<string, number>;
  memberCount: number;
}

export interface KMeansMembership {
  applicationId: string;
  clusterIndex: number;
  distanceToCentroid: number;
}

export interface KMeansResult {
  clusters: KMeansCluster[];
  memberships: KMeansMembership[];
}

// Simple mulberry32 PRNG for a fully deterministic, dependency-free seeded
// random sequence — the spec requires "identical seed+k+input -> byte
// identical output", which rules out Math.random.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function allTagIds(vectors: FeatureVector[]): string[] {
  const tags = new Set<string>();
  for (const v of vectors) for (const tagId of Object.keys(v.weights)) tags.add(tagId);
  return Array.from(tags).sort();
}

function euclideanDistance(a: Record<string, number>, b: Record<string, number>, tagIds: string[]): number {
  let sum = 0;
  for (const tagId of tagIds) {
    const diff = (a[tagId] ?? 0) - (b[tagId] ?? 0);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

const MAX_ITERATIONS = 100;

// K-means with a fixed seed over sparse tag-weight vectors. Analytical/
// reporting only per spec — never feeds allocation.
export function runKMeans(vectors: FeatureVector[], k: number, randomSeed: number): KMeansResult {
  const tagIds = allTagIds(vectors);
  const rand = mulberry32(randomSeed);

  // Deterministic seeded initial centroids: shuffle vector indices with the
  // seeded PRNG, take the first k as starting centroids.
  const indices = vectors.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  let centroids: Record<string, number>[] = indices.slice(0, k).map((i) => ({ ...vectors[i].weights }));

  let assignment: number[] = new Array(vectors.length).fill(0);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    const nextAssignment = vectors.map((v) => {
      let best = 0;
      let bestDist = Infinity;
      centroids.forEach((c, ci) => {
        const d = euclideanDistance(v.weights, c, tagIds);
        if (d < bestDist) {
          bestDist = d;
          best = ci;
        }
      });
      return best;
    });

    if (nextAssignment.some((v, i) => v !== assignment[i])) changed = true;
    assignment = nextAssignment;

    const nextCentroids: Record<string, number>[] = centroids.map(() => ({}));
    const counts = new Array(k).fill(0);
    vectors.forEach((v, i) => {
      const ci = assignment[i];
      counts[ci]++;
      for (const tagId of tagIds) {
        nextCentroids[ci][tagId] = (nextCentroids[ci][tagId] ?? 0) + (v.weights[tagId] ?? 0);
      }
    });
    centroids = nextCentroids.map((sum, ci) => {
      if (counts[ci] === 0) return centroids[ci]; // keep stale centroid for an empty cluster
      const avg: Record<string, number> = {};
      for (const tagId of tagIds) avg[tagId] = sum[tagId] / counts[ci];
      return avg;
    });

    if (!changed) break;
  }

  const clusters: KMeansCluster[] = centroids.map((centroid, index) => ({
    index,
    centroid,
    memberCount: assignment.filter((a) => a === index).length,
  }));

  const memberships: KMeansMembership[] = vectors.map((v, i) => ({
    applicationId: v.applicationId,
    clusterIndex: assignment[i],
    distanceToCentroid: euclideanDistance(v.weights, centroids[assignment[i]], tagIds),
  }));

  return { clusters, memberships };
}
