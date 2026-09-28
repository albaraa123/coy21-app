// src/lib/scanner-device/server-helpers.ts
//
// Mirrors src/lib/program-attendance/server-helpers.ts's
// requireProgramAttendanceStaffCaller exact shape, checking
// isScannerDeviceRole instead.
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isScannerDeviceRole } from '@/lib/validation/scanner-device';

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
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
  // Single source of truth for this check is isScannerDeviceRole in
  // src/lib/validation/scanner-device.ts — update that helper, not this
  // call site, if the allowed role set changes.
  if (!isScannerDeviceRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, service };
}
