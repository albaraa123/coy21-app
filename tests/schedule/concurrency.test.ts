// tests/schedule/concurrency.test.ts
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { stagePublication } from '@/lib/schedule/run-stage-publication';
import { confirmPublication } from '@/lib/schedule/run-confirm-publication';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

// Collision-proofing suffix, same rationale as tests/schedule/authorization.test.ts.
// Year 2089 reserved for this file.
const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 300) + 1;
const conferenceDate = new Date(Date.UTC(2089, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let staffId: string;
let applicantUserId: string;
let applicationId: string;
let conferenceDayId: string;
let roomId: string;
let trackId: string;
let sessionTypeId: string;
let mandatorySessionId: string;
let allocationRunId: string;

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({ email: `schedule-concurrency-staff-${runId}@test.local`, password: 'password123', email_confirm: true });
  staffId = staff.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: applicantUser } = await admin.auth.admin.createUser({ email: `schedule-concurrency-applicant-${runId}@test.local`, password: 'password123', email_confirm: true });
  applicantUserId = applicantUser.user!.id;

  const { data: app } = await admin.from('applications').insert({ applicant_id: applicantUserId, status: 'accepted' }).select('id').single();
  applicationId = app!.id;

  const { data: day } = await admin.from('conference_days').insert({ conference_date: conferenceDate, label_ar: 'Day', label_en: 'Day', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;
  const { data: room } = await admin.from('rooms').insert({ code: `CONCUR-ROOM-${runId}`, name_ar: 'R', name_en: 'Room', capacity: 10 }).select('id').single();
  roomId = room!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `CONCUR-TRACK-${runId}`, name_ar: 'T', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sessionType } = await admin.from('session_types').insert({ code: `CONCUR-TYPE-${runId}`, name_ar: 'S', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;

  const { data: mandatory } = await admin.from('sessions').insert({
    session_code: `CONCUR-MANDATORY-1-${runId}`, title_ar: 'M', title_en: 'Mandatory', conference_day_id: conferenceDayId,
    start_time: `${conferenceDate}T09:00:00Z`, end_time: `${conferenceDate}T10:00:00Z`, track_id: trackId, session_type_id: sessionTypeId,
    room_id: roomId, language: 'bilingual', difficulty_level: 'all_levels', capacity: 5, is_mandatory: true, status: 'confirmed',
  }).select('id').single();
  mandatorySessionId = mandatory!.id;

  const { data: featureRun } = await admin.from('feature_extraction_runs').insert({ rules_version: 1, application_count: 1, run_by: staffId }).select('id').single();
  const { data: run } = await admin.from('allocation_runs').insert({
    feature_extraction_run_id: featureRun!.id,
    status: 'confirmed', run_by: staffId, confirmed_at: new Date().toISOString(), confirmed_by: staffId,
  }).select('id').single();
  allocationRunId = run!.id;

  await admin.from('allocation_assignments').insert({
    allocation_run_id: allocationRunId, application_id: applicationId, session_id: mandatorySessionId,
    time_slot_group_key: 'k1', suitability_score: 1, is_mandatory_assignment: true, status: 'confirmed', updated_by: staffId,
  });
});

afterAll(async () => {
  const { data: publications } = await admin.from('schedule_publications').select('id').eq('application_id', applicationId);
  if (publications && publications.length > 0) {
    await admin.from('schedule_publication_items').delete().in('schedule_publication_id', publications.map((p) => p.id));
    await admin.from('schedule_publications').delete().in('id', publications.map((p) => p.id));
  }
  const { data: drafts } = await admin.from('schedule_publication_drafts').select('id').eq('allocation_run_id', allocationRunId);
  if (drafts && drafts.length > 0) await admin.from('schedule_publication_drafts').delete().in('id', drafts.map((d) => d.id));
  await admin.from('schedule_change_events').delete().eq('session_id', mandatorySessionId);
  await admin.from('allocation_assignments').delete().eq('allocation_run_id', allocationRunId);
  await admin.from('allocation_runs').delete().eq('id', allocationRunId);
  await admin.from('sessions').delete().eq('id', mandatorySessionId);
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

describe('concurrent publication confirmation', () => {
  // Deterministic proof, not a Promise.allSettled dispatch-timing race.
  //
  // The original version of this test raced two full confirmPublication()
  // RPC calls via Promise.allSettled and asserted exactly one succeeded.
  // That is NOT a valid proof of the advisory lock's exclusion behavior:
  // confirm_publication_transactional's lock is pg_try_advisory_xact_lock
  // (the non-blocking variant) held only for that one RPC's own brief
  // execution — if request A's transaction commits and releases the lock
  // before request B's request even reaches PostgREST's own connection/
  // routing, B's pg_try_advisory_xact_lock call finds the lock free and
  // legitimately succeeds too. Both calls succeeding is then a CORRECT
  // sequential outcome, not a locking defect — but the test's assertion
  // couldn't tell the difference, so it flaked under real load (proven:
  // failed twice in a full 6-file batch run, including after eliminating
  // cross-file Vitest contention via fileParallelism: false, yet passed
  // 6/6 reliably every time it ran alone).
  //
  // This version instead HOLDS the exact same advisory lock key
  // (hashtext(allocation_run_id::text) — read directly from
  // supabase/migrations/20260723195000_confirm_publication_function.sql)
  // on a dedicated raw PostgreSQL connection, confirms via pg_locks that
  // the lock is genuinely granted to that connection's own backend PID,
  // and ONLY THEN calls the real confirm_publication_transactional RPC —
  // guaranteeing true happens-before ordering. This proves the RPC's own
  // pg_try_advisory_xact_lock call correctly finds a held lock and
  // rejects, which is the actual behavior under test — the same
  // cloud-native direct-connection methodology already established in
  // tests/attendance/cloud-native-lock-observer.ts for
  // qr-issuance-reservation.test.ts's concurrency proofs.
  it('rejects confirming when another transaction genuinely holds the same allocation_run_id advisory lock', async () => {
    const draft = await stagePublication(admin, staffId, { allocationRunId });

    const connectionString = process.env.PHASE6_TEST_DATABASE_URL;
    if (!connectionString) {
      throw new Error('PHASE6_TEST_DATABASE_URL is not set — required for this deterministic advisory-lock proof.');
    }
    const holderClient = new pg.Client({ connectionString });
    holderClient.on('error', () => undefined);
    await holderClient.connect();
    try {
      await holderClient.query('begin');
      const { rows: lockRows } = await holderClient.query<{ locked: boolean }>(
        'select pg_try_advisory_xact_lock(hashtext($1::text)) as locked',
        [allocationRunId]
      );
      expect(lockRows[0].locked).toBe(true);

      // Confirm the lock is genuinely visible as granted from a SEPARATE
      // connection — not just "the query returned true", but the actual
      // Postgres-level lock state another session will see.
      const { rows: pidRows } = await holderClient.query<{ pid: number }>('select pg_backend_pid() as pid');
      const holderPid = pidRows[0].pid;
      const observerClient = new pg.Client({ connectionString });
      observerClient.on('error', () => undefined);
      await observerClient.connect();
      try {
        const { rows: observedLocks } = await observerClient.query<{ granted: boolean }>(
          `select granted from pg_locks where pid = $1 and locktype = 'advisory' and granted = true`,
          [holderPid]
        );
        expect(observedLocks.length).toBeGreaterThan(0);
      } finally {
        await observerClient.end();
      }

      // Only now — with the lock PROVEN held, not merely dispatched close
      // in time — call the real production RPC via the normal PostgREST
      // path (same client every other test in this file uses).
      await expect(confirmPublication(admin, draft.id, staffId)).rejects.toThrow(
        'Another publication for this source is already in progress'
      );

      // No publication was created while the lock was held.
      const { data: publicationsWhileLocked } = await admin
        .from('schedule_publications')
        .select('id')
        .eq('application_id', applicationId);
      expect(publicationsWhileLocked ?? []).toHaveLength(0);
    } finally {
      await holderClient.query('rollback').catch(() => undefined);
      await holderClient.end();
    }

    // Lock released (holder transaction rolled back) — the SAME draft can
    // now be confirmed successfully, proving the earlier rejection was
    // genuinely caused by the lock, not some unrelated failure.
    const confirmed = await confirmPublication(admin, draft.id, staffId);
    expect(confirmed.status).toBe('confirmed');
    const { data: publicationsAfter } = await admin
      .from('schedule_publications')
      .select('id')
      .eq('application_id', applicationId);
    expect(publicationsAfter).toHaveLength(1);
  });
});
