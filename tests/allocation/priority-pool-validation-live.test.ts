// tests/allocation/priority-pool-validation-live.test.ts
//
// Live end-to-end test for the second, independent issue-derivation pass
// wired into runAllocation (src/lib/allocation/run-allocation.ts) via
// derivePriorityPoolIssues. Follows the fixture conventions established in
// tests/allocation/run-behavioral.test.ts: throwaway auth users backing
// application rows, a single conference_day/room/track/session_type/tag,
// and cleanup ordered around FK dependencies (allocation_runs first, then
// feature_extraction_runs, then sessions, then the rest).
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
let electiveSessionId: string; // capacity=10, priority_seats=3
const applicantUserIds: string[] = [];
const applicationIds: string[] = [];

async function seedAcceptedApplicant(emailSlug: string): Promise<string> {
  const { data: user } = await admin.auth.admin.createUser({
    email: `priority-pool-live-${runId}-${emailSlug}@test.local`,
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
      preferred_language: 'ar',
      experience_level: 'beginner',
      interests: [],
    })
    .select('id')
    .single();
  applicationIds.push(app!.id);
  return app!.id;
}

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({ email: `priority-pool-live-${runId}-staff@test.local`, password: 'password123', email_confirm: true });
  staffId = staff.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: day, error: dayErr } = await admin.from('conference_days').insert({ conference_date: CONFERENCE_DATE, label_ar: 'يوم 1', label_en: 'Day 1', display_order: 1 }).select('id').single();
  if (dayErr) throw new Error(`Failed to seed conference_day: ${dayErr.message}`);
  conferenceDayId = day!.id;
  const { data: room } = await admin.from('rooms').insert({ code: `PPOOL-TEST-ROOM-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 10 }).select('id').single();
  roomId = room!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `PPOOL-TEST-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sessionType } = await admin.from('session_types').insert({ code: `PPOOL-TEST-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;

  // capacity=10 lets the deferred-acceptance algorithm (which caps
  // recommendations by full `capacity`, not `priority_seats` -- see
  // run-allocation.ts's use of session.capacity in deferred-acceptance.ts)
  // recommend all 5 eligible participants seeded below, which exceeds the
  // priority_seats=3 pool while staying under capacity.
  const { data: elective } = await admin
    .from('sessions')
    .insert({
      session_code: `PPOOL-ELECTIVE-1-${runId}`, title_ar: 'اختيارية', title_en: 'Elective', conference_day_id: conferenceDayId,
      start_time: `${CONFERENCE_DATE}T11:00:00Z`, end_time: `${CONFERENCE_DATE}T12:00:00Z`, track_id: trackId, session_type_id: sessionTypeId,
      room_id: roomId, language: 'bilingual', difficulty_level: 'all_levels', capacity: 10, priority_seats: 3, is_mandatory: false, status: 'confirmed',
    })
    .select('id')
    .single();
  electiveSessionId = elective!.id;

  for (let i = 0; i < 5; i++) {
    await seedAcceptedApplicant(`app-${i}`);
  }
});

afterAll(async () => {
  // Same FK-dependency-ordered cleanup as run-behavioral.test.ts: allocation
  // runs first (cascades assignments/alternatives/issues/explanations), then
  // feature extraction runs, then sessions, then the rest.
  await admin.from('allocation_runs').delete().eq('run_by', staffId);
  await admin.from('feature_extraction_runs').delete().eq('run_by', staffId);
  await admin.from('sessions').delete().eq('id', electiveSessionId);

  await Promise.allSettled([
    admin.from('applications').delete().in('id', applicationIds),
    admin.from('conference_days').delete().eq('id', conferenceDayId),
    admin.from('rooms').delete().eq('id', roomId),
    admin.from('tracks').delete().eq('id', trackId),
    admin.from('session_types').delete().eq('id', sessionTypeId),
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
    ...applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)),
  ]);
});

describe('priority-pool validation (live)', () => {
  it('flags priority_pool_exceeded when recommended count exceeds priority_seats', async () => {
    // This chains extraction + allocation + two further selects against the
    // live hosted project, structurally similar to run-behavioral.test.ts's
    // override/confirm tests which needed a raised timeout for the same
    // reason -- default 5000ms is a tight margin under real network latency.
    const extraction = await runFeatureExtraction(admin, staffId);
    const run = await runAllocation(admin, staffId, extraction.id);

    const { data: assignments } = await admin
      .from('allocation_assignments')
      .select('id')
      .eq('allocation_run_id', run.id)
      .eq('session_id', electiveSessionId);
    // Sanity check: the fixture must actually recommend more than
    // priority_seats=3 for this session, otherwise the test doesn't
    // exercise the code path it claims to.
    expect((assignments ?? []).length).toBeGreaterThan(3);

    const { data: issues } = await admin
      .from('allocation_issues')
      .select('issue_type, session_id, details')
      .eq('allocation_run_id', run.id)
      .eq('issue_type', 'priority_pool_exceeded')
      .eq('session_id', electiveSessionId);
    expect(issues?.length).toBe(1);
    expect(issues?.[0].details).toMatchObject({ priority_seats: 3 });
  }, 15000);
});
