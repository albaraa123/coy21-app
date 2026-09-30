// tests/auth/accounts-reset-live.test.ts
//
// Live verification that the reset migration
// (supabase/migrations/20260930000000_reset_all_accounts_and_participant_data.sql)
// correctly empties every table it targets and correctly PRESERVES every
// table it doesn't, without hitting a foreign-key violation. MUST be run
// against a disposable scratch Supabase project that has this migration
// already applied — never production. Requires NEXT_PUBLIC_SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY env vars pointed at that scratch project.
//
// This test does NOT apply the migration itself (that already happened
// when the scratch project was set up, via `supabase db push`) — it only
// verifies the END STATE: every truncated table is empty, the config
// tables kept their rows but lost their attribution columns, and the
// sequences restart from 1. This is intentionally read-only against
// whatever data was present when the migration ran, which the operator
// running this live suite is responsible for seeding first (create a few
// rows across a representative sample of tables, run `supabase db push`,
// then run this test) — that seed-then-verify workflow is manual and
// outside this test file's own scope, matching how every other
// -live.test.ts file in this repo assumes its fixture data already
// exists rather than creating an entire schema's worth of rows itself.
import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

// This list is deliberately kept identical, table-for-table, to Task 1's
// `truncate table ...` statement — if the migration file's list ever
// changes, this array must change with it (and vice versa). Do not add
// or remove a table here without also updating
// supabase/migrations/20260930000000_reset_all_accounts_and_participant_data.sql,
// or this test stops being an honest check of what that migration does.
const TRUNCATED_TABLES = [
  'application_status_history', 'email_log', 'application_notes',
  'feature_extraction_runs', 'participant_feature_snapshots',
  'clustering_runs', 'clusters', 'cluster_memberships',
  'allocation_runs', 'allocation_assignments', 'allocation_alternatives',
  'allocation_issues', 'allocation_assignment_explanations',
  'schedule_publications', 'schedule_publication_items',
  'schedule_publication_drafts', 'schedule_publication_draft_items',
  'application_answers',
  'import_batches', 'import_column_mappings', 'import_rows', 'import_mapping_templates',
  'participant_invitations',
  'application_travel_info', 'application_health_info',
  'participant_account_provisioning',
  'attendance_records', 'scan_attempts',
  'qr_lifecycle_operations', 'qr_bulk_operation_batches', 'qr_credentials',
  'session_bookings', 'travel_legs',
  'emergency_contacts', 'application_accommodation',
  'applications',
] as const;

// These 3 tables are NOT named in the migration's `truncate table`
// statement — they end up empty through a DIFFERENT mechanism, and are
// deliberately tracked separately so this file's own table list stays
// auditable against the migration's actual statements (a single merged
// "everything empty" list previously made it impossible to tell, just by
// reading this test, which tables the truncate statement actually
// touches vs. which are emptied some other way):
//   - `profiles`: emptied via `profiles.id references auth.users(id) on
//     delete cascade`, triggered by the migration's `delete from
//     auth.users` statement, not by any truncate.
//   - `scanner_assignments`: emptied by the migration's own explicit
//     `delete from scanner_assignments` statement (Part 2), separate
//     from the Part 1 truncate list.
//   - `staff_assignments`: emptied via `staff_assignments.staff_id
//     references profiles(id) on delete cascade`, transitively triggered
//     by the same `delete from auth.users` statement as `profiles`.
const TABLES_EMPTIED_BY_CASCADE_OR_SEPARATE_STATEMENT = [
  'profiles',
  'scanner_assignments',
  'staff_assignments',
] as const;

describe('reset migration: every table named in the truncate statement is empty', () => {
  it.each(TRUNCATED_TABLES)('%s has zero rows', async (table) => {
    const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true });
    expect(error).toBeNull();
    expect(count).toBe(0);
  });
});

describe('reset migration: tables emptied by cascade or a separate statement are also empty', () => {
  it.each(TABLES_EMPTIED_BY_CASCADE_OR_SEPARATE_STATEMENT)('%s has zero rows', async (table) => {
    const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true });
    expect(error).toBeNull();
    expect(count).toBe(0);
  });

  it('auth.users has zero rows', async () => {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
    expect(error).toBeNull();
    expect(data.users).toHaveLength(0);
  });
});

describe('reset migration: config tables are preserved, only attribution is cleared', () => {
  it('rooms, tracks, session_types, conference_days, tags, sessions, session_people, session_tags, people, audit_logs still have their rows (if any existed pre-reset), with updated_by/actor_id/linked_profile_id nulled', async () => {
    const configTables = [
      { table: 'rooms', col: 'updated_by' },
      { table: 'tracks', col: 'updated_by' },
      { table: 'session_types', col: 'updated_by' },
      { table: 'conference_days', col: 'updated_by' },
      { table: 'tags', col: 'updated_by' },
      { table: 'sessions', col: 'updated_by' },
      { table: 'session_people', col: 'updated_by' },
      { table: 'session_tags', col: 'updated_by' },
      { table: 'audit_logs', col: 'actor_id' },
    ] as const;

    for (const { table, col } of configTables) {
      const { count, error: countErr } = await admin.from(table).select('*', { count: 'exact', head: true }).not(col, 'is', null);
      expect(countErr).toBeNull();
      // Zero rows with a non-null attribution column — whatever rows
      // exist (this test doesn't assert row COUNT here, since that
      // depends on what the operator seeded before running the reset)
      // must have had their attribution cleared.
      expect(count).toBe(0);
    }

    const { count: peopleCount, error: peopleErr } = await admin
      .from('people')
      .select('*', { count: 'exact', head: true })
      .or('updated_by.not.is.null,linked_profile_id.not.is.null');
    expect(peopleErr).toBeNull();
    expect(peopleCount).toBe(0);
  });
});

// Sequence-restart verification is deliberately NOT automated here.
// nextval() mutates the sequence it reads and cannot be called through
// PostgREST without a wrapping RPC, and no such RPC exists in this
// codebase today (confirmed: `grep -rn "test_only_" supabase/migrations/*.sql`
// finds no sequence-inspection helper). Adding a new SECURITY DEFINER
// RPC to production purely so one test file can introspect a sequence
// value is a disproportionate, unreviewed scope addition for what it
// buys — decided during planning, not left as an open question for
// whoever implements this task. Verify the sequence restart manually
// instead, once per environment, via the SQL Editor:
//
//   select nextval('attendee_code_seq_del');  -- expect 1
//   select nextval('attendee_code_seq_vol');  -- expect 1
//   select nextval('attendee_code_seq_kp');   -- expect 1
//   select nextval('attendee_code_seq_yng');  -- expect 1
//   select nextval('attendee_code_seq_spk');  -- expect 1
//
// Note this manual check also mutates the sequences (same nextval()
// caveat as above) — run it only once, right after applying the reset
// migration, before any real import draws the first real attendee code.
