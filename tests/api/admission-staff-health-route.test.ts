// tests/api/admission-staff-health-route.test.ts
//
// Unit coverage for the walk-in admission page's health-check Route
// Handler (src/app/api/admission-staff-health/route.ts), per sub-project
// 5b's Task 5 and the design spec's "Architecture — Client Side
// (Walk-In Admin Page)" section: "a separate health-check Route Handler
// (GET /api/admission-staff-health), scoped to this page's actual auth
// boundary (requireAdmissionStaffCaller's equivalent inline check, not
// requireScannerDeviceCaller), using the same 200/401/503 scheme as the
// scanner's health check." Mirrors tests/api/scanner-health-route.test.ts
// exactly, swapping the mocked auth helper and the database round-trip
// table.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAdmissionStaffCallerMock } = vi.hoisted(() => ({
  requireAdmissionStaffCallerMock: vi.fn(),
}));

vi.mock('@/lib/admission/server-helpers', () => ({
  requireAdmissionStaffCaller: requireAdmissionStaffCallerMock,
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
  it('returns 503 when requireAdmissionStaffCaller throws UpstreamUnavailableError (still unreachable, keep polling)', async () => {
    requireAdmissionStaffCallerMock.mockRejectedValue(new UpstreamUnavailableError('profiles lookup failed transiently'));

    const response = await GET();
    expect(response.status).toBe(503);
  });

  it('returns 401 when requireAdmissionStaffCaller throws a genuine denial (plain Error)', async () => {
    requireAdmissionStaffCallerMock.mockRejectedValue(new Error('Not authorized'));

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it('returns 503 when the caller resolves but the database round-trip fails', async () => {
    requireAdmissionStaffCallerMock.mockResolvedValue({
      userId: 'user-1',
      session: {},
      service: fakeService({ error: { code: '' } }),
    });

    const response = await GET();
    expect(response.status).toBe(503);
  });

  it('returns 200 with Cache-Control: no-store when both the auth check and database round-trip succeed', async () => {
    requireAdmissionStaffCallerMock.mockResolvedValue({
      userId: 'user-1',
      session: {},
      service: fakeService({ error: null }),
    });

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
