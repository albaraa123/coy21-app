// src/app/api/scan-qr-attempt/route.ts
//
// The scanner's QR submission endpoint, moved from a Server Action
// (the former scanQrAttemptConfirm) to a Route Handler per sub-project
// 5b's Task 3 — see docs/superpowers/plans/2026-10-06-offline-scanning-
// support.md and docs/superpowers/specs/2026-10-06-offline-scanning-
// support-design.md. Next.js serializes Server Actions dispatched from
// the same client, so a retry would otherwise queue behind a hung
// original request; a Route Handler fetch()ed directly does not have
// that problem.
//
// This handler is the new home for what scanQrAttemptConfirm used to do
// (call requireScannerDeviceCaller(), then delegate) — classifying
// requireScannerDeviceCaller()'s own throw (now potentially an
// UpstreamUnavailableError per Task 0) before ever reaching
// scanQrAttemptConfirmForCaller, which itself takes an already-
// authenticated caller and never calls requireScannerDeviceCaller
// itself (see scan-qr-attempt.ts's header comment).
//
// Per spec line 184: the retryable/non-retryable distinction lives in
// the JSON response body, never the HTTP status — every classified
// outcome (success, retryable, non-retryable) returns HTTP 200, so the
// client's "any non-2xx or unparseable body means transport failure"
// rule never misfires on a deterministic server-side denial.
import { NextResponse } from 'next/server';
import { scanQrAttemptConfirmForCaller } from '@/lib/attendance/scan-qr-attempt';
import { requireScannerDeviceCaller } from '@/lib/scanner-device/server-helpers';
import { UpstreamUnavailableError } from '@/lib/supabase/upstream-error';

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { qrPayload, sessionId, deviceIdentifier, idempotencyKey } = body ?? {};
    if (typeof qrPayload !== 'string' || !isUuid(sessionId) || !isUuid(idempotencyKey)) {
      return NextResponse.json({ ok: false, retryable: false, message: 'Invalid request' }, { status: 200 });
    }

    let caller;
    try {
      caller = await requireScannerDeviceCaller();
    } catch (err) {
      if (err instanceof UpstreamUnavailableError) {
        return NextResponse.json({ ok: false, retryable: true, reason: 'upstream-unreachable' }, { status: 200 });
      }
      return NextResponse.json({ ok: false, retryable: false, message: err instanceof Error ? err.message : 'Not authorized' }, { status: 200 });
    }

    const outcome = await scanQrAttemptConfirmForCaller(
      { qrPayload, sessionId, deviceIdentifier: typeof deviceIdentifier === 'string' ? deviceIdentifier : null },
      caller,
      idempotencyKey
    );
    return NextResponse.json(outcome, { status: 200 });
  } catch {
    // An unexpected, unclassified throw must never look like "keep
    // retrying" to the client -- default to non-retryable.
    return NextResponse.json({ ok: false, retryable: false, message: 'Unexpected error' }, { status: 200 });
  }
}
