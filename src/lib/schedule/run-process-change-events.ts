// src/lib/schedule/run-process-change-events.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

// Reads unprocessed schedule_change_events, marks affected active
// schedule_publication_items 'stale' (time/room/speaker change) or
// 'pending_review' (cancellation) — never changes what a participant
// currently sees; a stale item still renders its last-published content
// until a new revision is actually published (spec: Staleness marking,
// orchestrator not trigger).
export async function processChangeEvents(service: ServiceClient): Promise<{ processedCount: number }> {
  const { data: events, error: eventsErr } = await service
    .from('schedule_change_events')
    .select('id, session_id, change_type')
    .is('processed_at', null);
  if (eventsErr) throw new Error(`Failed to load change events: ${eventsErr.message}`);
  if (!events || events.length === 0) return { processedCount: 0 };

  const sessionIds = [...new Set(events.map((e) => e.session_id))];
  const { data: items, error: itemsErr } = await service
    .from('schedule_publication_items')
    .select('id, session_id, item_status, schedule_publication_id, schedule_publications!inner(status)')
    .in('session_id', sessionIds)
    .eq('item_status', 'active')
    .eq('schedule_publications.status', 'active');
  if (itemsErr) throw new Error(`Failed to load affected items: ${itemsErr.message}`);

  const cancelledSessionIds = new Set(events.filter((e) => e.change_type === 'cancelled').map((e) => e.session_id));

  for (const item of items ?? []) {
    const newStatus = cancelledSessionIds.has(item.session_id!) ? 'pending_review' : 'stale';
    const { error: updateErr } = await service
      .from('schedule_publication_items')
      .update({ item_status: newStatus })
      .eq('id', item.id);
    if (updateErr) throw new Error(`Failed to mark item stale: ${updateErr.message}`);
  }

  const eventIds = events.map((e) => e.id);
  const { error: markProcessedErr } = await service
    .from('schedule_change_events')
    .update({ processed_at: new Date().toISOString() })
    .in('id', eventIds);
  if (markProcessedErr) throw new Error(`Failed to mark events processed: ${markProcessedErr.message}`);

  return { processedCount: events.length };
}
