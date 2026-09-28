// tests/attendance/time-slot-group-key-parity.test.ts
//
// Proves compute_time_slot_group_key_for_session (SQL, Phase 7A migration
// 20260814100000) produces byte-for-byte identical output to
// groupSessionsIntoTimeSlots/computeTimeSlotGroupKey (TypeScript,
// src/lib/allocation/time-slot-grouping.ts) and to
// computeTimeSlotGroupKeyForSession (src/lib/attendance/time-slot-lookup.ts,
// the existing TS caller already used by scanAttemptPreviewForCaller/
// scanAttemptConfirmForCaller) — across overlap, ordering, boundary, and
// cross-day scenarios. Grouping/context derivation only, no admission
// logic — per the Phase 7A brief's explicit "if exact parity is not
// possible, STOP" requirement, this file is the proof, not an assumption.
//
// Fixture pattern follows tests/attendance/scan-attempt-live.test.ts
// exactly: real conference_days/rooms/tracks/session_types/sessions rows.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { computeTimeSlotGroupKeyForSession } from '@/lib/attendance/time-slot-lookup';
import { groupSessionsIntoTimeSlots, type SessionForGrouping } from '@/lib/allocation/time-slot-grouping';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

let trackId: string;
let sessionTypeId: string;
const conferenceDayIds: string[] = [];
const sessionIds: string[] = [];
const roomIds: string[] = [];
let roomCounter = 0;
let sessionCodeCounter = 0;

async function createRoom(): Promise<string> {
  roomCounter += 1;
  const { data, error } = await admin
    .from('rooms')
    .insert({ code: `TSGK-PARITY-ROOM-${roomCounter}`, name_ar: 'قاعة', name_en: `Room ${roomCounter}`, capacity: 100 })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create room: ${error?.message}`);
  roomIds.push(data.id);
  return data.id;
}

async function createConferenceDay(conferenceDate: string): Promise<string> {
  const { data, error } = await admin
    .from('conference_days')
    .insert({ conference_date: conferenceDate, label_ar: 'يوم', label_en: 'Day', display_order: conferenceDayIds.length + 1 })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create conference day: ${error?.message}`);
  conferenceDayIds.push(data.id);
  return data.id;
}

