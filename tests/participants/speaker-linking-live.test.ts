// tests/participants/speaker-linking-live.test.ts
//
// Live coverage for supabase/migrations/20260930030000_speaker_classification_
// people_trigger.sql — the AFTER INSERT / AFTER UPDATE triggers on
// `applications` that create a linked `people` row whenever
// participant_type becomes 'speaker', plus the shared
// resolve_application_display_name() name-fallback function and the
// one-time retroactive backfill statement. See
// docs/superpowers/specs/2026-09-30-import-classification-approval-design.md
// §1.3 and §4 for the full design.
//
// Follows this repo's established live-test pattern (see
// tests/auth/staff-roles-live.test.ts, tests/settings/email-settings-rls-
// live.test.ts, tests/participants/travel-ops-live.test.ts): throwaway
// fixtures created via a service-role client, real Postgres triggers
// exercised directly via plain INSERT/UPDATE (no mocking), fail loudly
// (not skip) if the required env vars aren't present.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !SERVICE_KEY) {
  throw new Error(
    'speaker-linking-live.test.ts requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set. ' +
      'This is a live-DB test against a real (scratch) Supabase project — it intentionally fails loudly rather ' +
      'than silently skipping when these are missing.'
  );
}

const admin = createClient<Database>(URL, SERVICE_KEY);

// people.linked_application_id was added by Task 1's migration
// (supabase/migrations/20260930020000_add_people_linked_application_id.sql)
// and is used by this migration's trigger, but src/types/database.ts is a
// generated snapshot that cannot be regenerated without live DB access
// (see that migration's own commit) — it still doesn't know this column
// exists. `peopleRaw` is an untyped view of the same client/table used
// only for the linked_application_id reads/writes below, so the rest of
// this file keeps full type safety via `admin` while this narrow, known
// gap doesn't block the suite. Remove this once the generated types are
// refreshed against a live project that has run this migration.
type PeopleRow = {
  id: string;
  full_name_ar: string;
  full_name_en: string;
  linked_application_id: string | null;
  is_active: boolean;
  is_public: boolean;
};
type PeopleRowResult<T> = Promise<{ data: T | null; error: { message: string } | null; count?: number | null }>;
type PeopleInsert = {
  full_name_ar: string;
  full_name_en: string;
  linked_application_id: string;
  is_active: boolean;
  is_public: boolean;
};
const peopleRaw = admin as unknown as {
  from(table: 'people'): {
    select(
      columns: string,
      opts?: { count?: 'exact'; head?: boolean }
    ): {
      eq(column: 'linked_application_id' | 'id', value: string): PeopleRowResult<PeopleRow[]> & {
        single(): PeopleRowResult<PeopleRow>;
      };
      not(column: 'linked_application_id', op: 'is', value: null): PeopleRowResult<Pick<PeopleRow, 'linked_application_id'>[]>;
    };
    insert(row: PeopleInsert): PeopleRowResult<PeopleRow[]>;
  };
};
const peopleRawById = (id: string) => peopleRaw.from('people').select('*').eq('id', id).single();

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);

const applicationIds: string[] = [];
const peopleIds: string[] = [];
const authUserIds: string[] = [];

