// tests/server-actions/admission-review-authorization.test.ts
//
// Verifies the role-check that gates updateApplicationStatus/assignReviewer/
// addNote (src/app/[locale]/(admin)/applications/[id]/actions.ts). These
// actions write via the service-role client and bypass RLS, so this check —
// not RLS — is the actual authorization gate; it needs its own direct test
// per the design spec's explicit testing requirement.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { isAdmissionStaffRole } from '@/lib/validation/admission-review';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);

// Delegates to the same isAdmissionStaffRole helper actions.ts's
// requireStaffCaller and page.tsx's page-level gate use, so this test
// exercises the real shared check rather than a re-implementation that could
// drift out of sync with it.
async function isAuthorizedStaffCaller(userId: string): Promise<boolean> {
  const { data: profile, error } = await admin.from('profiles').select('role').eq('id', userId).single();
  if (error || !profile) return false;
  return isAdmissionStaffRole(profile.role);
}

let participantId: string;
let staffId: string;
let wrongRoleId: string;

beforeAll(async () => {
  const { data: participant } = await admin.auth.admin.createUser({
    email: `authz-participant-${runId}@test.local`, password: 'password123', email_confirm: true,
  });
  const { data: staff } = await admin.auth.admin.createUser({
    email: `authz-staff-${runId}@test.local`, password: 'password123', email_confirm: true,
  });
  const { data: wrongRole } = await admin.auth.admin.createUser({
    email: `authz-wrongrole-${runId}@test.local`, password: 'password123', email_confirm: true,
  });
  participantId = participant.user!.id;
  staffId = staff.user!.id;
  wrongRoleId = wrongRole.user!.id;

  await admin.from('profiles').update({ role: 'registration_admission_manager' }).eq('id', staffId);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', wrongRoleId);
});

afterAll(async () => {
  await Promise.allSettled([
    participantId ? admin.auth.admin.deleteUser(participantId) : Promise.resolve(),
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
    wrongRoleId ? admin.auth.admin.deleteUser(wrongRoleId) : Promise.resolve(),
  ]);
});

describe('requireStaffCaller role check', () => {
  it('accepts registration_admission_manager', async () => {
    expect(await isAuthorizedStaffCaller(staffId)).toBe(true);
  });

  it('rejects a plain participant', async () => {
    expect(await isAuthorizedStaffCaller(participantId)).toBe(false);
  });

  it('rejects agenda_allocation_manager (a real staff role, but not an admission reviewer)', async () => {
    expect(await isAuthorizedStaffCaller(wrongRoleId)).toBe(false);
  });
});
