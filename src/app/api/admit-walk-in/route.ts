// src/app/api/admit-walk-in/route.ts
//
// The walk-in admission page's submission endpoint, moved from a Server
// Action (the former admitWalkIn in
// src/app/[locale]/(admin)/attendance/walk-in/actions.ts) to a Route
// Handler per sub-project 5b's Task 5 — same platform-constraint reason
// as Task 3's scan-qr-attempt Route Handler: Next.js serializes Server
// Actions dispatched from the same client, so a retry would otherwise
// queue behind a hung original request.
//
// Ports the identifier-resolution logic that used to live in actions.ts
// (buildIlikeOrFilter against applications.application_number/
// full_name/imported_email, then the accepted/ambiguous/not-found
// branches) unchanged in substance, plus two fixes the design spec calls
// out explicitly:
// - The identifier-lookup query must check its OWN error via
//   isTransportShapedError before concluding "no match" — same layer-2
//   fix as the scanner's verifyScannerScope. A query that itself failed
//   (populated error) must never be read as a confident "not found"
//   denial.
// - The admit_walk_in RPC call uses the caller's own authenticated
//   `session` client, NEVER `service` — is_staff() and
//   scanned_by = auth.uid() inside the function need the real signed-in
//   user's identity, which only `session` carries.
//
// Per spec's three-layer classification scheme (mirroring scan-qr-
// attempt/route.ts exactly): every classified outcome (success,
// retryable, non-retryable) returns HTTP 200, so the client's "any
// non-2xx or unparseable body means transport failure" rule never
// misfires on a deterministic server-side denial.
import { NextResponse } from 'next/server';
import { requireAdmissionStaffCaller } from '@/lib/admission/server-helpers';
import { buildIlikeOrFilter } from '@/lib/validation/postgrest-search';
import { isTransportShapedError } from '@/lib/supabase/upstream-error';
import { UpstreamUnavailableError } from '@/lib/supabase/upstream-error';

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

type AdmitWalkInOutcome = { ok: true; bookingId: string } | { ok: false; retryable: boolean; message: string };

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { identifier, sessionId, idempotencyKey } = body ?? {};
    if (typeof identifier !== 'string' || !isUuid(sessionId) || !isUuid(idempotencyKey)) {
      return NextResponse.json<AdmitWalkInOutcome>({ ok: false, retryable: false, message: 'Invalid request' }, { status: 200 });
    }

    const trimmed = identifier.trim();
    const orFilter = buildIlikeOrFilter(trimmed, ['application_number', 'full_name', 'imported_email']);
    if (!orFilter) {
      return NextResponse.json<AdmitWalkInOutcome>(
        { ok: false, retryable: false, message: 'Enter an application number or applicant name' },
        { status: 200 }
      );
    }

    let caller;
    try {
      caller = await requireAdmissionStaffCaller();
    } catch (err) {
      if (err instanceof UpstreamUnavailableError) {
        return NextResponse.json<AdmitWalkInOutcome>({ ok: false, retryable: true, message: 'Upstream unavailable' }, { status: 200 });
      }
      return NextResponse.json<AdmitWalkInOutcome>(
        { ok: false, retryable: false, message: err instanceof Error ? err.message : 'Not authorized' },
        { status: 200 }
      );
    }
    const { service, session } = caller;

    // limit(10) is just a sane UI cap on the candidate list -- any
    // count >=2 already routes to the ambiguous-match branch below, so
    // truncation here never changes which branch fires. Same precedent
    // as the former actions.ts's admitWalkIn.
    const { data: candidates, error: lookupError } = await service.from('applications').select('id, status').or(orFilter).limit(10);
    // Layer-2 fix: a query that itself failed must never be read as a
    // confident "no match" denial -- only a clean, error-free, genuinely
    // empty result is a real, non-retryable "not found".
    if (lookupError && isTransportShapedError(lookupError)) {
      return NextResponse.json<AdmitWalkInOutcome>({ ok: false, retryable: true, message: 'Upstream unavailable' }, { status: 200 });
    }
    if (lookupError) {
      return NextResponse.json<AdmitWalkInOutcome>({ ok: false, retryable: false, message: lookupError.message }, { status: 200 });
    }

    const accepted = (candidates ?? []).filter((row) => row.status === 'accepted');

    if (accepted.length === 0) {
      return NextResponse.json<AdmitWalkInOutcome>(
        { ok: false, retryable: false, message: `No accepted application found for "${trimmed}"` },
        { status: 200 }
      );
    }
    if (accepted.length > 1) {
      return NextResponse.json<AdmitWalkInOutcome>(
        { ok: false, retryable: false, message: `Multiple accepted applications match "${trimmed}" — enter the full application number` },
        { status: 200 }
      );
    }

    // Critical: the RPC call MUST use `session` (the caller's own
    // authenticated client), never `service` -- is_staff() and
    // scanned_by = auth.uid() inside admit_walk_in need the real
    // signed-in user's identity, which only `session` carries.
    const { data, error } = await session.rpc('admit_walk_in', {
      p_application_id: accepted[0].id,
      p_session_id: sessionId,
      p_idempotency_key: idempotencyKey,
    });
    if (error) {
      if (isTransportShapedError(error)) {
        return NextResponse.json<AdmitWalkInOutcome>({ ok: false, retryable: true, message: 'Upstream unavailable' }, { status: 200 });
      }
      return NextResponse.json<AdmitWalkInOutcome>({ ok: false, retryable: false, message: error.message }, { status: 200 });
    }

    return NextResponse.json<AdmitWalkInOutcome>({ ok: true, bookingId: data }, { status: 200 });
  } catch {
    // An unexpected, unclassified throw must never look like "keep
    // retrying" to the client -- default to non-retryable, same as
    // scan-qr-attempt/route.ts's own catch-all.
    return NextResponse.json<AdmitWalkInOutcome>({ ok: false, retryable: false, message: 'Unexpected error' }, { status: 200 });
  }
}