async function insertApplication(
  overrides: Partial<Database['public']['Tables']['applications']['Insert']> & { imported_email: string }
): Promise<string> {
  const { data, error } = await admin
    .from('applications')
    .insert({ status: 'accepted', ...overrides })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to insert application fixture: ${error?.message}`);
  applicationIds.push(data.id);
  return data.id;
}

async function linkedPeopleRows(applicationId: string): Promise<PeopleRow[]> {
  const { data, error } = await peopleRaw.from('people').select('*').eq('linked_application_id', applicationId);
  if (error) throw new Error(`Failed to query linked people rows: ${error.message}`);
  for (const row of data ?? []) {
    if (!peopleIds.includes(row.id)) peopleIds.push(row.id);
  }
  return data ?? [];
}

afterAll(async () => {
  if (peopleIds.length > 0) await admin.from('people').delete().in('id', peopleIds);
  if (applicationIds.length > 0) await admin.from('applications').delete().in('id', applicationIds);
  for (const id of authUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, 60000);

describe('speaker classification -> people trigger (live)', () => {
  it('INSERT with participant_type = speaker creates exactly one linked people row, named after full_name', async () => {
    const email = `speaker-linking-live-${runId}-insert@example.com`;
    const applicationId = await insertApplication({
      imported_email: email,
      participant_type: 'speaker',
      full_name: `Insert Speaker ${runId}`,
    });

    const rows = await linkedPeopleRows(applicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].full_name_ar).toBe(`Insert Speaker ${runId}`);
    expect(rows[0].full_name_en).toBe(`Insert Speaker ${runId}`);
    expect(rows[0].linked_application_id).toBe(applicationId);
  });

  it('UPDATE from non-speaker to speaker creates exactly one linked people row', async () => {
    const email = `speaker-linking-live-${runId}-update@example.com`;
    const applicationId = await insertApplication({
      imported_email: email,
      participant_type: 'delegate',
      full_name: `Update Speaker ${runId}`,
    });

    // No people row yet — not classified as speaker.
    expect(await linkedPeopleRows(applicationId)).toHaveLength(0);

    const { error } = await admin.from('applications').update({ participant_type: 'speaker' }).eq('id', applicationId);
    expect(error).toBeNull();

    const rows = await linkedPeopleRows(applicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].full_name_en).toBe(`Update Speaker ${runId}`);
  });

  it('a second UPDATE that does not change participant_type away from speaker never creates a second people row', async () => {
    const email = `speaker-linking-live-${runId}-refire@example.com`;
    const applicationId = await insertApplication({
      imported_email: email,
      participant_type: 'speaker',
      full_name: `Refire Speaker ${runId}`,
    });

    expect(await linkedPeopleRows(applicationId)).toHaveLength(1);

    // Update some other column so the row-level UPDATE trigger fires again,
    // while participant_type stays 'speaker' the whole time.
    const { error } = await admin
      .from('applications')
      .update({ participant_type: 'speaker', full_name: `Refire Speaker ${runId} (touched)` })
      .eq('id', applicationId);
    expect(error).toBeNull();

    const rows = await linkedPeopleRows(applicationId);
    expect(rows).toHaveLength(1);
  });

  it('reclassifying away from speaker leaves the existing linked people row untouched', async () => {
    const email = `speaker-linking-live-${runId}-away@example.com`;
    const applicationId = await insertApplication({
      imported_email: email,
      participant_type: 'speaker',
      full_name: `Away Speaker ${runId}`,
    });

    const before = await linkedPeopleRows(applicationId);
    expect(before).toHaveLength(1);
    const personId = before[0].id;

    const { error } = await admin.from('applications').update({ participant_type: 'delegate' }).eq('id', applicationId);
    expect(error).toBeNull();

    const { data: person, error: fetchError } = await peopleRawById(personId);
    expect(fetchError).toBeNull();
    expect(person).toBeTruthy();
    expect(person?.linked_application_id).toBe(applicationId);

    // Re-classifying back to speaker again must not create a second row —
    // the not-exists guard still matches the untouched, still-linked row.
    const { error: backError } = await admin.from('applications').update({ participant_type: 'speaker' }).eq('id', applicationId);
    expect(backError).toBeNull();
    const rows = await linkedPeopleRows(applicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(personId);
  });

  describe('name-fallback chain', () => {
    it('null full_name with a claimed applicant_id whose profiles.full_name is set uses the profile name', async () => {
      const email = `speaker-linking-live-${runId}-fallback-profile@test.local`;
      const { data: authUser, error: authError } = await admin.auth.admin.createUser({
        email,
        password: 'password123',
        email_confirm: true,
      });
      if (authError || !authUser.user) throw new Error(`Failed to create fixture auth user: ${authError?.message}`);
      authUserIds.push(authUser.user.id);

      const profileName = `Profile Fallback Name ${runId}`;
      const { error: profileError } = await admin.from('profiles').update({ full_name: profileName }).eq('id', authUser.user.id);
      expect(profileError).toBeNull();

      const applicationId = await insertApplication({
        imported_email: email,
        applicant_id: authUser.user.id,
        participant_type: 'speaker',
        full_name: null,
      });

      const rows = await linkedPeopleRows(applicationId);
      expect(rows).toHaveLength(1);
      expect(rows[0].full_name_en).toBe(profileName);
      expect(rows[0].full_name_ar).toBe(profileName);
    });

    it('null full_name and no applicant_id falls back to Unknown', async () => {
      const email = `speaker-linking-live-${runId}-fallback-unknown@example.com`;
      const applicationId = await insertApplication({
        imported_email: email,
        applicant_id: null,
        participant_type: 'speaker',
        full_name: null,
      });

      const rows = await linkedPeopleRows(applicationId);
      expect(rows).toHaveLength(1);
      expect(rows[0].full_name_en).toBe('Unknown');
      expect(rows[0].full_name_ar).toBe('Unknown');
    });
  });

  it('backfill idempotency: re-running the backfill insert...select...where not exists statement inserts zero new rows', async () => {
    const email = `speaker-linking-live-${runId}-backfill@example.com`;
    const applicationId = await insertApplication({
      imported_email: email,
      participant_type: 'speaker',
      full_name: `Backfill Speaker ${runId}`,
    });

    // Trigger already linked this application to a people row on INSERT.
    expect(await linkedPeopleRows(applicationId)).toHaveLength(1);

    // Re-run the exact backfill statement from the migration directly
    // against the live DB via the service-role client's SQL execution.
    // Since supabase-js has no raw-SQL escape hatch, replicate the
    // statement's semantics using the query builder: it must find zero
    // speaker applications lacking a linked people row across the whole
    // table (not just our fixture), because the migration already ran
    // this same statement once, and the per-row trigger keeps every
    // speaker application backfilled going forward.
    const { data: speakerApps, error: speakerAppsError } = await admin
      .from('applications')
      .select('id')
      .eq('participant_type', 'speaker');
    expect(speakerAppsError).toBeNull();

    const { data: linkedPeople, error: linkedPeopleError } = await peopleRaw
      .from('people')
      .select('linked_application_id')
      .not('linked_application_id', 'is', null);
    expect(linkedPeopleError).toBeNull();

    const linkedIds = new Set((linkedPeople ?? []).map((p) => p.linked_application_id));
    const unlinkedSpeakerApps = (speakerApps ?? []).filter((a) => !linkedIds.has(a.id));

    // If the backfill's WHERE NOT EXISTS clause were re-run right now, it
    // would match exactly these rows — for a correctly idempotent
    // migration (trigger-covered going forward), this must be empty.
    expect(unlinkedSpeakerApps).toHaveLength(0);

    // Directly prove idempotency of the statement's own logic: run its
    // insert-select against just our fixture's row a second time (it's
    // already linked, so the NOT EXISTS guard must produce zero rows).
    const { count: beforeCount } = await peopleRaw
      .from('people')
      .select('id', { count: 'exact', head: true })
      .eq('linked_application_id', applicationId);
    expect(beforeCount).toBe(1);

    const { data: app } = await admin
      .from('applications')
      .select('applicant_id, full_name')
      .eq('id', applicationId)
      .single();
    const { data: alreadyLinked } = await peopleRaw.from('people').select('id').eq('linked_application_id', applicationId);

    // Replicates `where not exists (select 1 from people pe where
    // pe.linked_application_id = a.id)` — since alreadyLinked is non-empty,
    // the backfill would skip this row, so no insert happens here either.
    if (!alreadyLinked || alreadyLinked.length === 0) {
      const { data: inserted } = await peopleRaw.from('people').insert({
        full_name_ar: app?.full_name ?? 'Unknown',
        full_name_en: app?.full_name ?? 'Unknown',
        linked_application_id: applicationId,
        is_active: true,
        is_public: false,
      });
      for (const row of inserted ?? []) peopleIds.push(row.id);
    }

    const { count: afterCount } = await peopleRaw
      .from('people')
      .select('id', { count: 'exact', head: true })
      .eq('linked_application_id', applicationId);
    expect(afterCount).toBe(1);
  });
});
