// src/app/[locale]/(admin)/participants/import/[batchId]/rollback-action.ts
'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { idSchema } from '@/lib/validation/import';
import { requireImportStaffCaller } from '@/lib/import/server-helpers';
import { writeAuditLog } from '@/lib/agenda/server-helpers';

type ServiceClient = SupabaseClient<Database>;

// Uses requireImportStaffCaller (src/lib/import/server-helpers.ts), which
// accepts both agenda_allocation_manager and participants_communications_
// manager — see the identical note in confirm/actions.ts.
//
// This module is deliberately a THIN wrapper. Every decision that matters —
// which downstream references block a rollback, what "restore" means for
// applications and application_answers, and the all-or-nothing guarantee —
// lives in rollback_import_batch_transactional. Originally
// 20260726109000_rollback_import_batch_function.sql; superseded twice since
// (20260726109600_rollback_safety_fixes.sql, then
// 20260727010000_wire_row_fingerprint_idempotent_reimport.sql, the current
// body) via `create or replace function` — check the latest migration that
// replaces this function for the live behavior, not the original file.
// Because only the database can make those steps atomic: supabase-js has no
// client-side multi-statement transaction primitive, so doing any part of
// the rollback here would reintroduce exactly the non-atomicity Task 15's
// RPC exists to eliminate. Nothing in this file may be "helpfully" moved out
// of the RPC.

/**
 * Roll back an entire import batch.
 *
 * Refuses (throws) rather than partially applying if any application in the
 * batch is referenced by feature extraction, clustering, allocation, a
 * schedule publication, or a pending schedule-publication draft, or if any
 * of its participant invitations has left 'not_sent'. The thrown message
 * names the specific blocker so the admin knows which downstream artifact
 * to retract first. This blocker set MUST stay in sync with
 * fetchApplicationIdsWithDownstreamReference in ../preview/actions.ts —
 * see that function's comment for why a mismatch is dangerous.
 *
 * Split into a `...ForCaller` variant plus a `'use server'` wrapper to match
 * the rest of this feature: `'use server'` functions reach next/headers'
 * cookies() via requireImportStaffCaller, which throws outside a real
 * Next.js request, so live tests call this variant with a service-role
 * caller instead. Every DB-touching line is still exercised.
 */
export async function rollbackImportBatchForCaller(
  batchIdInput: unknown,
  caller: { userId: string; service: ServiceClient }
): Promise<void> {
  const batchId = idSchema.parse(batchIdInput);
  const { userId, service } = caller;

  const { error } = await service.rpc('rollback_import_batch_transactional', {
    p_batch_id: batchId,
    p_actor_id: userId,
  });

  if (error) {
    // The RPC's raise-exception messages are written to be admin-readable and
    // name the blocking dependency explicitly, so they are surfaced verbatim
    // rather than replaced with a generic failure string. Postgres prefixes
    // nothing useful here; error.message is the raise text.
    throw new Error(error.message);
  }

  // Audited from here IN ADDITION to the RPC's own internal audit rows, not
  // instead of them. The RPC writes per-application 'import_rollback_delete'
  // / 'import_rollback_restore' rows and a batch-level 'import_rollback' row
  // inside the transaction (so they can never claim a rollback that was
  // itself rolled back). This row records that the rollback was requested
  // through the admin action surface by this specific caller — the
  // provenance the in-transaction rows cannot capture, since the RPC only
  // receives an actor id and cannot know how it was invoked.
  await writeAuditLog(service, {
    entityType: 'import_batch',
    entityId: batchId,
    action: 'rollback_import_requested',
    actorId: userId,
  });
}

export async function rollbackImportBatch(batchIdInput: unknown): Promise<void> {
  const caller = await requireImportStaffCaller();
  return rollbackImportBatchForCaller(batchIdInput, caller);
}
