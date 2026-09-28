// tests/schedule/change-propagation.test.ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { processChangeEvents } from '@/lib/schedule/run-process-change-events';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

// Collision-proofing suffix, same rationale as tests/schedule/authorization.test.ts.
// Year 2088 reserved for this file.
const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 300) + 1;
const conferenceDate = new Date(Date.UTC(2088, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let staffId: string;
let applicantUserId: string;
let applicationId: string;
let conferenceDayId: string;
let roomId: string;
let trackId: string;
let sessionTypeId: string;
let sessionId: string;
let personId: string;
let allocationRunId: string;
let publicationId: string;
let publicationItemId: string;

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({ email: `schedule-changeprop-staff-${runId}@test.local`, password: 'password123', email_confirm: true });
  staffId = staff.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: applicantUser } = await admin.auth.admin.createUser({ email: `schedule-changeprop-applicant-${runId}@test.local`, password: 'password123', email_confirm: true });
  applicantUserId = applicantUser.user!.id;

  const { data: app } = await admin.from('applications').insert({ applicant_id: applicantUserId, status: 'accepted' }).select('id').single();
  applicationId = app!.id;

  const { data: day } = await admin.from('conference_days').insert({ conference_date: conferenceDate, label_ar: 'Day', label_en: 'Day', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;
  const { data: room } = await admin.from('rooms').insert({ code: `CHPROP-ROOM-${runId}`, name_ar: 'R', name_en: 'Room', capacity: 10 }).select('id').single();
  roomId = room!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `CHPROP-TRACK-${runId}`, name_ar: 'T', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sessionType } = await admin.from('session_types').insert({ code: `CHPROP-TYPE-${runId}`, name_ar: 'S', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;

  const { data: session } = await admin.from('sessions').insert({
    session_code: `CHPROP-SESSION-1-${runId}`, title_ar: 'S', title_en: 'Session', conference_day_id: conferenceDayId,
    start_time: `${conferenceDate}T09:00:00Z`, end_time: `${conferenceDate}T10:00:00Z`, track_id: trackId, session_type_id: sessionTypeId,
    room_id: roomId, language: 'bilingual', difficulty_level: 'all_levels', capacity: 5, is_mandatory: false, status: 'confirmed',
  }).select('id').single();
  sessionId = session!.id;

  const { data: person } = await admin.from('people').insert({ full_name_ar: 'ب', full_name_en: 'Speaker' }).select('id').single();
  personId = person!.id;

  const { data: featureRun } = await admin.from('feature_extraction_runs').insert({ rules_version: 1, application_count: 1, run_by: staffId }).select('id').single();
  const { data: run } = await admin.from('allocation_runs').insert({
    feature_extraction_run_id: featureRun!.id, status: 'draft', run_by: staffId,
  }).select('id').single();
  allocationRunId = run!.id;

  // Directly insert an 'active' publication + item referencing the session,
  // bypassing the staging/confirm pipeline (not needed for this file's purposes).
  const { data: publication } = await admin.from('schedule_publications').insert({
    application_id: applicationId, allocation_run_id: allocationRunId, revision_number: 1, status: 'active',
    source_fingerprint: 'changeprop-fingerprint-1', published_by: staffId,
  }).select('id').single();
  publicationId = publication!.id;

  const { data: item } = await admin.from('schedule_publication_items').insert({
    schedule_publication_id: publicationId, session_id: sessionId, session_title_ar: 'S', session_title_en: 'Session',
    room_name_ar: 'R', room_name_en: 'Room', start_time: `${conferenceDate}T09:00:00Z`, end_time: `${conferenceDate}T10:00:00Z`,
    is_mandatory: false, item_status: 'active',
  }).select('id').single();
  publicationItemId = item!.id;
});

afterAll(async () => {
  await admin.from('schedule_publication_items').delete().eq('id', publicationItemId);
  await admin.from('schedule_publications').delete().eq('id', publicationId);
  await admin.from('schedule_change_events').delete().eq('session_id', sessionId);
  await admin.from('session_people').delete().eq('session_id', sessionId);
  await admin.from('allocation_runs').delete().eq('id', allocationRunId);
  await admin.from('sessions').delete().eq('id', sessionId);
  await admin.from('people').delete().eq('id', personId);
  await admin.from('applications').delete().eq('id', applicationId);
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  await admin.from('rooms').delete().eq('id', roomId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await Promise.allSettled([
    admin.auth.admin.deleteUser(staffId),
    admin.auth.admin.deleteUser(applicantUserId),
  ]);
});

describe('change propagation', () => {
  it('a session time change produces exactly one unprocessed change event, deduplicated on a second identical change', async () => {
    await admin.from('sessions').update({ start_time: `${conferenceDate}T09:30:00Z` }).eq('id', sessionId);
    await admin.from('sessions').update({ start_time: `${conferenceDate}T09:45:00Z` }).eq('id', sessionId);

    const { data: events } = await admin
      .from('schedule_change_events')
      .select('*')
      .eq('session_id', sessionId)
      .eq('change_type', 'time_or_room')
      .is('processed_at', null);

    expect(events).toHaveLength(1);
  });

  it('processing the event marks the affected active item stale, not cancelled', async () => {
    await processChangeEvents(admin);

    const { data: item } = await admin
      .from('schedule_publication_items')
      .select('item_status')
      .eq('id', publicationItemId)
      .single();
    expect(item?.item_status).toBe('stale');

    const { data: events } = await admin
      .from('schedule_change_events')
      .select('processed_at')
      .eq('session_id', sessionId)
      .eq('change_type', 'time_or_room');
    expect(events).toHaveLength(1);
    expect(events?.[0].processed_at).not.toBeNull();
  });

  it('a session cancellation marks affected active items pending_review, not stale', async () => {
    // Reset the item to 'active' so this test observes cancellation's own effect,
    // independent of the previous test's 'stale' transition.
    await admin.from('schedule_publication_items').update({ item_status: 'active' }).eq('id', publicationItemId);

    // cancellation_reason is required by a pre-existing trigger
    // (enforce_session_status_transition, supabase/migrations/
    // 20260723020000_sessions_triggers.sql) whenever status transitions to
    // 'cancelled' — omitting it makes the trigger reject the update, which
    // this test previously didn't check for, so the cancellation silently
    // never took effect. confirm-publication-behavioral.test.ts already
    // handles this correctly for the same trigger.
    const { error: cancelError } = await admin.from('sessions').update({ status: 'cancelled', cancellation_reason: 'Test cancellation' }).eq('id', sessionId);
    expect(cancelError).toBeNull();
    await processChangeEvents(admin);

    const { data: item } = await admin
      .from('schedule_publication_items')
      .select('item_status')
      .eq('id', publicationItemId)
      .single();
    expect(item?.item_status).toBe('pending_review');

    const { data: events } = await admin
      .from('schedule_change_events')
      .select('processed_at')
      .eq('session_id', sessionId)
      .eq('change_type', 'cancelled');
    expect(events).toHaveLength(1);
    expect(events?.[0].processed_at).not.toBeNull();
  });

  it('a session_people delete-and-reinsert collapses to one unprocessed speakers event', async () => {
    const { data: sp } = await admin.from('session_people').insert({
      session_id: sessionId, person_id: personId, role: 'speaker', display_order: 0, is_primary: true,
    }).select('id').single();

    await admin.from('session_people').delete().eq('id', sp!.id);
    await admin.from('session_people').insert({
      session_id: sessionId, person_id: personId, role: 'speaker', display_order: 0, is_primary: true,
    });

    const { data: events } = await admin
      .from('schedule_change_events')
      .select('*')
      .eq('session_id', sessionId)
      .eq('change_type', 'speakers')
      .is('processed_at', null);

    expect(events).toHaveLength(1);
  });
});
