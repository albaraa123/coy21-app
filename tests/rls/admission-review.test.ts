// tests/rls/admission-review.test.ts
//
// Runs against the live/hosted Supabase project, not a disposable local instance,
// because Docker is unavailable in this environment (see tests/rls/applications.test.ts
// for the full rationale). It creates and deletes its own test users/rows to stay
// self-contained, but it is NOT isolated from production data. TODO: migrate to a
// dedicated Supabase test project before wiring this suite into CI as a gating check.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);

let applicantId: string;
let staffId: string;       // registration_admission_manager
let wrongRoleId: string;   // agenda_allocation_manager — should be denied
let applicationId: string;
let clientApplicant: ReturnType<typeof createClient<Database>>;
let clientStaff: ReturnType<typeof createClient<Database>>;
let clientWrongRole: ReturnType<typeof createClient<Database>>;

beforeAll(async () => {
  const { data: applicant } = await admin.auth.admin.createUser({
    email: `admission-review-${runId}-applicant@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  const { data: staff } = await admin.auth.admin.createUser({
    email: `admission-review-${runId}-staff@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  const { data: wrongRole } = await admin.auth.admin.createUser({
    email: `admission-review-${runId}-wrongrole@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  applicantId = applicant.user!.id;
  staffId = staff.user!.id;
  wrongRoleId = wrongRole.user!.id;

  await admin.from('profiles').update({ role: 'registration_admission_manager' }).eq('id', staffId);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', wrongRoleId);

  const { data: application } = await admin
    .from('applications')
    .insert({ applicant_id: applicantId, status: 'submitted' })
    .select('id')
    .single();
  applicationId = application!.id;

  clientApplicant = createClient<Database>(URL, ANON_KEY);
  await clientApplicant.auth.signInWithPassword({ email: `admission-review-${runId}-applicant@test.local`, password: 'password123' });

  clientStaff = createClient<Database>(URL, ANON_KEY);
  await clientStaff.auth.signInWithPassword({ email: `admission-review-${runId}-staff@test.local`, password: 'password123' });

  clientWrongRole = createClient<Database>(URL, ANON_KEY);
  await clientWrongRole.auth.signInWithPassword({ email: `admission-review-${runId}-wrongrole@test.local`, password: 'password123' });
});

afterAll(async () => {
  await Promise.allSettled([
    applicantId ? admin.auth.admin.deleteUser(applicantId) : Promise.resolve(),
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
    wrongRoleId ? admin.auth.admin.deleteUser(wrongRoleId) : Promise.resolve(),
  ]);
});

describe('applications RLS — staff update policy', () => {
  it('registration_admission_manager can update status on any application', async () => {
    const { error } = await clientStaff
      .from('applications')
      .update({ status: 'under_review' })
      .eq('id', applicationId);
    expect(error).toBeNull();
    const { data } = await clientStaff.from('applications').select('status').eq('id', applicationId).single();
    expect(data?.status).toBe('under_review');
  });

  it('agenda_allocation_manager (wrong staff role) cannot update status', async () => {
    // RLS silently affects zero rows rather than erroring; verify via re-query.
    await clientWrongRole
      .from('applications')
      .update({ status: 'accepted' })
      .eq('id', applicationId);
    const { data } = await clientWrongRole.from('applications').select('status').eq('id', applicationId).single();
    expect(data?.status).not.toBe('accepted');
  });

  it('applicant cannot update their own submitted application via this policy', async () => {
    await clientApplicant
      .from('applications')
      .update({ status: 'accepted' })
      .eq('id', applicationId);
    const { data } = await clientStaff.from('applications').select('status').eq('id', applicationId).single();
    expect(data?.status).not.toBe('accepted');
  });
});

describe('application_notes RLS', () => {
  // The real staff-facing application detail page/actions (src/app/[locale]/
  // (admin)/applications/[id]/{page,actions}.tsx) insert and read
  // application_notes exclusively through the trusted service_role server
  // boundary, never through the caller's own authenticated session client —
  // profiles RLS already forces service_role for the staff-view joins on
  // that page. Direct authenticated-role table access is therefore
  // intentionally not granted; a future developer should not "fix" this by
  // broadening the canonical grants migration.
  it('registration_admission_manager cannot insert or read notes directly as authenticated (real access goes through service_role)', async () => {
    const { error: insertError } = await clientStaff.from('application_notes').insert({
      application_id: applicationId,
      author_id: staffId,
      body: 'RLS test note',
    });
    expect(insertError).not.toBeNull();

    const { data, error } = await clientStaff.from('application_notes').select('*').eq('application_id', applicationId);
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it('agenda_allocation_manager cannot read notes', async () => {
    const { data, error } = await clientWrongRole.from('application_notes').select('*').eq('application_id', applicationId);
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it('applicant cannot read notes on their own application', async () => {
    const { data, error } = await clientApplicant.from('application_notes').select('*').eq('application_id', applicationId);
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});
