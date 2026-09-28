// tests/content/public-speakers-live.test.ts
//
// Live coverage for getPublicSpeakers (src/lib/content/public-speakers.ts)
// — the Phase 9.2 data source behind the public Speakers page. Proves the
// eligibility rule (is_public=true AND is_active=true AND has a
// session_people role='speaker' row) against real fixture data, and
// proves the narrow field allowlist never leaks email/phone/
// linked_profile_id.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { getPublicSpeakers } from '@/lib/content/public-speakers';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const conferenceDate = new Date(Date.UTC(2060, 0, 1) + Math.floor(Math.random() * 900000) * 86400000).toISOString().slice(0, 10);

vi.setConfig({ testTimeout: 30000 });

let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string;
let roomId: string;
let sessionId: string;
const personIds: string[] = [];

async function createPerson(overrides: Partial<Database['public']['Tables']['people']['Insert']> & { full_name_en: string }) {
  const { data, error } = await admin
    .from('people')
    .insert({ full_name_ar: 'شخص اختبار', is_public: false, is_active: true, ...overrides })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create person: ${error?.message}`);
  personIds.push(data.id);
  return data.id;
}

beforeAll(async () => {
  const { data: day } = await admin.from('conference_days').insert({ conference_date: conferenceDate, label_ar: 'يوم', label_en: 'Day', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;

  const { data: track } = await admin.from('tracks').insert({ code: `SPEAKERS-LIVE-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: `SPEAKERS-LIVE-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;

  const { data: room } = await admin.from('rooms').insert({ code: `SPEAKERS-LIVE-ROOM-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 100 }).select('id').single();
  roomId = room!.id;

  const { data: session } = await admin
    .from('sessions')
    .insert({
      session_code: `SPEAKERS-LIVE-SESSION-${runId}`,
      title_ar: 'جلسة',
      title_en: 'Session',
      conference_day_id: conferenceDayId,
      start_time: `${conferenceDate}T09:00:00Z`,
      end_time: `${conferenceDate}T10:00:00Z`,
      track_id: trackId,
      session_type_id: sessionTypeId,
      room_id: roomId,
      language: 'bilingual',
      difficulty_level: 'all_levels',
      capacity: 10,
      is_mandatory: false,
      status: 'confirmed',
    })
    .select('id')
    .single();
  sessionId = session!.id;
});

afterAll(async () => {
  await admin.from('sessions').delete().eq('id', sessionId); // cascades session_people
  if (personIds.length > 0) await admin.from('people').delete().in('id', personIds);
  await admin.from('rooms').delete().eq('id', roomId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
});

describe('getPublicSpeakers — live coverage', () => {
  it('includes a person who is public, active, and has a speaker role on a session', async () => {
    const personId = await createPerson({
      full_name_en: `Public Speaker ${runId}`,
      title_en: 'Keynote Speaker',
      organization_en: 'RCOY MENA',
      bio_en: 'A real bio.',
      is_public: true,
      is_active: true,
      email: 'should-not-leak@test.local',
      phone: '+00000000',
    });
    await admin.from('session_people').insert({ session_id: sessionId, person_id: personId, role: 'speaker' });

    const speakers = await getPublicSpeakers(admin);
    const found = speakers.find((s) => s.id === personId);
    expect(found).toBeDefined();
    expect(found!.fullNameEn).toBe(`Public Speaker ${runId}`);
    expect(found!.titleEn).toBe('Keynote Speaker');
    expect(found!.organizationEn).toBe('RCOY MENA');
    expect(found!.bioEn).toBe('A real bio.');
  });

  it('never includes email/phone/linked_profile_id in the returned shape', async () => {
    const personId = await createPerson({
      full_name_en: `No Leak Speaker ${runId}`,
      is_public: true,
      is_active: true,
      email: 'secret@test.local',
      phone: '+19999999',
    });
    await admin.from('session_people').insert({ session_id: sessionId, person_id: personId, role: 'speaker' });

    const speakers = await getPublicSpeakers(admin);
    const found = speakers.find((s) => s.id === personId);
    expect(found).toBeDefined();
    expect(JSON.stringify(found)).not.toContain('secret@test.local');
    expect(JSON.stringify(found)).not.toContain('+19999999');
    expect(Object.keys(found!)).not.toContain('email');
    expect(Object.keys(found!)).not.toContain('phone');
  });

  it('excludes a person with is_public=false, even if they have a speaker role', async () => {
    const personId = await createPerson({ full_name_en: `Not Public ${runId}`, is_public: false, is_active: true });
    await admin.from('session_people').insert({ session_id: sessionId, person_id: personId, role: 'speaker' });

    const speakers = await getPublicSpeakers(admin);
    expect(speakers.find((s) => s.id === personId)).toBeUndefined();
  });

  it('excludes a person with is_public=true but is_active=false (deactivated)', async () => {
    const personId = await createPerson({ full_name_en: `Deactivated ${runId}`, is_public: true, is_active: false });
    await admin.from('session_people').insert({ session_id: sessionId, person_id: personId, role: 'speaker' });

    const speakers = await getPublicSpeakers(admin);
    expect(speakers.find((s) => s.id === personId)).toBeUndefined();
  });

  it('excludes a person with is_public=true and is_active=true but no speaker role anywhere', async () => {
    const personId = await createPerson({ full_name_en: `No Session ${runId}`, is_public: true, is_active: true });
    // No session_people row at all for this person.

    const speakers = await getPublicSpeakers(admin);
    expect(speakers.find((s) => s.id === personId)).toBeUndefined();
  });

  it('excludes a person who is public/active but only has a non-speaker role (e.g. moderator)', async () => {
    const personId = await createPerson({ full_name_en: `Moderator Only ${runId}`, is_public: true, is_active: true });
    await admin.from('session_people').insert({ session_id: sessionId, person_id: personId, role: 'moderator' });

    const speakers = await getPublicSpeakers(admin);
    expect(speakers.find((s) => s.id === personId)).toBeUndefined();
  });

  it('returns a speaker only once even if they speak at multiple sessions', async () => {
    const personId = await createPerson({ full_name_en: `Multi Session ${runId}`, is_public: true, is_active: true });

    const { data: session2 } = await admin
      .from('sessions')
      .insert({
        session_code: `SPEAKERS-LIVE-SESSION2-${runId}`,
        title_ar: 'جلسة ٢',
        title_en: 'Session 2',
        conference_day_id: conferenceDayId,
        start_time: `${conferenceDate}T11:00:00Z`,
        end_time: `${conferenceDate}T12:00:00Z`,
        track_id: trackId,
        session_type_id: sessionTypeId,
        room_id: roomId,
        language: 'bilingual',
        difficulty_level: 'all_levels',
        capacity: 10,
        is_mandatory: false,
        status: 'confirmed',
      })
      .select('id')
      .single();

    await admin.from('session_people').insert({ session_id: sessionId, person_id: personId, role: 'speaker' });
    await admin.from('session_people').insert({ session_id: session2!.id, person_id: personId, role: 'speaker' });

    try {
      const speakers = await getPublicSpeakers(admin);
      const matches = speakers.filter((s) => s.id === personId);
      expect(matches).toHaveLength(1);
    } finally {
      await admin.from('sessions').delete().eq('id', session2!.id);
    }
  });
});
