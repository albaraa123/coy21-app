// tests/allocation/run-behavioral.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { runFeatureExtraction } from '@/lib/allocation/run-extraction';
import { runAllocation } from '@/lib/allocation/run-allocation';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 3000) + 1;
const CONFERENCE_DATE = new Date(Date.UTC(2099, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let staffId: string;
let conferenceDayId: string;
let roomId: string;
let trackId: string;
let sessionTypeId: string;
let mandatorySessionId: string;
let electiveSessionId: string;
let noMatchSessionId: string; // 'en'-only, so an 'ar'-only participant has zero eligible sessions here
let tagId: string;
const applicantUserIds: string[] = []; // throwaway auth users backing each applications.applicant_id
const applicationIds: string[] = [];

// Creates one throwaway auth user + its accepted application row. Returns
// the new applications.id. preferredLanguage/experienceLevel/interests feed
// the hard constraints and feature extraction directly.
async function seedAcceptedApplicant(opts: {
  emailSlug: string;
  preferredLanguage: string | null;
  experienceLevel: string | null;
  interests: string[];
}): Promise<string> {
  const { data: user } = await admin.auth.admin.createUser({
    email: `allocation-behavior-${runId}-${opts.emailSlug}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  const applicantId = user!.user!.id;
  applicantUserIds.push(applicantId);

  const { data: app } = await admin
    .from('applications')
    .insert({
      applicant_id: applicantId,
      status: 'accepted',
      preferred_language: opts.preferredLanguage,
      experience_level: opts.experienceLevel,
      interests: opts.interests,
    })
    .select('id')
    .single();
  applicationIds.push(app!.id);
  return app!.id;
}

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({ email: `allocation-behavior-${runId}-staff@test.local`, password: 'password123', email_confirm: true });
  staffId = staff.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: day } = await admin.from('conference_days').insert({ conference_date: CONFERENCE_DATE, label_ar: 'يوم 1', label_en: 'Day 1', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;
  const { data: room } = await admin.from('rooms').insert({ code: `ALLOC-TEST-ROOM-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 10 }).select('id').single();
  roomId = room!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `ALLOC-TEST-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sessionType } = await admin.from('session_types').insert({ code: `ALLOC-TEST-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;
  const { data: tag } = await admin.from('tags').insert({ code: `ALLOC-TEST-TAG-${runId}`, name_ar: 'وسم', name_en: 'Tag' }).select('id').single();
  tagId = tag!.id;

  const { data: mandatory } = await admin
    .from('sessions')
    .insert({
      session_code: `ALLOC-MANDATORY-1-${runId}`, title_ar: 'إلزامية', title_en: 'Mandatory', conference_day_id: conferenceDayId,
      start_time: `${CONFERENCE_DATE}T09:00:00Z`, end_time: `${CONFERENCE_DATE}T10:00:00Z`, track_id: trackId, session_type_id: sessionTypeId,
      // difficulty_level: 'advanced' (not 'all_levels') isolates this
      // scenario from the shared disposable-project accepted-application
      // pool (Phase 7G-K test-isolation finding, same root cause and same
      // fix already applied to the sibling elective session below): with
      // capacity=1 and 'all_levels', every one of the ~900 shared accepted
      // applications is hard-constraint-eligible and competes for the one
      // seat, producing thousands of unrelated 'unassigned' issues instead
      // of the exactly-2-participant oversubscription this test asserts.
      // 'advanced' hard-excludes all of them (their experience_level is
      // null -> 'beginner' tier, not adjacent to 'advanced') while the two
      // seeded applicants below (experienceLevel: 'expert' -> 'advanced'
      // tier) remain eligible -- runAllocation's own scoring/capacity
      // logic is completely unchanged; only which applicants are eligible
      // for this specific fixture session is narrowed.
      room_id: roomId, language: 'bilingual', difficulty_level: 'advanced', capacity: 1, is_mandatory: true, status: 'confirmed',
    })
    .select('id').single();
  mandatorySessionId = mandatory!.id;

  // difficulty_level: 'advanced' (not 'all_levels') and capacity: 3 (not 1)
  // are both load-bearing, not simplifiable:
  //
  // This is a live, shared Supabase project — 19+ real, non-test
  // applications with status='accepted' exist outside this test file's
  // control, all with preferred_language: null AND experience_level: null.
  // A null preferred_language matches any session language unconditionally
  // (checkStaticHardConstraints in hard-constraints.ts skips the language
  // check for unrecognized/null values), so the language axis (the
  // noMatchSessionId pattern used elsewhere in this file) cannot be used to
  // exclude these real rows from this elective session. But
  // experience_level: null maps to 'beginner' tier via experienceToTier, and
  // isAdjacentOrEqualTier only admits tiers within 1 step of each other on
  // ['beginner', 'intermediate', 'advanced'] — 'advanced' is 2 steps from
  // 'beginner', i.e. NOT adjacent, so difficulty_level: 'advanced' hard-
  // excludes every one of those real applicants via the tier/difficulty
  // axis instead. app-0/app-1 below are seeded with experienceLevel:
  // 'expert' (-> 'advanced' tier) specifically so they remain eligible
  // despite this restriction.
  //
  // Capacity must be 3, not 2: with exactly 2 eligible (seeded) participants
  // and capacity 2, runAllocation's own elective pass (which runs on every
  // call, including the one the override test itself makes) would again
  // fill both seats, recreating the original P0001 "at capacity" failure.
  // Capacity 3 guarantees exactly 1 free seat survives the elective pass's
  // natural fill of 2, for the override test's RPC call to move into.
  const { data: elective } = await admin
    .from('sessions')
    .insert({
      session_code: `ALLOC-ELECTIVE-1-${runId}`, title_ar: 'اختيارية', title_en: 'Elective', conference_day_id: conferenceDayId,
      start_time: `${CONFERENCE_DATE}T11:00:00Z`, end_time: `${CONFERENCE_DATE}T12:00:00Z`, track_id: trackId, session_type_id: sessionTypeId,
      room_id: roomId, language: 'bilingual', difficulty_level: 'advanced', capacity: 3, is_mandatory: false, status: 'confirmed',
    })
    .select('id').single();
  electiveSessionId = elective!.id;
  await admin.from('session_tags').insert({ session_id: electiveSessionId, tag_id: tagId, weight: 1.0 });

  // 'en'-only, non-bilingual — an 'ar'-preferring participant is hard-
  // excluded from this session by the language constraint, giving that
  // participant zero eligible sessions in this slot group.
  const { data: noMatch } = await admin
    .from('sessions')
    .insert({
      session_code: `ALLOC-NOMATCH-1-${runId}`, title_ar: 'غير متاحة', title_en: 'No Match', conference_day_id: conferenceDayId,
      start_time: `${CONFERENCE_DATE}T13:00:00Z`, end_time: `${CONFERENCE_DATE}T14:00:00Z`, track_id: trackId, session_type_id: sessionTypeId,
      room_id: roomId, language: 'en', difficulty_level: 'all_levels', capacity: 5, is_mandatory: false, status: 'confirmed',
    })
    .select('id').single();
  noMatchSessionId = noMatch!.id;

  // experienceLevel: 'expert' (-> 'advanced' tier) keeps both seeded
  // participants eligible for electiveSessionId's difficulty_level:
  // 'advanced' restriction above — see the comment on that session's insert
  // for the full causal chain.
  await seedAcceptedApplicant({ emailSlug: 'app-0', preferredLanguage: 'ar', experienceLevel: 'expert', interests: [] });
  await seedAcceptedApplicant({ emailSlug: 'app-1', preferredLanguage: 'ar', experienceLevel: 'expert', interests: [] });
});

afterAll(async () => {
  // allocation_runs and feature_extraction_runs created by this file's `it`
  // blocks hold FK references (allocation_assignments.session_id/
  // .application_id, feature_extraction_runs.run_by, allocation_runs.
  // feature_extraction_run_id) to the staff profile, sessions, and
  // applications seeded here, with no ON DELETE CASCADE on any of those
  // columns (by design — production allocation/extraction history must
  // survive a session edit or a staff account being removed). Deleting
  // allocation_runs first cascades away every dependent
  // allocation_assignments/allocation_alternatives/allocation_issues/
  // allocation_assignment_explanations row, which unblocks deleting
  // feature_extraction_runs (itself now unreferenced by any allocation_run),
  // which unblocks deleting the staff profile/auth user below. Without this,
  // a leftover run from one execution of this file blocks its own next
  // execution's cleanup.
  await admin.from('allocation_runs').delete().eq('run_by', staffId);
  await admin.from('feature_extraction_runs').delete().eq('run_by', staffId);

  // sessions.room_id/.track_id/.session_type_id also have no ON DELETE
  // CASCADE, so sessions must be deleted before rooms/tracks/session_types
  // below — batching them together in the same Promise.allSettled would
  // race the two deletes against each other and non-deterministically fail
  // the room/track/session_type delete on the FK check whenever it happens
  // to run before the sessions delete commits.
  await admin.from('sessions').delete().in('id', [mandatorySessionId, electiveSessionId, noMatchSessionId]);

  await Promise.allSettled([
    admin.from('applications').delete().in('id', applicationIds),
    admin.from('conference_days').delete().eq('id', conferenceDayId),
    admin.from('rooms').delete().eq('id', roomId),
    admin.from('tracks').delete().eq('id', trackId),
    admin.from('session_types').delete().eq('id', sessionTypeId),
    admin.from('tags').delete().eq('id', tagId),
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
    ...applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)),
  ]);
});

