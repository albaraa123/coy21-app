import { describe, expect, it } from 'vitest';
import { deriveSeedFromBatchId } from '@/lib/import/seed-derivation';

describe('deriveSeedFromBatchId', () => {
  it('is reproducible for the same batch id', () => {
    const batchId = '11111111-2222-3333-4444-555555555555';
    expect(deriveSeedFromBatchId(batchId)).toBe(deriveSeedFromBatchId(batchId));
  });

  it('produces a positive int32 for a variety of UUIDs', () => {
    const ids = [
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      '11111111-2222-3333-4444-555555555555',
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    for (const id of ids) {
      const seed = deriveSeedFromBatchId(id);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0x7fffffff);
    }
  });

  it('produces different seeds for different batch ids (well-distributed, not a constant)', () => {
    const a = deriveSeedFromBatchId('11111111-2222-3333-4444-555555555555');
    const b = deriveSeedFromBatchId('99999999-8888-7777-6666-555555555555');
    expect(a).not.toBe(b);
  });

  it('is sensitive to small differences in the batch id (avalanche-ish, not e.g. just a length hash)', () => {
    const a = deriveSeedFromBatchId('11111111-2222-3333-4444-555555555555');
    const b = deriveSeedFromBatchId('11111111-2222-3333-4444-555555555556');
    expect(a).not.toBe(b);
  });
});
