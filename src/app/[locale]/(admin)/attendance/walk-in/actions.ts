// src/app/[locale]/(admin)/attendance/walk-in/actions.ts
//
// Task 7 — standalone walk-in admission admin page. Thin 'use server'
// wrapper mirroring attendance/admissions/actions.ts's shape, but simpler:
// this feature is a single action, not a dispatch table into a shared
// *ForCaller library, so the identifier-resolution lookup and the
// admit_walk_in RPC call both live directly in this file rather than being
// split out to src/lib/attendance/ (no other caller needs either yet; see
// the design spec's "minimal standalone admin page" framing, scope
// decision 13).
'use server';

import { requireAdmissionStaffCaller } from '@/lib/admission/server-helpers';
import { buildIlikeOrFilter } from '@/lib/validation/postgrest-search';

export async function admitWalkIn(
  identifier: string,
  sessionId: string
): Promise<{ error: string } | { bookingId: string | null }> {
  const { session, service } = await requireAdmissionStaffCaller();

  const trimmed = identifier.trim();
  if (!sessionId) return { error: 'Select a session' };

  // Resolves the staff-entered identifier to an application_id before
  // calling the RPC, so a bad/ambiguous identifier produces a clear error
  // here rather than a confusing "Application not found or not accepted"
  // from admit_walk_in itself. Same columns and same buildIlikeOrFilter
  // helper as admission-lookup.ts's searchApplicationsForAdmissionForCaller
  // (application_number covers both pipelines; full_name/imported_email
  // cover the imported pipeline) — that existing search deliberately does
  // not also filter on the joined profiles.email, since PostgREST's
  // .or() cannot filter an embedded resource's own column, so this lookup
  // matches that precedent rather than inventing new filter syntax. A
  // self-registered applicant is looked up the same way staff already
  // look them up in the Admission Management console: by name or
  // application number.
  const orFilter = buildIlikeOrFilter(trimmed, ['application_number', 'full_name', 'imported_email']);
  if (!orFilter) return { error: 'Enter an application number or applicant name' };

  const { data: candidates, error: lookupError } = await service.from('applications').select('id, status').or(orFilter).limit(10);
  if (lookupError) return { error: lookupError.message };

  const accepted = (candidates ?? []).filter((row) => row.status === 'accepted');

  if (accepted.length === 0) {
    return { error: `No accepted application found for "${trimmed}"` };
  }
  if (accepted.length > 1) {
    return { error: `Multiple accepted applications match "${trimmed}" — enter the full application number` };
  }

  const { data, error } = await session.rpc('admit_walk_in', {
    p_application_id: accepted[0].id,
    p_session_id: sessionId,
  });
  if (error) return { error: error.message };
  return { bookingId: data };
}
