// src/lib/schedule/run-confirm-publication.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

export async function confirmPublication(service: ServiceClient, draftId: string, confirmedBy: string) {
  const { data, error } = await service.rpc('confirm_publication_transactional', {
    p_draft_id: draftId,
    p_confirmed_by: confirmedBy,
  });
  if (error) throw new Error(`Failed to confirm publication: ${error.message}`);
  return data;
}

export async function reassignBlockedParticipant(
  service: ServiceClient,
  draftItemId: string,
  newSessionId: string,
  reassignedBy: string
) {
  const { data, error } = await service.rpc('reassign_blocked_participant_transactional', {
    p_draft_item_id: draftItemId,
    p_new_session_id: newSessionId,
    p_reassigned_by: reassignedBy,
  });
  if (error) throw new Error(`Failed to reassign: ${error.message}`);
  return data;
}

export async function overridePublishWithGap(
  service: ServiceClient,
  draftItemId: string,
  overrideReason: string
) {
  // .eq('verdict', 'blocked_mandatory') means a stale/wrong/nonexistent
  // draftItemId matches zero rows — without .select(), PostgREST returns
  // 204/error: null for that case identically to a real update, so the
  // caller would get no signal anything went wrong. Select the updated
  // row back and throw if nothing matched, so this fails loudly like
  // confirmPublication/reassignBlockedParticipant already do.
  const { data, error } = await service
    .from('schedule_publication_draft_items')
    .update({ resolution: 'override_publish_with_gap', override_reason: overrideReason, verdict: 'publishable' })
    .eq('id', draftItemId)
    .eq('verdict', 'blocked_mandatory')
    .select('id');
  if (error) throw new Error(`Failed to record override: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(`Failed to record override: draft item ${draftItemId} not found or not blocked_mandatory`);
  }
}
