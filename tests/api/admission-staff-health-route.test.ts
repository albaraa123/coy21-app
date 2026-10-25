// tests/api/admission-staff-health-route.test.ts
//
// Unit coverage for the walk-in admission page's health-check Route
// Handler (src/app/api/admission-staff-health/route.ts), per sub-project
// 5b's Task 5 and the design spec's "Architecture — Client Side
// (Walk-In Admin Page)" section: "a separate health-check Route Handler
// (GET /api/admission-staff-health), scoped to this page's actual auth
// boundary (requireWalkInStaffCaller's equivalent inline check, not
// requireScannerDeviceCaller), using the same 200/401/503 scheme as the
// scanner's health check." Mirrors tests/api/scanner-health-route.test.ts
// exactly, swapping the mocked auth helper and the database round-trip
// table.
//
// UPDATE (2026-10-25 staff narrowing): the route now imports
// requireWalkInStaffCaller from src/lib/walk-in/server-helpers.ts, split
// out of requireAdmissionStaffCaller (src/lib/admission/server-helpers.ts)
// specifically so patching that shared helper to reject `staff` (Step 4.6)
// would not also break walk-in admission. This test's mock target was
// updated to match.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireWalkInStaffCallerMock } = vi.hoisted(() => ({
  requireWalkInStaffCallerMock: vi.fn(),
}));

vi.mock('@/lib/walk-in/server-helpers', () => ({
  requireWalkInStaffCaller: requireWalkInStaffCallerMock,
}));

import { GET } from '@/app/api/admission-staff-health/route';
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

describe('GET /api/admission-staff-health', () => {
  it('returns 503 when requireWalkInStaffCaller throws UpstreamUnavailableError (still unreachable, keep polling)', async () => {
    requireWalkInStaffCallerMock.mockRejectedValue(new UpstreamUnavailableError('profiles lookup failed transiently'));

    const response = await GET();
    expect(response.status).toBe(503);
  });

  it('returns 401 when requireWalkInStaffCaller throws a genuine denial (plain Error)', async () => {
    requireWalkInStaffCallerMock.mockRejectedValue(new Error('Not authorized'));

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it('returns 503 when the caller resolves but the database round-trip fails', async () => {
    requireWalkInStaffCallerMock.mockResolvedValue({
      userId: 'user-1',
      session: {},
      service: fakeService({ error: { code: '' } }),
    });

    const response = await GET();
    expect(response.status).toBe(503);
  });

  it('returns 200 with Cache-Control: no-store when both the auth check and database round-trip succeed', async () => {
    requireWalkInStaffCallerMock.mockResolvedValue({
      userId: 'user-1',
      session: {},
      service: fakeService({ error: null }),
    });

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