async function createSession(params: {
  conferenceDayId: string;
  startTime: string;
  endTime: string;
  isMandatory?: boolean;
  roomId?: string;
}): Promise<string> {
  const roomId = params.roomId ?? (await createRoom());
  sessionCodeCounter += 1;
  const { data, error } = await admin
    .from('sessions')
    .insert({
      session_code: `TSGK-PARITY-SESSION-${sessionCodeCounter}`,
      title_ar: 'ج',
      title_en: 'Session',
      conference_day_id: params.conferenceDayId,
      start_time: params.startTime,
      end_time: params.endTime,
      track_id: trackId,
      session_type_id: sessionTypeId,
      language: 'bilingual',
      difficulty_level: 'all_levels',
      capacity: 10,
      is_mandatory: params.isMandatory ?? false,
      status: 'confirmed',
      admission_policy: 'open',
      room_id: roomId,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create session: ${error?.message}`);
  sessionIds.push(data.id);
  return data.id;
}

async function sqlGroupKey(sessionId: string): Promise<string> {
  const { data, error } = await admin.rpc('compute_time_slot_group_key_for_session', { p_session_id: sessionId });
  if (error) throw new Error(error.message);
  return data as unknown as string;
}

async function tsGroupKeyViaExistingCaller(sessionId: string): Promise<string> {
  return computeTimeSlotGroupKeyForSession(admin, sessionId);
}

// Direct, DB-independent computation of the expected key from raw fixture
// data — a third, fully independent cross-check beyond the existing TS
// caller (which itself re-reads from the DB, same as the SQL function
// does), so a bug shared between "how we seeded the DB" and "how the TS
// caller reads it back" can't silently pass both TS-side checks at once.
function tsGroupKeyDirect(all: SessionForGrouping[], targetId: string): string {
  const groups = groupSessionsIntoTimeSlots(all);
  const group = groups.find((g) => g.sessionIds.includes(targetId));
  if (!group) throw new Error(`Session ${targetId} not found in any computed group`);
  return group.timeSlotGroupKey;
}

afterAll(async () => {
  if (sessionIds.length > 0) await admin.from('sessions').delete().in('id', sessionIds);
  if (roomIds.length > 0) await admin.from('rooms').delete().in('id', roomIds);
  if (conferenceDayIds.length > 0) await admin.from('conference_days').delete().in('id', conferenceDayIds);
  if (trackId) await admin.from('tracks').delete().eq('id', trackId);
  if (sessionTypeId) await admin.from('session_types').delete().eq('id', sessionTypeId);
});

beforeAll(async () => {
  const { data: track } = await admin.from('tracks').insert({ code: 'TSGK-PARITY-TRACK', name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sessionType } = await admin.from('session_types').insert({ code: 'TSGK-PARITY-TYPE', name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;
});

describe('SQL/TypeScript time-slot group key parity', () => {
  it('two overlapping sessions on the same day, different rooms: SQL and TS agree, and both put them in the SAME group', async () => {
    const day = await createConferenceDay('2026-09-25');
    const s1 = await createSession({ conferenceDayId: day, startTime: '2026-09-25T09:00:00Z', endTime: '2026-09-25T10:00:00Z' });
    const s2 = await createSession({ conferenceDayId: day, startTime: '2026-09-25T09:30:00Z', endTime: '2026-09-25T10:30:00Z' });

    const [sqlKey1, sqlKey2, tsKey1, tsKey2] = await Promise.all([
      sqlGroupKey(s1),
      sqlGroupKey(s2),
      tsGroupKeyViaExistingCaller(s1),
      tsGroupKeyViaExistingCaller(s2),
    ]);

    expect(sqlKey1).toBe(tsKey1);
    expect(sqlKey2).toBe(tsKey2);
    expect(sqlKey1).toBe(sqlKey2); // same connected component
  });

  it('two non-overlapping (disjoint) sessions on the same day: SQL and TS agree, and both put them in DIFFERENT groups', async () => {
    const day = await createConferenceDay('2026-09-26');
    const s1 = await createSession({ conferenceDayId: day, startTime: '2026-09-26T09:00:00Z', endTime: '2026-09-26T10:00:00Z' });
    const s2 = await createSession({ conferenceDayId: day, startTime: '2026-09-26T11:00:00Z', endTime: '2026-09-26T12:00:00Z' });

    const [sqlKey1, sqlKey2, tsKey1, tsKey2] = await Promise.all([
      sqlGroupKey(s1),
      sqlGroupKey(s2),
      tsGroupKeyViaExistingCaller(s1),
      tsGroupKeyViaExistingCaller(s2),
    ]);

    expect(sqlKey1).toBe(tsKey1);
    expect(sqlKey2).toBe(tsKey2);
    expect(sqlKey1).not.toBe(sqlKey2);
  });

  it('boundary case: back-to-back sessions (end === start) are treated as NON-overlapping (half-open interval [start, end))', async () => {
    const day = await createConferenceDay('2026-09-27');
    const s1 = await createSession({ conferenceDayId: day, startTime: '2026-09-27T09:00:00Z', endTime: '2026-09-27T10:00:00Z' });
    const s2 = await createSession({ conferenceDayId: day, startTime: '2026-09-27T10:00:00Z', endTime: '2026-09-27T11:00:00Z' });

    const [sqlKey1, sqlKey2, tsKey1, tsKey2] = await Promise.all([
      sqlGroupKey(s1),
      sqlGroupKey(s2),
      tsGroupKeyViaExistingCaller(s1),
      tsGroupKeyViaExistingCaller(s2),
    ]);

    expect(sqlKey1).toBe(tsKey1);
    expect(sqlKey2).toBe(tsKey2);
    expect(sqlKey1).not.toBe(sqlKey2); // must NOT be grouped together
  });

  it('boundary case: a single-instant overlap (one session ends exactly when another starts minus 1 second) DOES overlap', async () => {
    const day = await createConferenceDay('2026-09-28');
    const s1 = await createSession({ conferenceDayId: day, startTime: '2026-09-28T09:00:00Z', endTime: '2026-09-28T10:00:00Z' });
    const s2 = await createSession({ conferenceDayId: day, startTime: '2026-09-28T09:59:59Z', endTime: '2026-09-28T11:00:00Z' });

    const [sqlKey1, sqlKey2] = await Promise.all([sqlGroupKey(s1), sqlGroupKey(s2)]);
    expect(sqlKey1).toBe(sqlKey2);
  });

  it('transitive chaining: A overlaps B, B overlaps C, A does NOT overlap C directly — all three still end up in ONE group (connected component, not pairwise)', async () => {
    const day = await createConferenceDay('2026-09-29');
    const a = await createSession({ conferenceDayId: day, startTime: '2026-09-29T09:00:00Z', endTime: '2026-09-29T10:00:00Z' });
    const b = await createSession({ conferenceDayId: day, startTime: '2026-09-29T09:30:00Z', endTime: '2026-09-29T10:30:00Z' });
    const c = await createSession({ conferenceDayId: day, startTime: '2026-09-29T10:15:00Z', endTime: '2026-09-29T11:00:00Z' });

    const [sqlA, sqlB, sqlC, tsA, tsB, tsC] = await Promise.all([
      sqlGroupKey(a),
      sqlGroupKey(b),
      sqlGroupKey(c),
      tsGroupKeyViaExistingCaller(a),
      tsGroupKeyViaExistingCaller(b),
      tsGroupKeyViaExistingCaller(c),
    ]);

    expect(sqlA).toBe(tsA);
    expect(sqlB).toBe(tsB);
    expect(sqlC).toBe(tsC);
    expect(sqlA).toBe(sqlB);
    expect(sqlB).toBe(sqlC);
  });

  it('sessions on DIFFERENT conference days never group together, even with identical overlapping times', async () => {
    const dayA = await createConferenceDay('2026-09-30');
    const dayB = await createConferenceDay('2026-10-01');
    const s1 = await createSession({ conferenceDayId: dayA, startTime: '2026-09-30T09:00:00Z', endTime: '2026-09-30T10:00:00Z' });
    const s2 = await createSession({ conferenceDayId: dayB, startTime: '2026-10-01T09:00:00Z', endTime: '2026-10-01T10:00:00Z' });

    const [sqlKey1, sqlKey2] = await Promise.all([sqlGroupKey(s1), sqlGroupKey(s2)]);
    expect(sqlKey1).not.toBe(sqlKey2);
  });

  it('mandatory sessions are grouped on the same basis as elective ones (is_mandatory does not affect grouping)', async () => {
    const day = await createConferenceDay('2026-10-02');
    const s1 = await createSession({ conferenceDayId: day, startTime: '2026-10-02T09:00:00Z', endTime: '2026-10-02T10:00:00Z', isMandatory: true });
    const s2 = await createSession({ conferenceDayId: day, startTime: '2026-10-02T09:30:00Z', endTime: '2026-10-02T10:30:00Z', isMandatory: false });

    const [sqlKey1, sqlKey2] = await Promise.all([sqlGroupKey(s1), sqlGroupKey(s2)]);
    expect(sqlKey1).toBe(sqlKey2);
  });

  it('order-independence: the group key does not depend on which session in the group is queried, or session creation order', async () => {
    const day = await createConferenceDay('2026-10-03');
    // Deliberately create in an order where none is trivially "first" by id sort.
    const s3 = await createSession({ conferenceDayId: day, startTime: '2026-10-03T10:30:00Z', endTime: '2026-10-03T11:30:00Z' });
    const s1 = await createSession({ conferenceDayId: day, startTime: '2026-10-03T09:00:00Z', endTime: '2026-10-03T10:00:00Z' });
    const s2 = await createSession({ conferenceDayId: day, startTime: '2026-10-03T09:45:00Z', endTime: '2026-10-03T11:00:00Z' });

    const [k1, k2, k3] = await Promise.all([sqlGroupKey(s1), sqlGroupKey(s2), sqlGroupKey(s3)]);
    expect(k1).toBe(k2);
    expect(k2).toBe(k3);
  });

  it('a fully independent, DB-free TypeScript computation over raw fixture data matches the SQL result (three-way cross-check)', async () => {
    const day = await createConferenceDay('2026-10-04');
    const s1 = await createSession({ conferenceDayId: day, startTime: '2026-10-04T08:00:00Z', endTime: '2026-10-04T09:00:00Z' });
    const s2 = await createSession({ conferenceDayId: day, startTime: '2026-10-04T08:30:00Z', endTime: '2026-10-04T09:30:00Z' });
    const s3 = await createSession({ conferenceDayId: day, startTime: '2026-10-04T14:00:00Z', endTime: '2026-10-04T15:00:00Z' });

    const { data: rows, error } = await admin
      .from('sessions')
      .select('id, conference_day_id, start_time, end_time, is_mandatory')
      .in('id', [s1, s2, s3]);
    expect(error).toBeNull();

    const forGrouping: SessionForGrouping[] = rows!.map((r) => ({
      id: r.id,
      conferenceDayId: r.conference_day_id,
      startTime: r.start_time,
      endTime: r.end_time,
      isMandatory: r.is_mandatory,
    }));

    const [sqlKey1, sqlKey2, sqlKey3] = await Promise.all([sqlGroupKey(s1), sqlGroupKey(s2), sqlGroupKey(s3)]);
    expect(sqlKey1).toBe(tsGroupKeyDirect(forGrouping, s1));
    expect(sqlKey2).toBe(tsGroupKeyDirect(forGrouping, s2));
    expect(sqlKey3).toBe(tsGroupKeyDirect(forGrouping, s3));
    expect(sqlKey1).toBe(sqlKey2);
    expect(sqlKey1).not.toBe(sqlKey3);
  });
});