describe('allocation run behavioral suite', () => {
  it(
    'oversubscribed mandatory session produces capacity_bottleneck and unassigned',
    async () => {
      const extraction = await runFeatureExtraction(admin, staffId);
      const run = await runAllocation(admin, staffId, extraction.id);

      const { data: issues } = await admin.from('allocation_issues').select('issue_type, application_id, session_id').eq('allocation_run_id', run.id);
      expect(issues?.some((i) => i.issue_type === 'capacity_bottleneck' && i.session_id === mandatorySessionId)).toBe(true);
      expect(issues?.some((i) => i.issue_type === 'unassigned')).toBe(true);
    },
    // Same structural shape as the other 15000-timeout tests in this file
    // (extraction + allocation against the real hosted Supabase project,
    // same order-of-magnitude wall-clock cost) — raised only for this test
    // rather than globally in vitest.config.ts.
    15000
  );

  it(
    'a participant hard-excluded from every session in a slot produces no_eligible_sessions',
    async () => {
      // Both seeded applicants prefer 'ar'; ALLOC-NOMATCH-1 is 'en'-only, so
      // in that session's own singleton slot group, both applicants have zero
      // eligible sessions.
      const extraction = await runFeatureExtraction(admin, staffId);
      const run = await runAllocation(admin, staffId, extraction.id);

      const { data: issues } = await admin
        .from('allocation_issues')
        .select('issue_type, application_id, details')
        .eq('allocation_run_id', run.id)
        .eq('issue_type', 'no_eligible_sessions');
      expect(issues?.some((i) => applicationIds.includes(i.application_id!))).toBe(true);
    },
    // Same structural shape as the other 15000-timeout tests in this file
    // (extraction + allocation against the real hosted Supabase project,
    // same order-of-magnitude wall-clock cost) — raised only for this test
    // rather than globally in vitest.config.ts.
    15000
  );

  it(
    'flags an assignment scoring below 0.4 as low_confidence, consistent with the stored score',
    async () => {
      // This live test only exercises the below-threshold side (the seeded
      // participants produce a 0-score match here, per the zero-vector
      // convention) — it does not seed a score at exactly the 0.4 boundary, so
      // it cannot by itself catch a `<` vs `<=` regression at the boundary.
      // That exact-boundary case is covered by the pure unit test
      // "does not flag low_confidence exactly at the threshold boundary" in
      // tests/allocation/issues.test.ts (Task 12) — this test's purpose is to
      // confirm the live orchestrator wires suitability_score/is_low_confidence
      // through to the database consistently with LOW_CONFIDENCE_THRESHOLD,
      // not to re-prove the boundary itself.
      const extraction = await runFeatureExtraction(admin, staffId);
      const run = await runAllocation(admin, staffId, extraction.id);

      // app-1 has no extracted tags at all (interests: []) -> cosine similarity
      // against ALLOC-ELECTIVE-1's tag resolves to 0 (zero-vector convention),
      // which is < 0.4 -> must be flagged low_confidence if assigned there.
      const { data: assignments } = await admin
        .from('allocation_assignments')
        .select('id, application_id, session_id, suitability_score, is_low_confidence')
        .eq('allocation_run_id', run.id)
        .eq('session_id', electiveSessionId);

      for (const a of assignments ?? []) {
        expect(a.is_low_confidence).toBe(a.suitability_score < 0.4);
      }
      // At least one zero-tag participant assigned to the tagged elective
      // session must be flagged, proving the below-threshold path actually ran.
      expect((assignments ?? []).some((a) => a.suitability_score < 0.4 && a.is_low_confidence)).toBe(true);
    },
    // Same structural shape as the other 15000-timeout tests in this file
    // (extraction + allocation against the real hosted Supabase project,
    // same order-of-magnitude wall-clock cost) — raised only for this test
    // rather than globally in vitest.config.ts.
    15000
  );

  it(
    'a manual override persists into the confirmed run final state',
    async () => {
      const extraction = await runFeatureExtraction(admin, staffId);
      const run = await runAllocation(admin, staffId, extraction.id);

      const { data: anAssignment } = await admin
        .from('allocation_assignments')
        .select('id, session_id')
        .eq('allocation_run_id', run.id)
        .neq('session_id', electiveSessionId)
        .limit(1)
        .maybeSingle();
      expect(anAssignment).not.toBeNull();

      const { data: overridden, error: overrideError } = await admin.rpc('override_allocation_assignment_transactional', {
        p_assignment_id: anAssignment!.id,
        p_new_session_id: electiveSessionId,
        p_overridden_by: staffId,
        p_override_reason: 'behavioral test override',
      });
      expect(overrideError).toBeNull();
      expect(overridden?.session_id).toBe(electiveSessionId);

      const { error: confirmError } = await admin.rpc('confirm_allocation_run_transactional', { p_run_id: run.id, p_confirmed_by: staffId });
      expect(confirmError).toBeNull();

      const { data: finalAssignment } = await admin.from('allocation_assignments').select('session_id, is_manual_override, status').eq('id', anAssignment!.id).single();
      expect(finalAssignment?.session_id).toBe(electiveSessionId);
      expect(finalAssignment?.is_manual_override).toBe(true);
      expect(finalAssignment?.status).toBe('confirmed');
    },
    // This test chains extraction + allocation + 2 RPC round-trips + a final
    // select against the live hosted project — measured at ~4993ms against
    // Vitest's 5000ms default, a structurally tight margin that intermittently
    // exceeds the default under ordinary latency variance, independent of any
    // bug in the code under test. Raised only for this test rather than
    // globally in vitest.config.ts, since every other test in this file
    // completes well under the default.
    15000
  );

  it(
    'confirming a run makes it immutable — a second confirm/override attempt is rejected',
    async () => {
      const extraction = await runFeatureExtraction(admin, staffId);
      const run = await runAllocation(admin, staffId, extraction.id);

      const { error: firstConfirm } = await admin.rpc('confirm_allocation_run_transactional', { p_run_id: run.id, p_confirmed_by: staffId });
      expect(firstConfirm).toBeNull();

      const { error: secondConfirm } = await admin.rpc('confirm_allocation_run_transactional', { p_run_id: run.id, p_confirmed_by: staffId });
      expect(secondConfirm).not.toBeNull();

      const { data: anAssignment } = await admin.from('allocation_assignments').select('id').eq('allocation_run_id', run.id).limit(1).maybeSingle();
      expect(anAssignment).not.toBeNull();

      const { error: overrideError } = await admin.rpc('override_allocation_assignment_transactional', {
        p_assignment_id: anAssignment!.id, p_new_session_id: electiveSessionId, p_overridden_by: staffId, p_override_reason: 'test',
      });
      expect(overrideError).not.toBeNull();
    },
    // Same structural shape as the override-persistence test above (extraction
    // + allocation + multiple RPC round-trips against the live project) —
    // observed timing out at exactly 5000ms under real contention (full suite
    // run). Same scoped fix: raise only this test's timeout.
    15000
  );
});
