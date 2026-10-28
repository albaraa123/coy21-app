// src/lib/cafeteria/coffee-scan.test.ts
//
// Pure/mocked-boundary tests only -- the RPCs' actual eligibility/
// balance/concurrency behavior is already covered live in
// tests/cafeteria/coffee-rpc-live.test.ts. This file only proves the
// library-layer payload-parsing and amount-validation guards.
import { describe, it, expect } from 'vitest';
import { confirmCafeteriaCoffeeDeductionForCaller } from './coffee-scan';

describe('confirmCafeteriaCoffeeDeductionForCaller', () => {
  it('rejects a non-positive amount before ever resolving a credential or calling the RPC', async () => {
    const result = await confirmCafeteriaCoffeeDeductionForCaller(
      { qrPayload: 'cafe:v1:anything', amount: 0 },
      { userId: 'irrelevant', service: {} as never }
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a negative amount', async () => {
    const result = await confirmCafeteriaCoffeeDeductionForCaller(
      { qrPayload: 'cafe:v1:anything', amount: -5 },
      { userId: 'irrelevant', service: {} as never }
    );
    expect(result.ok).toBe(false);
  });
});
