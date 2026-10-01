// tests/agenda/session-day-match-live.test.ts
//
// Confirms the DB trigger (migrated in
// 20261002000000_sessions_day_match_europe_istanbul.sql) correctly uses
// Postgres's native Europe/Istanbul tzdata, not just a JS-side assumption.
// Runs against the live scratch Supabase project — NOT isolated from other
// test data; see tests/agenda/conflict-and-validation.test.ts for the same
// pattern this file follows.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!URL || !SERVICE_KEY) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to run this live test');
}
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 3000) + 1;
const DAY = new Date(Date.UTC(2099, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let dayId: string;
let trackId: string;
let sessionTypeId: string;
let roomId: string;

beforeAll(async () => {
  const { data: day } = await admin.from('conference_days').insert({ conference_date: DAY, label_ar: 'يوم اختبار', label_en: 'Test Day', display_order: 1 }).select('id').single();
  dayId = day!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `TZ-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sType } = await admin.from('session_types').insert({ code: `TZ-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sType!.id;
  const { data: room } = await admin.from('rooms').insert({ code: `TZ-ROOM-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 100 }).select('id').single();
  roomId = room!.id;
});

afterAll(async () => {
  await admin.from('sessions').delete().eq('track_id', trackId);
  await admin.from('rooms').delete().eq('id', roomId);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('conference_days').delete().eq('id', dayId);
});

function baseSession(overrides: Partial<Database['public']['Tables']['sessions']['Insert']> = {}) {
  return {
    session_code: `TZ-${Math.random().toString(36).slice(2, 10)}`,
    title_ar: 'جلسة اختبار التوقيت', title_en: 'Timezone Test Session',
    conference_day_id: dayId,
    track_id: trackId, session_type_id: sessionTypeId, room_id: roomId,
    language: 'en' as const, difficulty_level: 'beginner' as const,
    capacity: 20, min_capacity: 0,
    ...overrides,
  };
}

describe('enforce_session_day_match uses Europe/Istanbul (not Asia/Muscat)', () => {
  it('accepts a session whose Istanbul-local wall-clock time falls within the conference day, even when its UTC date differs', async () => {
    const { error } = await admin.from('sessions').insert(baseSession({
      start_time: `${DAY}T00:30:00+03:00`,
      end_time: `${DAY}T01:30:00+03:00`,
    }));
    expect(error).toBeNull();
  });

  it('rejects a session whose Istanbul-local date does not match its conference_day_id', async () => {
    // 23:30 UTC on DAY -> Istanbul (+3) = 02:30 on the NEXT calendar day,
    // which does not match conference_day_id's date (DAY).
    const { error } = await admin.from('sessions').insert(baseSession({
      start_time: `${DAY}T23:30:00Z`,
      end_time: `${DAY}T23:50:00Z`,
    }));
    expect(error).not.toBeNull();
    expect(error?.message).toContain('does not match its conference day');
  });
});
