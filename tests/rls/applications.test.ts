import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const createClient = (url: string, key: string) => createSupabaseClient<Database>(url, key);

// NOTE: This suite runs against the live/hosted Supabase project, not a disposable
// local instance, because Docker is unavailable in this environment. It creates and
// deletes its own test users/rows to stay self-contained, but it is NOT isolated from
// production data. TODO: migrate to a dedicated Supabase test project before wiring
// this suite into CI as a gating check.

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);

let userAId: string;
let userBId: string;
let clientA: ReturnType<typeof createClient>;
let clientB: ReturnType<typeof createClient>;
let userCId: string; // registration_admission_manager
let userDId: string; // agenda_allocation_manager (should have NO applications access)
let clientC: ReturnType<typeof createClient>;
let clientD: ReturnType<typeof createClient>;

beforeAll(async () => {
  const { data: userA } = await admin.auth.admin.createUser({
    email: `applicant-a-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  const { data: userB } = await admin.auth.admin.createUser({
    email: `applicant-b-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  const { data: userC } = await admin.auth.admin.createUser({
    email: `admissions-manager-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  const { data: userD } = await admin.auth.admin.createUser({
    email: `agenda-manager-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  userAId = userA.user!.id;
  userBId = userB.user!.id;
  userCId = userC.user!.id;
  userDId = userD.user!.id;

  await admin.from('profiles').update({ role: 'registration_admission_manager' }).eq('id', userCId);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', userDId);

  clientA = createClient(URL, ANON_KEY);
  await clientA.auth.signInWithPassword({ email: `applicant-a-${runId}@test.local`, password: 'password123' });

  clientB = createClient(URL, ANON_KEY);
  await clientB.auth.signInWithPassword({ email: `applicant-b-${runId}@test.local`, password: 'password123' });

  clientC = createClient(URL, ANON_KEY);
  await clientC.auth.signInWithPassword({ email: `admissions-manager-${runId}@test.local`, password: 'password123' });

  clientD = createClient(URL, ANON_KEY);
  await clientD.auth.signInWithPassword({ email: `agenda-manager-${runId}@test.local`, password: 'password123' });
});

afterAll(async () => {
  // beforeAll may have thrown partway through user creation, leaving some of the
  // ids below undefined. Attempt to delete each independently so a missing id or a
  // failed delete for one user doesn't prevent cleanup of the others — otherwise
  // leaked users (hardcoded emails) would break the next run with duplicate-email
  // errors on createUser.
  const ids = [userAId, userBId, userCId, userDId];
  await Promise.allSettled(
    ids.map((id) => (id ? admin.auth.admin.deleteUser(id) : Promise.resolve()))
  );
});

describe('applications RLS', () => {
  it('applicant can insert their own draft application', async () => {
    const { error } = await clientA
      .from('applications')
      .insert({ applicant_id: userAId, status: 'draft' });
    expect(error).toBeNull();
  });

  it("applicant cannot read another applicant's application", async () => {
    const { data } = await clientB.from('applications').select('*').eq('applicant_id', userAId);
    expect(data).toEqual([]);
  });

  it('applicant cannot set status directly via client update', async () => {
    await clientA
      .from('applications')
      .update({ status: 'accepted' })
      .eq('applicant_id', userAId);
    const { data } = await clientA.from('applications').select('status').eq('applicant_id', userAId).single();
    expect(data?.status).toBe('draft');
  });

  it('applicant cannot insert a second application', async () => {
    const { error } = await clientA
      .from('applications')
      .insert({ applicant_id: userAId, status: 'draft' });
    expect(error).not.toBeNull();
  });

  it("registration_admission_manager can read all applications, including other applicants'", async () => {
    const { data, error } = await clientC.from('applications').select('*').eq('applicant_id', userAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('agenda_allocation_manager cannot read any applications (not an authorized staff role in Phase 1)', async () => {
    const { data } = await clientD.from('applications').select('*').eq('applicant_id', userAId);
    expect(data).toEqual([]);
  });

  // The real staff-facing application detail page/actions (src/app/[locale]/
  // (admin)/applications/[id]/{page,actions}.tsx) read and write
  // application_status_history exclusively through the trusted service_role
  // server boundary, never through the caller's own authenticated session
  // client — profiles RLS already forces service_role for the staff-view
  // joins on that page. Direct authenticated-role table access is therefore
  // intentionally not granted; a future developer should not "fix" this by
  // broadening the canonical grants migration.
  it('registration_admission_manager cannot read application_status_history directly as authenticated (real access goes through service_role)', async () => {
    const { error } = await clientC.from('application_status_history').select('*');
    expect(error).not.toBeNull();
  });

  it('agenda_allocation_manager cannot read application_status_history', async () => {
    const { data, error } = await clientD.from('application_status_history').select('*');
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});
