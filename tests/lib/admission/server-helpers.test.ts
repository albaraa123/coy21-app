import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthSessionMissingError } from '@supabase/supabase-js';
import { UpstreamUnavailableError } from '@/lib/supabase/upstream-error';

// Same bug, same fix, same first-of-its-kind vi.mock('@/lib/supabase/server',
// ...) pattern as tests/lib/scanner-device/server-helpers.test.ts -- see that
// file's header comment for why this is the first such mock in the codebase.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { requireAdmissionStaffCaller } from '@/lib/admission/server-helpers';

const mockedCreateClient = createClient as unknown as ReturnType<typeof vi.fn>;
const mockedCreateServiceRoleClient = createServiceRoleClient as unknown as ReturnType<typeof vi.fn>;

function makeSupabaseClient(getUserResult: { data: { user: unknown }; error: unknown }) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue(getUserResult),
    },
  };
}

function makeServiceClient(singleResult: { data: unknown; error: unknown }) {
  const single = vi.fn().mockResolvedValue(singleResult);
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { from };
}

const REAL_USER = { id: 'user-123' };

describe('requireAdmissionStaffCaller', () => {
  beforeEach(() => {
    mockedCreateClient.mockReset();
    mockedCreateServiceRoleClient.mockReset();
  });

  it('throws UpstreamUnavailableError when the profiles .single() query itself fails with a transport-shaped error (not PGRST116)', async () => {
    mockedCreateClient.mockResolvedValue(
      makeSupabaseClient({ data: { user: REAL_USER }, error: null })
    );
    mockedCreateServiceRoleClient.mockReturnValue(
      makeServiceClient({ data: null, error: { code: '', message: 'fetch failed' } })
    );

    await expect(requireAdmissionStaffCaller()).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('still throws a plain, non-retryable error for a genuine missing profile (PGRST116)', async () => {
    mockedCreateClient.mockResolvedValue(
      makeSupabaseClient({ data: { user: REAL_USER }, error: null })
    );
    mockedCreateServiceRoleClient.mockReturnValue(
      makeServiceClient({
        data: null,
        error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
      })
    );

    let caught: unknown;
    try {
      await requireAdmissionStaffCaller();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UpstreamUnavailableError);
    expect((caught as Error).message).toBe('Profile not found');
  });

  it('throws a non-retryable error (not UpstreamUnavailableError) when getUser() returns AuthSessionMissingError (genuinely logged out)', async () => {
    mockedCreateClient.mockResolvedValue(
      makeSupabaseClient({ data: { user: null }, error: new AuthSessionMissingError() })
    );
    mockedCreateServiceRoleClient.mockReturnValue(makeServiceClient({ data: null, error: null }));

    let caught: unknown;
    try {
      await requireAdmissionStaffCaller();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UpstreamUnavailableError);
    expect((caught as Error).message).toBe('Not authenticated');
  });

  it('throws UpstreamUnavailableError when getUser() itself fails with a retryable auth error (isAuthRetryableFetchError)', async () => {
    const { AuthRetryableFetchError } = await import('@supabase/supabase-js');
    mockedCreateClient.mockResolvedValue(
      makeSupabaseClient({ data: { user: null }, error: new AuthRetryableFetchError('network error', 0) })
    );
    mockedCreateServiceRoleClient.mockReturnValue(makeServiceClient({ data: null, error: null }));

    await expect(requireAdmissionStaffCaller()).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('throws a plain, non-retryable error (not UpstreamUnavailableError) for a genuine permission-denied (42501) on the profiles query', async () => {
    mockedCreateClient.mockResolvedValue(
      makeSupabaseClient({ data: { user: REAL_USER }, error: null })
    );
    mockedCreateServiceRoleClient.mockReturnValue(
      makeServiceClient({ data: null, error: { code: '42501', message: 'permission denied for table profiles' } })
    );

    let caught: unknown;
    try {
      await requireAdmissionStaffCaller();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UpstreamUnavailableError);
  });
});
