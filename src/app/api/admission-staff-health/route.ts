// src/app/api/admission-staff-health/route.ts
//
// A Route Handler that lets the walk-in admission form probe
// connectivity without queuing behind a hung Server Action (see
// sub-project 5b's Task 5 and the "Architecture — Client Side (Walk-In
// Admin Page)" section of docs/superpowers/specs/2026-10-06-offline-
// scanning-support-design.md). Scoped to this page's own auth boundary
// (requireAdmissionStaffCaller) — it cannot share the scanner's health
// check, which is gated on a different caller type entirely
// (requireScannerDeviceCaller).
//
// Same 200/401/503 response scheme as the scanner's
// src/app/api/scanner-health/route.ts, distinguishing "stop and
// re-authenticate" from "still unreachable, keep polling":
// - 200: the auth check succeeded AND the database round-trip succeeded.
// - 401: the auth check itself completed and genuinely rejected the
//   caller (a real, deterministic denial) — non-retryable.
// - 503: either the auth check itself could not complete (transport-
//   shaped failure, surfaced as UpstreamUnavailableError) or the
//   database round-trip failed — retryable, keep polling.
import { requireAdmissionStaffCaller } from '@/lib/admission/server-helpers';
import { UpstreamUnavailableError } from '@/lib/supabase/upstream-error';

export async function GET() {
  let caller;
  try {
    caller = await requireAdmissionStaffCaller();
  } catch (err) {
    if (err instanceof UpstreamUnavailableError) return new Response(null, { status: 503 });
    return new Response(null, { status: 401 });
  }

  // Trivial real round-trip against the database (head request, no row
  // data transferred) -- deliberately exercising the same authenticated
  // path a real walk-in admission would use, not a generic "is the
  // server reachable" ping. applications is the table the identifier
  // lookup actually queries.
  const { error } = await caller.service.from('applications').select('id', { head: true }).limit(0);
  if (error) return new Response(null, { status: 503 });

  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
