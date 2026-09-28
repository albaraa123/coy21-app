// tests/allocation/clustering.test.ts
import { describe, expect, it } from 'vitest';
import { runKMeans, type FeatureVector } from '@/lib/allocation/clustering';

const vectors: FeatureVector[] = [
  { applicationId: 'app-1', weights: { 'tag-a': 1.0 } },
  { applicationId: 'app-2', weights: { 'tag-a': 0.9 } },
  { applicationId: 'app-3', weights: { 'tag-b': 1.0 } },
  { applicationId: 'app-4', weights: { 'tag-b': 0.8 } },
];

describe('runKMeans', () => {
  it('is deterministic: identical seed+k+input produces byte-identical output across repeated invocations', () => {
    const first = runKMeans(vectors, 2, 42);
    const second = runKMeans(vectors, 2, 42);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('groups clearly separated points into distinct clusters', () => {
    const result = runKMeans(vectors, 2, 42);
    expect(result.clusters).toHaveLength(2);
    const clusterOfApp1 = result.memberships.find((m) => m.applicationId === 'app-1')!.clusterIndex;
    const clusterOfApp2 = result.memberships.find((m) => m.applicationId === 'app-2')!.clusterIndex;
    const clusterOfApp3 = result.memberships.find((m) => m.applicationId === 'app-3')!.clusterIndex;
    expect(clusterOfApp1).toBe(clusterOfApp2);
    expect(clusterOfApp1).not.toBe(clusterOfApp3);
  });

  it('produces a centroid and member_count consistent with membership rows', () => {
    const result = runKMeans(vectors, 2, 42);
    for (const cluster of result.clusters) {
      const memberCount = result.memberships.filter((m) => m.clusterIndex === cluster.index).length;
      expect(cluster.memberCount).toBe(memberCount);
    }
  });

  it('a different seed may change assignment but the function remains a pure deterministic function of its inputs', () => {
    const a = runKMeans(vectors, 2, 1);
    const b = runKMeans(vectors, 2, 1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
