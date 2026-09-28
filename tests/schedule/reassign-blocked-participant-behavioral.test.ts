// tests/schedule/reassign-blocked-participant-behavioral.test.ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

// Collision-proofing suffix, same rationale as tests/schedule/authorization.test.ts.
// Year 2092 reserved for this file.
const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 300) + 1;
const conferenceDate = new Date(Date.UTC(2092, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let staffId: string;
let conferenceDayId: string;
let roomId: string;
let trackId: string;
let sessionTypeId: string;
let originalSessionId: string;
let sessionAId: string;
let sessionBId: string;
const applicationIds: string[] = [];
const applicantUserIds: string[] = [];
let featureExtractionRunId: string;
let allocationRunId: string;
const assignmentIds: string[] = [];

async function makeApplicant(emailLocalPart: string) {
  const email = `${emailLocalPart}-${runId}@test.local`;
  const { data: applicant, error } = await admin.auth.admin.createUser({
    email,
    password: 'password123',
    email_confirm: true,
  });
  if (error || !applicant?.user) {
    throw new Error(`createUser failed for ${email}: ${error?.message}`);
  }
  applicantUserIds.push(applicant.user.id);
  const { data: application } = await admin
    .from('applications')
    .insert({ applicant_id: applicant.user.id, status: 'accepted' })
    .select('id')
    .single();
  applicationIds.push(application!.id);
  return { userId: applicant.user.id, applicationId: application!.id };
}

async function makeBlockedDraftItem(draftId: string, applicationId: string) {
  const { data: item } = await admin
    .from('schedule_publication_draft_items')
    .insert({
      schedule_publication_draft_id: draftId,
      application_id: applicationId,
      verdict: 'blocked_mandatory',
      blocker_details: { issue_type: 'mandatory_session_full', session_id: originalSessionId },
    })
    .select('*')
    .single();
  return item!;
}

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({
    email: `reassign-blocked-staff-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  staffId = staff!.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: day, error: dayError } = await admin
    .from('conference_days')
    .insert({ conference_date: conferenceDate, label_ar: 'يوم إعادة التعيين', label_en: 'Reassign Day', display_order: 1 })
    .select('id')
    .single();
  if (dayError || !day) throw new Error(`conference_days insert failed: ${JSON.stringify(dayError)}`);
  conferenceDayId = day.id;

  const { data: room } = await admin
    .from('rooms')
    .insert({ code: `REASSIGN-ROOM-${runId}`, name_ar: 'قاعة', name_en: 'Reassign Room', capacity: 10 })
    .select('id')
    .single();
  roomId = room!.id;

  const { data: track } = await admin.from('tracks').insert({ code: `REASSIGN-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin
    .from('session_types')
    .insert({ code: `REASSIGN-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' })
    .select('id')
    .single();
  sessionTypeId = sessionType!.id;

  // Each session gets a distinct time slot in the same room: sessions_room_no_overlap
  // (a GIST exclusion constraint added in 20260722220000_document_exclusion_constraint.sql)
  // rejects two sessions in the same room with overlapping time ranges.
  async function makeSession(codeSuffix: string, capacity: number, startHour: number) {
    const code = `${codeSuffix}-${runId}`;
    const start = `${conferenceDate}T${String(startHour).padStart(2, '0')}:00:00Z`;
    const end = `${conferenceDate}T${String(startHour + 1).padStart(2, '0')}:00:00Z`;
    const { data: session, error } = await admin
      .from('sessions')
      .insert({
        session_code: code,
        title_ar: `جلسة ${code}`,
        title_en: `Session ${codeSuffix}`,
        conference_day_id: conferenceDayId,
        start_time: start,
        end_time: end,
        track_id: trackId,
        session_type_id: sessionTypeId,
        room_id: roomId,
        language: 'bilingual',
        difficulty_level: 'all_levels',
        capacity,
        is_mandatory: true,
        status: 'confirmed',
      })
      .select('id')
      .single();
    if (error || !session) {
      throw new Error(`Failed to create session ${code}: ${error?.message}`);
    }
    return session.id as string;
  }

  originalSessionId = await makeSession('REASSIGN-ORIGINAL', 10, 9);
  sessionAId = await makeSession('REASSIGN-TARGET-A', 1, 10);
  sessionBId = await makeSession('REASSIGN-TARGET-B', 1, 11);

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
}, 30000);

afterAll(async () => {
  // schedule_publications rows are created by confirm_publication_transactional
  // (a real production RPC this file exercises directly) and must be deleted
  // before applications -- schedule_publications_application_id_fkey has no
  // cascade, so an orphaned row here silently blocks every applications
  // delete below. schedule_publication_items cascades from schedule_publications
  // itself, so no separate delete is needed for it.
  if (applicationIds.length > 0) {
    await admin.from('schedule_publications').delete().in('application_id', applicationIds);
  }
  await admin.from('schedule_publication_drafts').delete().eq('allocation_run_id', allocationRunId);
  if (assignmentIds.length > 0) {
    await admin.from('allocation_assignments').delete().in('id', assignmentIds);
  }
  await admin.from('allocation_runs').delete().eq('id', allocationRunId);
  await admin.from('feature_extraction_runs').delete().eq('id', featureExtractionRunId);
  if (applicationIds.length > 0) {
    await admin.from('applications').delete().in('id', applicationIds);
  }
  await admin.from('sessions').delete().in('id', [originalSessionId, sessionAId, sessionBId]);
  await Promise.allSettled([
    admin.from('conference_days').delete().eq('id', conferenceDayId),
    admin.from('rooms').delete().eq('id', roomId),
    admin.from('tracks').delete().eq('id', trackId),
    admin.from('session_types').delete().eq('id', sessionTypeId),
    admin.auth.admin.deleteUser(staffId),
    ...applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)),
  ]);
}, 30000);

describe('reassign_blocked_participant_transactional', () => {
  it('reassigns a blocked_mandatory item to a different session, flipping verdict to publishable and resolution to reassigned', async () => {
    const { userId, applicationId } = await makeApplicant('reassign-blocked-p1');
    const { data: draft } = await admin
      .from('schedule_publication_drafts')
      .insert({ allocation_run_id: allocationRunId, status: 'staged', staged_by: staffId, source_fingerprint: 'seed-1' })
      .select('id')
      .single();
    const item = await makeBlockedDraftItem(draft!.id, applicationId);
    expect(item.verdict).toBe('blocked_mandatory');

    const { data: reassigned, error } = await admin.rpc('reassign_blocked_participant_transactional', {
      p_draft_item_id: item.id,
      p_new_session_id: sessionAId,
      p_reassigned_by: staffId,
    });

    expect(error).toBeNull();
    expect(reassigned?.verdict).toBe('publishable');
    expect(reassigned?.resolution).toBe('reassigned');

    // Confirm no trace of which session was targeted is persisted anywhere
    // on the row itself — there is no session_id column on
    // schedule_publication_draft_items, and this RPC does not write
    // p_new_session_id into blocker_details either. This is documented
    // in the report as a real gap, not asserted here as desired behavior.
    void userId;
  });

  it('rejects reassigning a draft item that is not blocked_mandatory', async () => {
    const { applicationId } = await makeApplicant('reassign-blocked-p2');
    const { data: draft } = await admin
      .from('schedule_publication_drafts')
      .insert({ allocation_run_id: allocationRunId, status: 'staged', staged_by: staffId, source_fingerprint: 'seed-2' })
      .select('id')
      .single();
    const { data: item } = await admin
      .from('schedule_publication_draft_items')
      .insert({
        schedule_publication_draft_id: draft!.id,
        application_id: applicationId,
        verdict: 'publishable',
      })
      .select('*')
      .single();

    const { error } = await admin.rpc('reassign_blocked_participant_transactional', {
      p_draft_item_id: item!.id,
      p_new_session_id: sessionAId,
      p_reassigned_by: staffId,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/not blocked_mandatory/i);
  });

  it('rejects reassigning against a draft that is no longer staged', async () => {
    const { applicationId } = await makeApplicant('reassign-blocked-p3');
    const { data: draft } = await admin
      .from('schedule_publication_drafts')
      .insert({ allocation_run_id: allocationRunId, status: 'confirmed', staged_by: staffId, source_fingerprint: 'seed-3' })
      .select('id')
      .single();
    const item = await makeBlockedDraftItem(draft!.id, applicationId);

    const { error } = await admin.rpc('reassign_blocked_participant_transactional', {
      p_draft_item_id: item.id,
      p_new_session_id: sessionAId,
      p_reassigned_by: staffId,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/only staged drafts are editable/i);
  });

  it('rejects reassigning to a nonexistent session', async () => {
    const { applicationId } = await makeApplicant('reassign-blocked-p4');
    const { data: draft } = await admin
      .from('schedule_publication_drafts')
      .insert({ allocation_run_id: allocationRunId, status: 'staged', staged_by: staffId, source_fingerprint: 'seed-4' })
      .select('id')
      .single();
    const item = await makeBlockedDraftItem(draft!.id, applicationId);

    const { error } = await admin.rpc('reassign_blocked_participant_transactional', {
      p_draft_item_id: item.id,
      p_new_session_id: '00000000-0000-0000-0000-000000000000',
      p_reassigned_by: staffId,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/not found/i);
  });

  it('scopes the this-draft capacity recount by target session (reassigned_session_id), not draft-wide', async () => {
    // Regression test for a real gap found during initial implementation:
    // schedule_publication_draft_items originally had no column recording
    // which session a reassignment pointed at, so the capacity recount
    // counted every reassigned item in the whole draft regardless of
    // target session — incorrectly rejecting a reassignment to a
    // different, empty session just because an unrelated session was
    // full. Fixed by adding reassigned_session_id and scoping the count
    // by it (see 20260723201000_reassigned_session_id_column.sql).
    const { applicationId: appId1 } = await makeApplicant('reassign-blocked-cap1');
    const { applicationId: appId2 } = await makeApplicant('reassign-blocked-cap2');
    const { data: draft } = await admin
      .from('schedule_publication_drafts')
      .insert({ allocation_run_id: allocationRunId, status: 'staged', staged_by: staffId, source_fingerprint: 'seed-cap' })
      .select('id')
      .single();

    const item1 = await makeBlockedDraftItem(draft!.id, appId1);
    const item2 = await makeBlockedDraftItem(draft!.id, appId2);

    // First reassignment to session A (capacity 1): succeeds, fills it to
    // capacity within this draft's recount.
    const { data: firstReassign, error: firstError } = await admin.rpc('reassign_blocked_participant_transactional', {
      p_draft_item_id: item1.id,
      p_new_session_id: sessionAId,
      p_reassigned_by: staffId,
    });
    expect(firstError).toBeNull();
    expect(firstReassign?.resolution).toBe('reassigned');
    expect(firstReassign?.reassigned_session_id).toBe(sessionAId);

    // Second reassignment, SAME target session A, now at capacity within
    // this draft: correctly rejected.
    const { error: secondSameSessionError } = await admin.rpc('reassign_blocked_participant_transactional', {
      p_draft_item_id: item2.id,
      p_new_session_id: sessionAId,
      p_reassigned_by: staffId,
    });
    expect(secondSameSessionError).not.toBeNull();
    expect(secondSameSessionError?.message).toMatch(/at capacity/i);

    // The fix: reassigning the SAME still-blocked item2 to a DIFFERENT
    // session B (capacity 1, currently empty, unrelated to A) succeeds —
    // session B has zero reassignments against it, and the recount now
    // correctly scopes by reassigned_session_id rather than counting
    // draft-wide.
    const { data: crossSessionReassign, error: crossSessionError } = await admin.rpc('reassign_blocked_participant_transactional', {
      p_draft_item_id: item2.id,
      p_new_session_id: sessionBId,
      p_reassigned_by: staffId,
    });
    expect(crossSessionError).toBeNull();
    expect(crossSessionReassign?.resolution).toBe('reassigned');
    expect(crossSessionReassign?.reassigned_session_id).toBe(sessionBId);
  });

  it('confirm_publication_transactional publishes the reassigned session, not the original blocked mandatory slot', async () => {
    // Regression test for the other half of the same gap: confirm had no
    // way to know which session a 'reassigned' item should publish, since
    // reassigned_session_id didn't exist. Now it reads it directly.
    //
    // Uses stage_publication_transactional (not a hand-inserted draft row)
    // so source_fingerprint is the real value confirm will recompute and
    // compare against — a hand-typed placeholder fingerprint would always
    // mismatch and cause confirm to reject with "Source data changed",
    // unrelated to what this test actually verifies.
    const { applicationId } = await makeApplicant('reassign-blocked-confirm');
    const { data: draft } = await admin.rpc('stage_publication_transactional', {
      p_allocation_run_id: allocationRunId,
      p_change_event_ids: null as unknown as string[], // see run-stage-publication.ts: Supabase codegen gap, RPC accepts null
      p_staged_by: staffId,
    });
    // This participant has no allocation_assignments row for the mandatory
    // slot (none was ever created for them), so stage_publication_transactional
    // won't produce a draft item for them at all — insert the blocked item
    // directly, matching the pattern the other tests in this file use.
    const item = await makeBlockedDraftItem(draft!.id, applicationId);

    const { error: reassignError } = await admin.rpc('reassign_blocked_participant_transactional', {
      p_draft_item_id: item.id,
      p_new_session_id: sessionBId,
      p_reassigned_by: staffId,
    });
    expect(reassignError).toBeNull();

    const { data: confirmed, error: confirmError } = await admin.rpc('confirm_publication_transactional', {
      p_draft_id: draft!.id,
      p_confirmed_by: staffId,
    });
    expect(confirmError).toBeNull();
    expect(confirmed?.status).toBe('confirmed');

    const { data: publication } = await admin
      .from('schedule_publications')
      .select('id')
      .eq('application_id', applicationId)
      .eq('status', 'active')
      .single();
    const { data: items } = await admin.from('schedule_publication_items').select('*').eq('schedule_publication_id', publication!.id);

    // The published item must reflect session B (the reassignment target),
    // not the original blocked session, and not be missing entirely.
    expect(items).toHaveLength(1);
    expect(items?.[0].session_id).toBe(sessionBId);
    expect(items?.[0].session_title_en).toBe('Session REASSIGN-TARGET-B');
    expect(items?.[0].gap_reason).toBeNull();
  });
});
