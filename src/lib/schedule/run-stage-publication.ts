// src/lib/schedule/run-stage-publication.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

export async function stagePublication(
  service: ServiceClient,
  stagedBy: string,
  source: { allocationRunId: string } | { changeEventIds: string[] }
): Promise<{ id: string }> {
  // Supabase's generated RPC Args types don't mark these params nullable
  // even though the SQL function's own signature accepts null for either
  // (exactly one of the two must be set — see stage_publication_transactional's
  // schedule_publication_drafts_one_source constraint) — a known gap in the
  // CLI's type generation for PL/pgSQL parameters, not a real type error.
  const { data, error } = await service.rpc('stage_publication_transactional', {
    p_allocation_run_id: ('allocationRunId' in source ? source.allocationRunId : null) as string,
    p_change_event_ids: ('changeEventIds' in source ? source.changeEventIds : null) as string[],
    p_staged_by: stagedBy,
  });
  if (error || !data) throw new Error(`Failed to stage publication: ${error?.message}`);
  return { id: data.id };
}
