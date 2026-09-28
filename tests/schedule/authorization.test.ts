// tests/schedule/authorization.test.ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

// Collision-proofing suffix — a fixed literal collides with a leftover row
// from any earlier interrupted run (conference_date/room/track/session_type
// code/email are all unique-constrained). Year 2087 reserved for this file
// (distinct from other live suites' reserved years) to avoid conference_date
// collisions across suites too.
const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 300) + 1;
const conferenceDate = new Date(Date.UTC(2087, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let participantId: string | undefined;
let otherParticipantId: string | undefined;
let staffId: string | undefined;
let applicationId: string;
let otherApplicationId: string;
let conferenceDayId: string;
let roomId: string;
let trackId: string;
let sessionTypeId: string;
let sessionId: string;
let allocationRunId: string;
let publicationId: string;
let otherPublicationId: string;
let publicationItemId: string;
let otherPublicationItemId: string;

beforeAll(async () => {
  const { data: participant } = await admin.auth.admin.createUser({ email: `schedule-authz-participant-${runId}@test.local`, password: 'password123', email_confirm: true });
  participantId = participant.user!.id;
  await admin.from('profiles').update({ role: 'participant' }).eq('id', participantId);

  const { data: otherParticipant } = await admin.auth.admin.createUser({ email: `schedule-authz-other-participant-${runId}@test.local`, password: 'password123', email_confirm: true });
  otherParticipantId = otherParticipant.user!.id;
  await admin.from('profiles').update({ role: 'participant' }).eq('id', otherParticipantId);

  const { data: staff } = await admin.auth.admin.createUser({ email: `schedule-authz-staff-${runId}@test.local`, password: 'password123', email_confirm: true });
  staffId = staff.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: app } = await admin.from('applications').insert({ applicant_id: participantId, status: 'accepted' }).select('id').single();
  applicationId = app!.id;
  const { data: otherApp } = await admin.from('applications').insert({ applicant_id: otherParticipantId, status: 'accepted' }).select('id').single();
  otherApplicationId = otherApp!.id;

  const { data: day } = await admin.from('conference_days').insert({ conference_date: conferenceDate, label_ar: 'Day', label_en: 'Day', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;
  const { data: room } = await admin.from('rooms').insert({ code: `AUTHZ-ROOM-${runId}`, name_ar: 'R', name_en: 'Room', capacity: 10 }).select('id').single();
  roomId = room!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `AUTHZ-TRACK-${runId}`, name_ar: 'T', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sessionType } = await admin.from('session_types').insert({ code: `AUTHZ-TYPE-${runId}`, name_ar: 'S', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;

  const { data: session } = await admin.from('sessions').insert({
    session_code: `AUTHZ-SESSION-1-${runId}`, title_ar: 'S', title_en: 'Session', conference_day_id: conferenceDayId,
    start_time: `${conferenceDate}T09:00:00Z`, end_time: `${conferenceDate}T10:00:00Z`, track_id: trackId, session_type_id: sessionTypeId,
    room_id: roomId, language: 'bilingual', difficulty_level: 'all_levels', capacity: 5, is_mandatory: false, status: 'confirmed',
  }).select('id').single();
  sessionId = session!.id;

  const { data: featureRun } = await admin.from('feature_extraction_runs').insert({ rules_version: 1, application_count: 1, run_by: staffId }).select('id').single();
  const { data: run } = await admin.from('allocation_runs').insert({
    feature_extraction_run_id: featureRun!.id, status: 'draft', run_by: staffId,
  }).select('id').single();
  allocationRunId = run!.id;

  // Direct-insert 'active' publications + items for both participants,
  // bypassing the staging/confirm pipeline (not needed for RLS scoping tests).
  const { data: publication } = await admin.from('schedule_publications').insert({
    application_id: applicationId, allocation_run_id: allocationRunId, revision_number: 1, status: 'active',
    source_fingerprint: `authz-fingerprint-1-${runId}`, published_by: staffId,
  }).select('id').single();
  publicationId = publication!.id;
  const { data: item } = await admin.from('schedule_publication_items').insert({
    schedule_publication_id: publicationId, session_id: sessionId, session_title_ar: 'S', session_title_en: 'Session',
    room_name_ar: 'R', room_name_en: 'Room', start_time: `${conferenceDate}T09:00:00Z`, end_time: `${conferenceDate}T10:00:00Z`,
    is_mandatory: false, item_status: 'active',
  }).select('id').single();
  publicationItemId = item!.id;

  const { data: otherPublication } = await admin.from('schedule_publications').insert({
    application_id: otherApplicationId, allocation_run_id: allocationRunId, revision_number: 1, status: 'active',
    source_fingerprint: `authz-fingerprint-2-${runId}`, published_by: staffId,
  }).select('id').single();
  otherPublicationId = otherPublication!.id;
  const { data: otherItem } = await admin.from('schedule_publication_items').insert({
    schedule_publication_id: otherPublicationId, session_id: sessionId, session_title_ar: 'S', session_title_en: 'Session',
    room_name_ar: 'R', room_name_en: 'Room', start_time: `${conferenceDate}T09:00:00Z`, end_time: `${conferenceDate}T10:00:00Z`,
    is_mandatory: false, item_status: 'active',
  }).select('id').single();
  otherPublicationItemId = otherItem!.id;
});

afterAll(async () => {
  await admin.from('schedule_publication_items').delete().in('id', [publicationItemId, otherPublicationItemId]);
  await admin.from('schedule_publications').delete().in('id', [publicationId, otherPublicationId]);
  await admin.from('schedule_change_events').delete().eq('session_id', sessionId);
  const { data: drafts } = await admin.from('schedule_publication_drafts').select('id').eq('allocation_run_id', allocationRunId);
  if (drafts && drafts.length > 0) await admin.from('schedule_publication_drafts').delete().in('id', drafts.map((d) => d.id));
  await admin.from('allocation_runs').delete().eq('id', allocationRunId);
  await admin.from('sessions').delete().eq('id', sessionId);
  await admin.from('applications').delete().in('id', [applicationId, otherApplicationId]);
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  await admin.from('rooms').delete().eq('id', roomId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await Promise.allSettled([
    participantId ? admin.auth.admin.deleteUser(participantId) : Promise.resolve(),
    otherParticipantId ? admin.auth.admin.deleteUser(otherParticipantId) : Promise.resolve(),
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
  ]);
});

async function signInAsParticipant() {
  const client = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  await client.auth.signInWithPassword({ email: `schedule-authz-participant-${runId}@test.local`, password: 'password123' });
  return client;
}

describe('schedule RLS: participant read scoping', () => {
  it('lets a participant read their own schedule_publications row', async () => {
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_publications').select('id').eq('application_id', applicationId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0].id).toBe(publicationId);
  });

  it('lets a participant read their own schedule_publication_items rows', async () => {
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_publication_items').select('id').eq('schedule_publication_id', publicationId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0].id).toBe(publicationItemId);
  });

  it('returns zero rows for another participant\'s schedule_publications', async () => {
    const client = await signInAsParticipant();
    const { data } = await client.from('schedule_publications').select('id').eq('application_id', otherApplicationId);
    expect(data ?? []).toHaveLength(0);
  });

  it('returns zero rows for another participant\'s schedule_publication_items', async () => {
    const client = await signInAsParticipant();
    const { data } = await client.from('schedule_publication_items').select('id').eq('schedule_publication_id', otherPublicationId);
    expect(data ?? []).toHaveLength(0);
  });
});

describe('schedule RLS: staff-only tables are invisible to a participant', () => {
  // Each test seeds a real row via the service-role client first, so a
  // zero-rows result actually proves RLS filtered it out for the
  // participant — not merely that the table happened to be empty.

  it('returns zero rows for a participant reading schedule_change_events, though a row exists', async () => {
    await admin.from('schedule_change_events').insert({ session_id: sessionId, change_type: 'time_or_room' });
    const client = await signInAsParticipant();
    const { data } = await client.from('schedule_change_events').select('id');
    expect(data ?? []).toHaveLength(0);
    const { data: check } = await admin.from('schedule_change_events').select('id').eq('session_id', sessionId);
    expect(check ?? []).not.toHaveLength(0);
  });

  it('returns zero rows for a participant reading schedule_publication_drafts, though a row exists', async () => {
    const { data: draft } = await admin.from('schedule_publication_drafts').insert({
      allocation_run_id: allocationRunId, staged_by: staffId!, source_fingerprint: 'authz-visibility-draft',
    }).select('id').single();
    const client = await signInAsParticipant();
    const { data } = await client.from('schedule_publication_drafts').select('id');
    expect(data ?? []).toHaveLength(0);
    await admin.from('schedule_publication_drafts').delete().eq('id', draft!.id);
  });

  it('returns zero rows for a participant reading schedule_publication_draft_items, though a row exists', async () => {
    const { data: draft } = await admin.from('schedule_publication_drafts').insert({
      allocation_run_id: allocationRunId, staged_by: staffId!, source_fingerprint: 'authz-visibility-draft-item',
    }).select('id').single();
    await admin.from('schedule_publication_draft_items').insert({
      schedule_publication_draft_id: draft!.id, application_id: applicationId, verdict: 'publishable',
    });
    const client = await signInAsParticipant();
    const { data } = await client.from('schedule_publication_draft_items').select('id');
    expect(data ?? []).toHaveLength(0);
    await admin.from('schedule_publication_drafts').delete().eq('id', draft!.id);
  });
});

describe('schedule RLS: no participant write succeeds on any of the 5 new tables', () => {
  it('blocks a participant inserting into schedule_publications', async () => {
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_publications').insert({
      application_id: applicationId, allocation_run_id: allocationRunId, revision_number: 99, status: 'active',
      source_fingerprint: 'should-not-insert', published_by: participantId!,
    }).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
    const { data: check } = await admin.from('schedule_publications').select('id').eq('source_fingerprint', 'should-not-insert');
    expect(check ?? []).toHaveLength(0);
  });

  it('blocks a participant updating their own schedule_publications row', async () => {
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_publications').update({ status: 'superseded' }).eq('id', publicationId).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
    const { data: check } = await admin.from('schedule_publications').select('status').eq('id', publicationId).single();
    expect(check?.status).toBe('active');
  });

  it('blocks a participant deleting their own schedule_publications row', async () => {
    const client = await signInAsParticipant();
    const { error } = await client.from('schedule_publications').delete().eq('id', publicationId);
    // A blocked delete via PostgREST may return error === null with zero
    // rows affected (RLS silently filters), so the meaningful assertion is
    // the follow-up service-role read proving the row still exists.
    void error;
    const { data: check } = await admin.from('schedule_publications').select('id').eq('id', publicationId).single();
    expect(check?.id).toBe(publicationId);
  });

  it('blocks a participant inserting into schedule_publication_items', async () => {
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_publication_items').insert({
      schedule_publication_id: publicationId, session_id: sessionId, is_mandatory: false,
      item_status: 'active', session_title_en: 'should-not-insert',
    }).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
    const { data: check } = await admin.from('schedule_publication_items').select('id').eq('session_title_en', 'should-not-insert');
    expect(check ?? []).toHaveLength(0);
  });

  it('blocks a participant updating their own schedule_publication_items row', async () => {
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_publication_items').update({ item_status: 'cancelled' }).eq('id', publicationItemId).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
    const { data: check } = await admin.from('schedule_publication_items').select('item_status').eq('id', publicationItemId).single();
    expect(check?.item_status).toBe('active');
  });

  it('blocks a participant deleting their own schedule_publication_items row', async () => {
    const client = await signInAsParticipant();
    const { error } = await client.from('schedule_publication_items').delete().eq('id', publicationItemId);
    void error;
    const { data: check } = await admin.from('schedule_publication_items').select('id').eq('id', publicationItemId).single();
    expect(check?.id).toBe(publicationItemId);
  });

  it('blocks a participant inserting into schedule_change_events', async () => {
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_change_events').insert({
      session_id: sessionId, change_type: 'time_or_room',
    }).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
  });

  it('blocks a participant updating schedule_change_events', async () => {
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_change_events').update({ processed_at: new Date().toISOString() }).eq('session_id', sessionId).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
  });

  it('blocks a participant deleting schedule_change_events', async () => {
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_change_events').delete().eq('session_id', sessionId).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
  });

  it('blocks a participant inserting into schedule_publication_drafts', async () => {
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_publication_drafts').insert({
      allocation_run_id: allocationRunId, staged_by: participantId!, source_fingerprint: 'should-not-insert',
    }).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
    const { data: check } = await admin.from('schedule_publication_drafts').select('id').eq('source_fingerprint', 'should-not-insert');
    expect(check ?? []).toHaveLength(0);
  });

  it('blocks a participant updating schedule_publication_drafts', async () => {
    const { data: draft } = await admin.from('schedule_publication_drafts').insert({
      allocation_run_id: allocationRunId, staged_by: staffId!, source_fingerprint: 'authz-draft-fingerprint',
    }).select('id').single();
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_publication_drafts').update({ status: 'discarded' }).eq('id', draft!.id).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
    const { data: check } = await admin.from('schedule_publication_drafts').select('status').eq('id', draft!.id).single();
    expect(check?.status).toBe('staged');
    await admin.from('schedule_publication_drafts').delete().eq('id', draft!.id);
  });

  it('blocks a participant deleting schedule_publication_drafts', async () => {
    const { data: draft } = await admin.from('schedule_publication_drafts').insert({
      allocation_run_id: allocationRunId, staged_by: staffId!, source_fingerprint: 'authz-draft-fingerprint-2',
    }).select('id').single();
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_publication_drafts').delete().eq('id', draft!.id).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
    const { data: check } = await admin.from('schedule_publication_drafts').select('id').eq('id', draft!.id).single();
    expect(check?.id).toBe(draft!.id);
    await admin.from('schedule_publication_drafts').delete().eq('id', draft!.id);
  });

  it('blocks a participant inserting into schedule_publication_draft_items', async () => {
    const { data: draft } = await admin.from('schedule_publication_drafts').insert({
      allocation_run_id: allocationRunId, staged_by: staffId!, source_fingerprint: 'authz-draft-fingerprint-3',
    }).select('id').single();
    const client = await signInAsParticipant();
    const { data, error } = await client.from('schedule_publication_draft_items').insert({
      schedule_publication_draft_id: draft!.id, application_id: applicationId, verdict: 'publishable',
    }).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
    const { data: check } = await admin.from('schedule_publication_draft_items').select('id').eq('schedule_publication_draft_id', draft!.id);
    expect(check ?? []).toHaveLength(0);
    await admin.from('schedule_publication_drafts').delete().eq('id', draft!.id);
  });

  it('blocks a participant updating and deleting schedule_publication_draft_items', async () => {
    const { data: draft } = await admin.from('schedule_publication_drafts').insert({
      allocation_run_id: allocationRunId, staged_by: staffId!, source_fingerprint: 'authz-draft-fingerprint-4',
    }).select('id').single();
    const { data: draftItem } = await admin.from('schedule_publication_draft_items').insert({
      schedule_publication_draft_id: draft!.id, application_id: applicationId, verdict: 'publishable',
    }).select('id').single();

    const client = await signInAsParticipant();
    const updateResult = await client.from('schedule_publication_draft_items').update({ verdict: 'no_change' }).eq('id', draftItem!.id).select('id');
    expect(updateResult.error !== null || !updateResult.data || updateResult.data.length === 0).toBe(true);
    const deleteResult = await client.from('schedule_publication_draft_items').delete().eq('id', draftItem!.id).select('id');
    expect(deleteResult.error !== null || !deleteResult.data || deleteResult.data.length === 0).toBe(true);

    const { data: check } = await admin.from('schedule_publication_draft_items').select('verdict').eq('id', draftItem!.id).single();
    expect(check?.verdict).toBe('publishable');

    await admin.from('schedule_publication_drafts').delete().eq('id', draft!.id);
  });
});
