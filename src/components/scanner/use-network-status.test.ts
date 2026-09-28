// src/components/scanner/use-network-status.test.ts
//
// Unit tests for the pure connectivity-reading decision
// (readNetworkStatus), exported specifically to be unit-testable
// without a React renderer — this repo has no @testing-library/react
// dependency (see device-identifier.test.ts's own precedent), so the
// hook's stateful wiring (useEffect + event listeners) is exercised
// only indirectly through this pure function.
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('readNetworkStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns "online" when navigator.onLine is true', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const { readNetworkStatus } = await import('./use-network-status');
    expect(readNetworkStatus()).toBe('online');
  });

  it('returns "offline" when navigator.onLine is false', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const { readNetworkStatus } = await import('./use-network-status');
    expect(readNetworkStatus()).toBe('offline');
  });

  it('defaults to "online" when navigator.onLine is unavailable (never blocks scanning on an unknown signal)', async () => {
    vi.stubGlobal('navigator', {});
    const { readNetworkStatus } = await import('./use-network-status');
    expect(readNetworkStatus()).toBe('online');
  });
});
