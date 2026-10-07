// tests/api/scanner-health-route.test.ts
//
// Unit coverage for the scanner health-check Route Handler
// (src/app/api/scanner-health/route.ts), per sub-project 5b's Task 3 and
// spec's "Health-check mechanism" section. Mocks requireScannerDeviceCaller
// to drive each response code: a thrown UpstreamUnavailableError -> 503
// (still unreachable, keep polling); a thrown plain Error (genuine auth
// denial) -> 401 (stop and re-authenticate); a successful caller but a
// failing scan_attempts query -> 503; both succeeding -> 200.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireScannerDeviceCallerMock } = vi.hoisted(() => ({
  requireScannerDeviceCallerMock: vi.fn(),
}));

vi.mock('@/lib/scanner-device/server-helpers', () => ({
  requireScannerDeviceCaller: requireScannerDeviceCallerMock,
}));

import { GET } from '@/app/api/scanner-health/route';
import { UpstreamUnavailableError } from '@/lib/supabase/upstream-error';

function fakeService(selectResult: { error: unknown }) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(selectResult)),
      })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/scanner-health', () => {
  it('returns 503 when requireScannerDeviceCaller throws UpstreamUnavailableError (still unreachable, keep polling)', async () => {
    requireScannerDeviceCallerMock.mockRejectedValue(new UpstreamUnavailableError('profiles lookup failed transiently'));

    const response = await GET();
    expect(response.status).toBe(503);
  });

  it('returns 401 when requireScannerDeviceCaller throws a genuine denial (plain Error)', async () => {
    requireScannerDeviceCallerMock.mockRejectedValue(new Error('Not authorized'));

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it('returns 503 when the caller resolves but the scan_attempts database round-trip fails', async () => {
    requireScannerDeviceCallerMock.mockResolvedValue({ userId: 'user-1', service: fakeService({ error: { code: '' } }) });

    const response = await GET();
    expect(response.status).toBe(503);
  });

  it('returns 200 with Cache-Control: no-store when both the auth check and database round-trip succeed', async () => {
    requireScannerDeviceCallerMock.mockResolvedValue({ userId: 'user-1', service: fakeService({ error: null }) });

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
