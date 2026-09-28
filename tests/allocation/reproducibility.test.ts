// tests/allocation/reproducibility.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { runFeatureExtraction } from '@/lib/allocation/run-extraction';
import { runAllocation } from '@/lib/allocation/run-allocation';
import { runClustering } from '@/lib/allocation/run-clustering';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
let staffId: string;

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({ email: `allocation-repro-${runId}-staff@test.local`, password: 'password123', email_confirm: true });
  staffId = staff.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);
});

afterAll(async () => {
  // allocation_runs/feature_extraction_runs/clustering_runs created by this
  // file's `it` blocks all hold a `run_by` FK reference to the staff profile
  // seeded here, with no ON DELETE CASCADE on that column (by design —
  // production allocation/extraction/clustering history must survive a staff
  // account being removed). Deleting allocation_runs first cascades away its
  // dependent allocation_assignments/allocation_alternatives/
  // allocation_issues/allocation_assignment_explanations rows, which
  // unblocks deleting feature_extraction_runs. clustering_runs also
  // references feature_extraction_runs(id) with no cascade, so it must be
  // deleted before feature_extraction_runs too; clustering_runs -> clusters
  // -> cluster_memberships does cascade (on delete cascade, confirmed in
  // supabase/migrations/20260723090000_clustering_tables.sql), so deleting
  // clustering_runs alone is sufficient to also remove clusters/
  // cluster_memberships. Only after all three run-tracking tables are
  // cleared can the staff profile/auth user below be deleted. Without this,
  // a leftover run from one execution of this file blocks its own next
  // execution's cleanup.
  await admin.from('allocation_runs').delete().eq('run_by', staffId);
  await admin.from('clustering_runs').delete().eq('run_by', staffId);
  await admin.from('feature_extraction_runs').delete().eq('run_by', staffId);

  await Promise.allSettled([staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve()]);
});

function normalizeAssignments(rows: { application_id: string; session_id: string; suitability_score: number; time_slot_group_key: string }[]) {
  return [...rows]
    .sort((a, b) => (a.application_id + a.time_slot_group_key).localeCompare(b.application_id + b.time_slot_group_key))
    .map((r) => ({ application_id: r.application_id, session_id: r.session_id, score: r.suitability_score, slot: r.time_slot_group_key }));
}

describe('reproducibility', () => {
  it(
    'identical extraction+allocation params against an unchanged snapshot produce identical assignments',
    async () => {
      const extractionA = await runFeatureExtraction(admin, staffId);
      const runA = await runAllocation(admin, staffId, extractionA.id);
      const { data: assignmentsA } = await admin
        .from('allocation_assignments')
        .select('application_id, session_id, suitability_score, time_slot_group_key')
        .eq('allocation_run_id', runA.id);

      // Second extraction over the same underlying accepted-applications data
      // (unchanged between the two runs in this test) must produce the same
      // snapshots, and a second allocation run over those snapshots must
      // produce the same assignments.
      const extractionB = await runFeatureExtraction(admin, staffId);
      const runB = await runAllocation(admin, staffId, extractionB.id);
      const { data: assignmentsB } = await admin
        .from('allocation_assignments')
        .select('application_id, session_id, suitability_score, time_slot_group_key')
        .eq('allocation_run_id', runB.id);

      expect(normalizeAssignments(assignmentsB ?? [])).toEqual(normalizeAssignments(assignmentsA ?? []));
    },
    // This test chains 2 full extraction+allocation round-trips (4 live
    // orchestrator calls total) against the live hosted project. A single
    // runFeatureExtraction+runAllocation pair measures ~11s against the
    // current baseline accepted-application count (confirmed directly via
    // tests/allocation/priority-pool-validation-live.test.ts, ~10.83s for
    // one pair after the Phase 7G-K session/allocation-residue cleanup) —
    // two pairs back-to-back genuinely need more than 15000ms, not just a
    // structurally-tight margin. Raised only for this test rather than
    // globally in vitest.config.ts.
    45000
  );

  it('identical clustering params (same seed+k) against an unchanged snapshot produce identical cluster memberships', async () => {
    const extraction = await runFeatureExtraction(admin, staffId);
    const clusterRunA = await runClustering(admin, staffId, extraction.id, 2, 42);
    const clusterRunB = await runClustering(admin, staffId, extraction.id, 2, 42);

    const { data: clustersA } = await admin.from('clusters').select('id, member_count').eq('clustering_run_id', clusterRunA.id);
    const { data: clustersB } = await admin.from('clusters').select('id, member_count').eq('clustering_run_id', clusterRunB.id);

    const memberCountsA = (clustersA ?? []).map((c) => c.member_count).sort();
    const memberCountsB = (clustersB ?? []).map((c) => c.member_count).sort();
    expect(memberCountsB).toEqual(memberCountsA);
  });
});
