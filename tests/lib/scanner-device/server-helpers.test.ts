import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthSessionMissingError } from '@supabase/supabase-js';
import { UpstreamUnavailableError } from '@/lib/supabase/upstream-error';

// This is the first vi.mock('@/lib/supabase/server', ...) in this codebase
// (confirmed: no existing precedent to copy) -- requireScannerDeviceCaller
// is a thin wrapper around createClient()/createServiceRoleClient(), both
// imported from that module, so mocking it directly is the only way to
// control auth.getUser()/the profiles .single() query's { data, error }
// shape without a live Supabase project.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { requireScannerDeviceCaller } from '@/lib/scanner-device/server-helpers';

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

describe('requireScannerDeviceCaller', () => {
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

    await expect(requireScannerDeviceCaller()).rejects.toBeInstanceOf(UpstreamUnavailableError);
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
      await requireScannerDeviceCaller();
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
      await requireScannerDeviceCaller();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UpstreamUnavailableError);
    expect((caught as Error).message).toBe('Not authenticated');
  });

  it('throws UpstreamUnavailableError when getUser() itself fails with a retryable auth error (isAuthRetryableFetchError)', async () => {
    // AuthRetryableFetchError is not exported as a named class from
    // @supabase/supabase-js's public surface in a way convenient to
    // construct directly here, but isAuthRetryableFetchError checks
    // `error instanceof AuthRetryableFetchError` internally via a
    // `name`/prototype tag -- the real auth-js implementation flags it via
    // a dedicated error class. Simplest reliable way to produce a value
    // isAuthRetryableFetchError recognizes as true without depending on
    // auth-js's internal export surface: construct the real error type
    // through dynamic import of auth-js is unnecessary complexity here --
    // instead we mock isAuthRetryableFetchError's behavior indirectly by
    // using the actual class that ships in @supabase/supabase-js.
    const { AuthRetryableFetchError } = await import('@supabase/supabase-js');
    mockedCreateClient.mockResolvedValue(
      makeSupabaseClient({ data: { user: null }, error: new AuthRetryableFetchError('network error', 0) })
    );
    mockedCreateServiceRoleClient.mockReturnValue(makeServiceClient({ data: null, error: null }));

    await expect(requireScannerDeviceCaller()).rejects.toBeInstanceOf(UpstreamUnavailableError);
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
      await requireScannerDeviceCaller();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UpstreamUnavailableError);
  });
});
