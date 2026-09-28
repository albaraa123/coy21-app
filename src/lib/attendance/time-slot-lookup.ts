// src/lib/attendance/time-slot-lookup.ts
//
// Given a specific session_id, find its time_slot_group_key by reusing the
// existing allocation-time grouping logic (src/lib/allocation/time-slot-
// grouping.ts) — never recomputes conflict-detection logic independently.
// Needed at scan time to check "is this participant already admitted to a
// DIFFERENT session in the same time slot" without a stored per-session
// group-key column (sessions.time_slot_group_key does not exist — only
// attendance_records.time_slot_group_key, computed via this helper at
// insert time).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { groupSessionsIntoTimeSlots, type SessionForGrouping } from '@/lib/allocation/time-slot-grouping';

type ServiceClient = SupabaseClient<Database>;

export async function computeTimeSlotGroupKeyForSession(service: ServiceClient, sessionId: string): Promise<string> {
  const { data: target, error: targetError } = await service.from('sessions').select('id, conference_day_id').eq('id', sessionId).single();
  if (targetError || !target) throw new Error(`Session ${sessionId} not found`);

  const { data: daySessions, error: dayError } = await service
    .from('sessions')
    .select('id, conference_day_id, start_time, end_time, is_mandatory')
    .eq('conference_day_id', target.conference_day_id);
  if (dayError) throw new Error(`Failed to load sessions for conference day: ${dayError.message}`);

  const forGrouping: SessionForGrouping[] = (daySessions ?? []).map((s) => ({
    id: s.id,
    conferenceDayId: s.conference_day_id,
    startTime: s.start_time,
    endTime: s.end_time,
    isMandatory: s.is_mandatory,
  }));

  const groups = groupSessionsIntoTimeSlots(forGrouping);
  const group = groups.find((g) => g.sessionIds.includes(sessionId));
  if (!group) throw new Error(`Session ${sessionId} not found in any computed time-slot group`);
  return group.timeSlotGroupKey;
}
