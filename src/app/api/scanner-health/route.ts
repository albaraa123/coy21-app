// src/app/api/scanner-health/route.ts
//
// A Route Handler that lets the scanner client probe connectivity
// without queuing behind a hung Server Action (see sub-project 5b's
// Task 3 and the "Health-check mechanism" section of
// docs/superpowers/specs/2026-10-06-offline-scanning-support-design.md).
// Reached through the same auth boundary and service-role client as the
// scan Route Handler, performing one trivial real round-trip against the
// database — deliberately exercising the same authenticated path a real
// scan would use, not a generic "is the server reachable" ping.
//
// Response codes distinguish "stop and re-authenticate" from "still
// unreachable, keep polling":
// - 200: the auth check succeeded AND the database round-trip succeeded.
// - 401: the auth check itself completed and genuinely rejected the
//   caller (a real, deterministic denial) — non-retryable.
// - 503: either the auth check itself could not complete (transport-
//   shaped failure, surfaced as UpstreamUnavailableError) or the
//   database round-trip failed — retryable, keep polling.
import { requireScannerDeviceCaller } from '@/lib/scanner-device/server-helpers';
import { UpstreamUnavailableError } from '@/lib/supabase/upstream-error';

export async function GET() {
  let caller;
  try {
    caller = await requireScannerDeviceCaller();
  } catch (err) {
    if (err instanceof UpstreamUnavailableError) return new Response(null, { status: 503 });
    return new Response(null, { status: 401 });
  }

  const { error } = await caller.service.from('scan_attempts').select('id', { head: true }).limit(0);
  if (error) return new Response(null, { status: 503 });

  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
