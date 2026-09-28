// tests/schedule/confirm-publication-behavioral.test.ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

// Collision-proofing suffix, same rationale as tests/schedule/authorization.test.ts.
// Year 2091 reserved for this file.
const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 300) + 1;
const conferenceDate = new Date(Date.UTC(2091, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let staffId: string;
let conferenceDayId: string;
let roomId: string;
let trackId: string;
let sessionTypeId: string;
let sessionId: string;
let applicationId: string;
let applicantUserId: string;
let featureExtractionRunId: string;
let allocationRunId: string;
const assignmentIds: string[] = [];

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({
    email: `confirm-pub-behavior-staff-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  staffId = staff!.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: applicant } = await admin.auth.admin.createUser({
    email: `confirm-pub-behavior-p1-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  applicantUserId = applicant!.user!.id;

  const { data: day } = await admin
    .from('conference_days')
    .insert({ conference_date: conferenceDate, label_ar: 'يوم النشر', label_en: 'Publish Day', display_order: 1 })
    .select('id')
    .single();
  conferenceDayId = day!.id;

  const { data: room } = await admin
    .from('rooms')
    .insert({ code: `CONFIRM-PUB-ROOM-${runId}`, name_ar: 'قاعة النشر', name_en: 'Publish Room', capacity: 10 })
    .select('id')
    .single();
  roomId = room!.id;

  const { data: track } = await admin.from('tracks').insert({ code: `CONFIRM-PUB-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin
    .from('session_types')
    .insert({ code: `CONFIRM-PUB-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' })
    .select('id')
    .single();
  sessionTypeId = sessionType!.id;

  const { data: session } = await admin
    .from('sessions')
    .insert({
      session_code: `CONFIRM-PUB-SESSION-1-${runId}`,
      title_ar: 'جلسة تأكيد النشر',
      title_en: 'Confirm Publication Session',
      conference_day_id: conferenceDayId,
      start_time: `${conferenceDate}T09:00:00Z`,
      end_time: `${conferenceDate}T10:00:00Z`,
      track_id: trackId,
      session_type_id: sessionTypeId,
      room_id: roomId,
      language: 'bilingual',
      difficulty_level: 'all_levels',
      capacity: 10,
      is_mandatory: true,
      status: 'confirmed',
    })
    .select('id')
    .single();
  sessionId = session!.id;

  const { data: application } = await admin
    .from('applications')
    .insert({ applicant_id: applicantUserId, status: 'accepted' })
    .select('id')
    .single();
  applicationId = application!.id;

  const { data: extraction } = await admin
    .from('feature_extraction_runs')
    .insert({ rules_version: 1, application_count: 1, run_by: staffId })
    .select('id')
    .single();
  featureExtractionRunId = extraction!.id;

  const { data: run } = await admin
    .from('allocation_runs')
    .insert({ feature_extraction_run_id: featureExtractionRunId, status: 'confirmed', run_by: staffId, confirmed_at: new Date().toISOString(), confirmed_by: staffId })
    .select('id')
    .single();
  allocationRunId = run!.id;

  const { data: assignment } = await admin
    .from('allocation_assignments')
    .insert({
      allocation_run_id: allocationRunId,
      application_id: applicationId,
      session_id: sessionId,
      time_slot_group_key: 'slot-1',
      suitability_score: 0.9,
      is_mandatory_assignment: true,
      status: 'proposed',
    })
    .select('id')
    .single();
  assignmentIds.push(assignment!.id);
});

afterAll(async () => {
  // schedule_publications/schedule_publication_items reference application_id/
  // allocation_run_id with no ON DELETE CASCADE, so publications produced by
  // this file's `it` blocks must be deleted before the applications/
  // allocation_runs they reference. schedule_publication_drafts also
  // reference allocation_run_id and staged_by with no cascade.
  const { data: pubs } = await admin.from('schedule_publications').select('id').eq('application_id', applicationId);
  if (pubs && pubs.length > 0) {
    await admin
      .from('schedule_publication_items')
      .delete()
      .in(
        'schedule_publication_id',
        pubs.map((p) => p.id)
      );
    await admin.from('schedule_publications').delete().eq('application_id', applicationId);
  }
  // The change-propagation-path draft (Task 20's own `it` block above)
  // stages with p_allocation_run_id: null (a real, valid RPC input for that
  // path -- see its own comment), so a draft it produces can have a NULL
  // allocation_run_id and is invisible to a `.eq('allocation_run_id', ...)`
  // filter (SQL NULL is never `=` to anything). Deleting by this
  // application's own draft_items first (found via the FK on
  // schedule_publication_draft_items, not via allocation_run_id) catches
  // every draft this file created for this application, run-publish or
  // change-propagation alike.
  const { data: draftItemRows } = await admin.from('schedule_publication_draft_items').select('schedule_publication_draft_id').eq('application_id', applicationId);
  const ownDraftIds = [...new Set((draftItemRows ?? []).map((r) => r.schedule_publication_draft_id))];
  if (ownDraftIds.length > 0) {
    await admin.from('schedule_publication_drafts').delete().in('id', ownDraftIds);
  }
  await admin.from('schedule_publication_drafts').delete().eq('allocation_run_id', allocationRunId);
  await admin.from('allocation_runs').delete().eq('id', allocationRunId);
  await admin.from('feature_extraction_runs').delete().eq('id', featureExtractionRunId);
  await admin.from('applications').delete().eq('id', applicationId);
  // The change-propagation-path 'it' block above (line ~283) inserts a real
  // schedule_change_events row for sessionId (session status update ->
  // trigger-inserted change event). Unlike the nested elective-block
  // afterAll below, this top-level afterAll never deleted it -- a genuine
  // missing cleanup call, found during the Phase 7G-K session-residue
  // sub-investigation, that silently blocked every `sessions` delete below
  // via schedule_change_events_session_id_fkey (no cascade).
  await admin.from('schedule_change_events').delete().eq('session_id', sessionId);
  await admin.from('sessions').delete().eq('id', sessionId);
  await Promise.allSettled([
    admin.from('conference_days').delete().eq('id', conferenceDayId),
    admin.from('rooms').delete().eq('id', roomId),
    admin.from('tracks').delete().eq('id', trackId),
    admin.from('session_types').delete().eq('id', sessionTypeId),
    admin.auth.admin.deleteUser(staffId),
    admin.auth.admin.deleteUser(applicantUserId),
  ]);
});

describe('confirm_publication_transactional behavioral suite (run-publish path)', () => {
  it('stages then confirms a run-publish draft, freezing room_name_ar/room_name_en and other display fields', async () => {
    const { data: draft, error: stageError } = await admin.rpc('stage_publication_transactional', {
      p_allocation_run_id: allocationRunId,
      p_change_event_ids: null as unknown as string[], // see run-stage-publication.ts: Supabase codegen gap, RPC accepts null
      p_staged_by: staffId,
    });
    expect(stageError).toBeNull();
    expect(draft?.status).toBe('staged');

    const { data: confirmed, error: confirmError } = await admin.rpc('confirm_publication_transactional', {
      p_draft_id: draft!.id,
      p_confirmed_by: staffId,
    });
    expect(confirmError).toBeNull();
    expect(confirmed?.status).toBe('confirmed');

    const { data: publication } = await admin
      .from('schedule_publications')
      .select('id, revision_number, status')
      .eq('application_id', applicationId)
      .eq('status', 'active')
      .single();
    expect(publication?.revision_number).toBe(1);

    const { data: items } = await admin.from('schedule_publication_items').select('*').eq('schedule_publication_id', publication!.id);
    expect(items).toHaveLength(1);
    // Room-name freezing: this is the field the plan's Step 3 note flagged as
    // needing verification. The current migration SQL already joins
    // sessions.room_id -> rooms and inserts room_name_ar/room_name_en
    // alongside the other frozen display fields — confirmed correct here,
    // live, against the hosted project.
    expect(items?.[0].room_name_ar).toBe('قاعة النشر');
    expect(items?.[0].room_name_en).toBe('Publish Room');
    expect(items?.[0].session_title_ar).toBe('جلسة تأكيد النشر');
    expect(items?.[0].session_title_en).toBe('Confirm Publication Session');
    expect(items?.[0].is_mandatory).toBe(true);
    expect(items?.[0].item_status).toBe('active');
  });

  it('rejects re-confirming a draft that is no longer staged', async () => {
    const { data: draft } = await admin.rpc('stage_publication_transactional', {
      p_allocation_run_id: allocationRunId,
      p_change_event_ids: null as unknown as string[], // see run-stage-publication.ts: Supabase codegen gap, RPC accepts null
      p_staged_by: staffId,
    });

    const { error: firstConfirm } = await admin.rpc('confirm_publication_transactional', { p_draft_id: draft!.id, p_confirmed_by: staffId });
    expect(firstConfirm).toBeNull();

    const { error: secondConfirm } = await admin.rpc('confirm_publication_transactional', { p_draft_id: draft!.id, p_confirmed_by: staffId });
    expect(secondConfirm).not.toBeNull();
  });

  it(
    'rejects confirming a draft whose fingerprint has drifted since staging, but leaves the draft stuck in staged status rather than expired',
    async () => {
      const { data: draft } = await admin.rpc('stage_publication_transactional', {
        p_allocation_run_id: allocationRunId,
        p_change_event_ids: null as unknown as string[], // see run-stage-publication.ts: Supabase codegen gap, RPC accepts null
        p_staged_by: staffId,
      });

      // Mutate source data (part of the fingerprint) after staging.
      await admin.from('allocation_assignments').update({ suitability_score: 0.42 }).eq('id', assignmentIds[0]);

      const { error: confirmError } = await admin.rpc('confirm_publication_transactional', { p_draft_id: draft!.id, p_confirmed_by: staffId });
      expect(confirmError).not.toBeNull();
      expect(confirmError?.message).toMatch(/source data changed/i);

      // KNOWN BUG (flagged to the orchestrator, not silently fixed): the
      // function's `update schedule_publication_drafts set status = 'expired'`
      // runs in the same statement/transaction as the `raise exception` that
      // follows it. Since nothing establishes a savepoint around that
      // update, Postgres unconditionally rolls it back together with the
      // rest of the failed call the moment the exception propagates to the
      // caller (verified directly: a bare `raise exception` after an
      // `update` in a plpgsql function, called via a single top-level
      // `select fn()` with no enclosing exception handler, always leaves the
      // update un-committed). So the draft is left in 'staged', not
      // 'expired', even though the plan's comment describes this as an
      // 'expired' rejection path. A caller could re-attempt the same staged
      // draft; the drift is re-detected and rejected again every time (so
      // this is NOT a data-integrity hole), but the draft never reaches the
      // terminal 'expired' status the schema's check constraint and the
      // plan's own inline comment both describe.
      const { data: draftAfter } = await admin.from('schedule_publication_drafts').select('status').eq('id', draft!.id).single();
      expect(draftAfter?.status).toBe('staged');

      // Restore the mutated value so this test doesn't affect later runs
      // that might reuse the same fixture id ordering within this file.
      await admin.from('allocation_assignments').update({ suitability_score: 0.9 }).eq('id', assignmentIds[0]);
    },
    15000
  );
});

describe('confirm_publication_transactional behavioral suite (change-propagation path)', () => {
  it('carries forward every item from the prior active revision on confirm, refreshing frozen fields only for changed sessions', async () => {
    // Establish revision 1 via a normal run-publish, matching the suite
    // above — this becomes the "prior active revision" the change-
    // propagation confirm must carry forward from.
    const { data: setupDraft } = await admin.rpc('stage_publication_transactional', {
      p_allocation_run_id: allocationRunId,
      p_change_event_ids: null as unknown as string[], // see run-stage-publication.ts: Supabase codegen gap, RPC accepts null
      p_staged_by: staffId,
    });
    await admin.rpc('confirm_publication_transactional', { p_draft_id: setupDraft!.id, p_confirmed_by: staffId });

    const { data: revisionOne } = await admin
      .from('schedule_publications')
      .select('id, revision_number')
      .eq('application_id', applicationId)
      .eq('status', 'active')
      .single();
    expect(revisionOne?.revision_number).toBe(1);
    const { data: revisionOneItems } = await admin.from('schedule_publication_items').select('*').eq('schedule_publication_id', revisionOne!.id);
    expect(revisionOneItems).toHaveLength(1);

    // Change the session's time — this is what the previously-reported bug
    // exercised: confirming a change-propagation draft was producing a new
    // active revision with ZERO items instead of carrying the item forward
    // with its frozen fields refreshed.
    await admin.from('sessions').update({ start_time: `${conferenceDate}T09:30:00Z`, end_time: `${conferenceDate}T10:30:00Z` }).eq('id', sessionId);
    const { data: events } = await admin
      .from('schedule_change_events')
      .select('id')
      .eq('session_id', sessionId)
      .is('processed_at', null);
    expect(events?.length).toBeGreaterThan(0);

    const { data: changeDraft, error: stageError } = await admin.rpc('stage_publication_transactional', {
      p_allocation_run_id: null as unknown as string, // see run-stage-publication.ts: Supabase codegen gap, RPC accepts null
      p_change_event_ids: events!.map((e) => e.id),
      p_staged_by: staffId,
    });
    expect(stageError).toBeNull();

    const { data: draftItems } = await admin
      .from('schedule_publication_draft_items')
      .select('*')
      .eq('schedule_publication_draft_id', changeDraft!.id)
      .eq('application_id', applicationId)
      .single();
    expect(draftItems?.verdict).toBe('publishable');

    const { data: confirmed, error: confirmError } = await admin.rpc('confirm_publication_transactional', {
      p_draft_id: changeDraft!.id,
      p_confirmed_by: staffId,
    });
    expect(confirmError).toBeNull();
    expect(confirmed?.status).toBe('confirmed');

    const { data: revisionTwo } = await admin
      .from('schedule_publications')
      .select('id, revision_number, status')
      .eq('application_id', applicationId)
      .eq('status', 'active')
      .single();
    expect(revisionTwo?.revision_number).toBe(2);

    const { data: revisionTwoItems } = await admin.from('schedule_publication_items').select('*').eq('schedule_publication_id', revisionTwo!.id);
    // The core regression check: the item must be carried forward, not lost.
    expect(revisionTwoItems).toHaveLength(1);
    expect(revisionTwoItems?.[0].session_id).toBe(sessionId);
    // The changed session's frozen time fields must reflect the new values,
    // not the stale ones copied verbatim from revision 1.
    expect(new Date(revisionTwoItems![0].start_time!).toISOString()).toBe(`${conferenceDate}T09:30:00.000Z`);
    expect(new Date(revisionTwoItems![0].end_time!).toISOString()).toBe(`${conferenceDate}T10:30:00.000Z`);
    // Unrelated frozen fields untouched by this change carry forward as-is.
    expect(revisionTwoItems?.[0].room_name_ar).toBe('قاعة النشر');
    expect(revisionTwoItems?.[0].session_title_en).toBe('Confirm Publication Session');

    // Revision 1 remains immutable — untouched by the refresh.
    const { data: revisionOneAfter } = await admin.from('schedule_publications').select('status').eq('id', revisionOne!.id).single();
    expect(revisionOneAfter?.status).toBe('superseded');
    const { data: revisionOneItemsAfter } = await admin.from('schedule_publication_items').select('start_time').eq('schedule_publication_id', revisionOne!.id);
    expect(new Date(revisionOneItemsAfter![0].start_time!).toISOString()).toBe(`${conferenceDate}T09:00:00.000Z`);
  });
});

describe('confirm_publication_transactional behavioral suite (cancellation blocking, mandatory and elective)', () => {
  // Regression coverage for a code-review finding: staging previously only
  // treated a cancelled MANDATORY session as blocking, letting an elective
  // session's cancellation silently reach confirm with no admin review —
  // contrary to the spec's Change Propagation Policy, which requires admin
  // resolution "before any draft including this participant can be
  // confirmed" for ANY cancellation, not just mandatory ones. This suite
  // uses its own self-contained fixture (a second, elective session) so it
  // doesn't interfere with the mandatory-session fixture used above.
  let electiveSessionId: string;
  let electiveApplicantUserId: string;
  let electiveApplicationId: string;

  afterAll(async () => {
    const { data: pubs } = await admin.from('schedule_publications').select('id').eq('application_id', electiveApplicationId);
    if (pubs && pubs.length > 0) {
      await admin
        .from('schedule_publication_items')
        .delete()
        .in(
          'schedule_publication_id',
          pubs.map((p) => p.id)
        );
      await admin.from('schedule_publications').delete().eq('application_id', electiveApplicationId);
    }
    // Same NULL-allocation_run_id gap as the top-level afterAll above: this
    // block's own draft (line ~475) stages with p_allocation_run_id: null,
    // so it must be found via schedule_publication_draft_items.application_id
    // rather than allocation_run_id.
    const { data: draftItemRows } = await admin.from('schedule_publication_draft_items').select('schedule_publication_draft_id').eq('application_id', electiveApplicationId);
    const ownDraftIds = [...new Set((draftItemRows ?? []).map((r) => r.schedule_publication_draft_id))];
    if (ownDraftIds.length > 0) {
      await admin.from('schedule_publication_drafts').delete().in('id', ownDraftIds);
    }
    await admin.from('schedule_change_events').delete().eq('session_id', electiveSessionId);
    await admin.from('applications').delete().eq('id', electiveApplicationId);
    await admin.from('sessions').delete().eq('id', electiveSessionId);
    await admin.auth.admin.deleteUser(electiveApplicantUserId);
  });

  // 15+ live-DB round trips (createUser, session/application/publication/
  // item inserts, a cancellation update, stage+confirm) — timed out at the
  // schedule-live project's own 15000ms default under real batch load
  // (observed once; passes reliably in isolation), same class as the
  // per-test overrides this file family already needed elsewhere before
  // the project-level timeout existed.
  it('blocks confirming a change-propagation draft when an ELECTIVE session in it was cancelled, same as a mandatory one would', async () => {
    const { data: electiveApplicant } = await admin.auth.admin.createUser({
      email: `confirm-pub-behavior-elective-p1-${runId}@test.local`,
      password: 'password123',
      email_confirm: true,
    });
    electiveApplicantUserId = electiveApplicant!.user!.id;

    const { data: electiveSession } = await admin
      .from('sessions')
      .insert({
        session_code: `CONFIRM-PUB-ELECTIVE-SESSION-1-${runId}`,
        title_ar: 'جلسة اختيارية',
        title_en: 'Elective Session',
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
    electiveSessionId = electiveSession!.id;

    const { data: electiveApplication } = await admin
      .from('applications')
      .insert({ applicant_id: electiveApplicantUserId, status: 'accepted' })
      .select('id')
      .single();
    electiveApplicationId = electiveApplication!.id;

    // Publish revision 1 directly (bypassing stage/confirm, since this
    // suite only needs an existing active revision referencing the
    // elective session to test the cancellation gate against).
    const { data: publication } = await admin
      .from('schedule_publications')
      .insert({
        application_id: electiveApplicationId,
        allocation_run_id: allocationRunId,
        revision_number: 1,
        status: 'active',
        source_fingerprint: 'seed',
        published_by: staffId,
      })
      .select('id')
      .single();
    await admin.from('schedule_publication_items').insert({
      schedule_publication_id: publication!.id,
      session_id: electiveSessionId,
      session_title_ar: 'جلسة اختيارية',
      session_title_en: 'Elective Session',
      room_name_ar: 'قاعة النشر',
      room_name_en: 'Publish Room',
      start_time: `${conferenceDate}T11:00:00Z`,
      end_time: `${conferenceDate}T12:00:00Z`,
      is_mandatory: false,
      item_status: 'active',
    });

    // Cancel the elective session — this is the trigger from Task 5 firing
    // a real schedule_change_events row. cancellation_reason is required by
    // a pre-existing Phase 4 trigger (enforce_session_status_transition)
    // whenever status transitions to 'cancelled'.
    const { error: cancelError } = await admin
      .from('sessions')
      .update({ status: 'cancelled', cancellation_reason: 'Test cancellation' })
      .eq('id', electiveSessionId);
    expect(cancelError).toBeNull();
    const { data: events } = await admin
      .from('schedule_change_events')
      .select('id')
      .eq('session_id', electiveSessionId)
      .is('processed_at', null)
      .eq('change_type', 'cancelled');
    expect(events?.length).toBeGreaterThan(0);

    const { data: draft } = await admin.rpc('stage_publication_transactional', {
      p_allocation_run_id: null as unknown as string, // see run-stage-publication.ts: Supabase codegen gap, RPC accepts null
      p_change_event_ids: events!.map((e) => e.id),
      p_staged_by: staffId,
    });

    const { data: draftItem } = await admin
      .from('schedule_publication_draft_items')
      .select('*')
      .eq('schedule_publication_draft_id', draft!.id)
      .eq('application_id', electiveApplicationId)
      .single();
    // The core fix: an elective session's cancellation blocks, exactly
    // like a mandatory one would — not publishable, not silently no_change.
    expect(draftItem?.verdict).toBe('blocked_mandatory');

    // Confirming must reject: this draft item has no resolution, so
    // confirm's own filter (`verdict = 'publishable' or (verdict =
    // 'blocked_mandatory' and resolution is not null)`) skips it entirely
    // — the participant gets no new revision at all this confirm call.
    const { data: confirmed, error: confirmError } = await admin.rpc('confirm_publication_transactional', {
      p_draft_id: draft!.id,
      p_confirmed_by: staffId,
    });
    expect(confirmError).toBeNull();
    expect(confirmed?.status).toBe('confirmed');

    const { data: publicationsAfter } = await admin.from('schedule_publications').select('status').eq('application_id', electiveApplicationId);
    // Still exactly the original revision 1, still active — no new revision
    // was created for this participant, and their published schedule was
    // never silently mutated to reflect the unresolved cancellation.
    expect(publicationsAfter).toHaveLength(1);
    expect(publicationsAfter?.[0].status).toBe('active');
  }, 30000);
});
