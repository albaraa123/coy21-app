// src/app/[locale]/(participant)/(bare)/claim/actions.ts
'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/types/database';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
// NOTE: writeAuditLog is deliberately NOT imported here — see the audit
// logging note at the end of claimApplication for why an action-layer audit
// write is impossible (and unnecessary) on this path.

type AnyClient = SupabaseClient<Database>;

const claimApplicationSchema = z.object({ applicationId: z.string().uuid() });

// DELIBERATE DEVIATION from the service-role pattern every other server
// action in this phase uses (Tasks 12-20 all call
// requireAgendaStaffCaller() and then act via a service-role client).
//
// This action must NOT use a service-role client. The claim RPC is SECURITY
// DEFINER and asserts `p_claiming_user_id = auth.uid()` internally — that
// assertion is the DB-layer half of the ownership guarantee, and it only
// works if the RPC is invoked over the claiming participant's own
// authenticated session, where auth.uid() resolves from their verified JWT.
// A service-role call has no JWT and therefore no auth.uid(), so it would
// be rejected by the RPC's first check. That is the intended design, not an
// obstacle to route around: routing this through service-role would mean
// applicant_id could be set for ANY user id the server was persuaded to
// pass, which is precisely the ownership hole this whole task exists to
// close.
//
// Consequently there is no *ForCaller service-role variant of this action.
// The live test exercises it by constructing a real anon-key client signed
// in as the invited user (see tests/import/claim-live.test.ts) — which is a
// strictly more faithful reproduction of the production path than the
// service-role substitution used elsewhere.

/**
 * Claim an imported accepted-participant application for the currently
 * authenticated user.
 *
 * `sessionClient` exists only so the live test can supply a real
 * signed-in anon-key client (a 'use server' function cannot reach
 * next/headers' cookies() outside a Next.js request). It defaults to the
 * cookie-backed server client in production. It is NOT an auth bypass: the
 * user id is always read from the supplied client's own
 * auth.getUser() — never from an argument — and the RPC independently
 * re-derives auth.uid() from the JWT and rejects any mismatch.
 */
export async function claimApplication(
  applicationIdInput: unknown,
  sessionClient?: AnyClient
) {
  const { applicationId } = claimApplicationSchema.parse({ applicationId: applicationIdInput });

  const supabase = sessionClient ?? (await createClient());

  // getUser() (not getSession()) — it revalidates the JWT against the Auth
  // server rather than trusting an unverified cookie payload, the standard
  // @supabase/ssr guidance and what my-application/page.tsx already does.
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error('You must be signed in to claim an application');
  }

  const { error } = await supabase.rpc('claim_imported_application_transactional', {
    p_application_id: applicationId,
    p_claiming_user_id: user.id,
  });
  if (error) {
    // The RPC raises human-readable messages by design (notably the
    // already-claimed-a-different-record case), so surface the message
    // rather than a generic one. Nothing sensitive is embedded in them —
    // see the RPC's note on why the reject message deliberately does not
    // distinguish replay from wrong-user.
    throw new Error(error.message);
  }

  // AUDIT LOGGING — DEVIATION from the plan's literal "writes an audit log"
  // instruction for this action, for a concrete reason found while
  // implementing it.
  //
  // audit_logs has RLS enabled (20260722201600_agenda_reference_rls_policies
  // .sql) with a staff-only SELECT policy and NO insert policy for ANY
  // client role — inserts are deliberately service-role-only. This action
  // holds the participant's own RLS-scoped session (see the note above on
  // why it must), so an insert from here is guaranteed to be denied by RLS,
  // every single time. writeAuditLog swallows that failure (logs and
  // continues, by contract), so calling it here would not break the claim —
  // it would do something worse: emit a console error on every successful
  // claim while producing the false impression, to any future reader of
  // this file, that the action layer audits claims. It does not and cannot.
  //
  // Escalating to a service-role client purely to write this row was
  // considered and rejected: introducing a service-role client into the one
  // participant-facing action whose entire security model is "only ever
  // acts as the caller" is a materially worse trade than not writing a
  // duplicate audit row.
  //
  // The claim IS fully audited — the RPC writes its audit row INSIDE the
  // claim transaction (it is SECURITY DEFINER, so RLS does not apply to it),
  // matching the apply_import_row_transactional /
  // rollback_import_batch_transactional precedent. That row is strictly
  // better than an action-layer one: it is transactionally consistent with
  // the ownership write, so it can neither survive a rolled-back claim nor
  // be lost after a committed one. Nothing is unaudited as a result of this
  // deviation.
  return { success: true };
}

/**
 * Look up which application the CURRENTLY AUTHENTICATED user has a pending
 * invitation for, so the claim page never has to take an application id
 * from the client.
 *
 * Uses a service-role client for this one narrow read, because
 * participant_invitations is staff-only under RLS
 * (participant_invitations_staff_all, 20260726105000_import_rls_policies
 * .sql) — a participant's own session provably cannot read even its own
 * invitation row, so the caller's session client returns nothing here.
 *
 * Why that is safe despite claimApplication's deliberate refusal to use
 * service-role: the two do different things. This function only READS, only
 * ever filters by `invited_user_id = <the caller's own authenticated id>`
 * (derived from getUser(), never from an argument — this function takes no
 * arguments at all, so there is no input to tamper with), and returns
 * nothing but a single application id the caller is already entitled to
 * claim. It grants no ability the caller does not already have. The
 * ownership WRITE stays strictly on the caller's own session, where the
 * RPC's auth.uid() assertion can police it.
 *
 * NOTE for Task 10's getMyClaimState (src/lib/dashboard/
 * participant-dashboard-queries.ts): that function MUST delegate to this
 * one rather than re-deriving an equivalent query — see its own doc
 * comment for the corrected requirement. `sessionClient` below mirrors
 * claimApplication's own existing override in this same file, added for
 * the identical reason: a 'use server' function cannot reach next/headers'
 * cookies() outside a real Next.js request, so both this file's own live
 * test (tests/import/claim-live.test.ts) and getMyClaimState's live test
 * (tests/dashboard/participant-dashboard-queries-live.test.ts) need to
 * supply a real signed-in anon-key client directly. Optional and defaults
 * to the cookie-backed server client in production, so the existing
 * claim/page.tsx call site (which calls this with zero arguments) is
 * completely unaffected. Not an auth bypass: the user id is still always
 * read from the supplied client's own auth.getUser() — never from an
 * argument.
 */
export async function findMyClaimableApplication(
  sessionClient?: AnyClient
): Promise<{ applicationId?: string; error?: string }> {
  const supabase = sessionClient ?? (await createClient());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return { error: 'You must be signed in to claim an application' };
  }

  const service = createServiceRoleClient();
  const { data, error } = await service
    .from('participant_invitations')
    .select('application_id')
    .eq('invited_user_id', user.id)
    .eq('status', 'sent')
    .maybeSingle();

  if (error) {
    return { error: 'Could not look up your invitation' };
  }
  if (!data) {
    // Covers: already claimed (status moved to 'accepted'), revoked, failed,
    // or an authenticated user with no invitation at all. Deliberately one
    // undifferentiated message — see the RPC's note on not leaking claim
    // state to callers who may not be entitled to it.
    return {};
  }
  return { applicationId: data.application_id };
}
