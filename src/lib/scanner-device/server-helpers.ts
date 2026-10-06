// src/lib/scanner-device/server-helpers.ts
//
// Mirrors src/lib/program-attendance/server-helpers.ts's
// requireProgramAttendanceStaffCaller exact shape, checking
// isScannerDeviceRole instead.
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isScannerDeviceRole } from '@/lib/validation/scanner-device';
import { UpstreamUnavailableError, isTransportShapedError } from '@/lib/supabase/upstream-error';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

// The service-role client bypasses RLS entirely, so this role check — not
// RLS — is the actual authorization gate for every write made by callers of
// this helper. Every server action reachable by the scanner device role must
// call this before any service-role read/write, and must not contain an
// early return that skips it.
export async function requireScannerDeviceCaller(): Promise<{ userId: string; service: ServiceClient }> {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError && isAuthRetryableFetchError(userError)) {
    throw new UpstreamUnavailableError('auth.getUser() failed transiently');
  }
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  // Use the SAME shared classification table as everywhere else in this
  // sub-project, not a narrower ad hoc check -- treating every non-
  // PGRST116 error code as transient and retryable forever would wrongly
  // make a genuine 42501 permission-denied (which this project has hit
  // for real before) retry forever instead of correctly surfacing it as a
  // real, non-retryable problem.
  if (error && isTransportShapedError(error)) {
    throw new UpstreamUnavailableError('profiles lookup failed transiently');
  }
  if (!profile) throw new Error('Profile not found');
  // Single source of truth for this check is isScannerDeviceRole in
  // src/lib/validation/scanner-device.ts — update that helper, not this
  // call site, if the allowed role set changes.
  if (!isScannerDeviceRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, service };
}
