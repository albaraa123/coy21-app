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
import { isStaffRole } from '@/lib/auth/is-staff-role';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);

// Delegates to the same isStaffRole helper actions.ts's requireStaffCaller
// and page.tsx's page-level gate use, so this test exercises the real
// shared check rather than a re-implementation that could drift out of
// sync with it. Post-consolidation, every former staff-domain role
// (admission, agenda, travel ops, etc.) has been migrated to the single
// 'staff' role, so there is no longer a "real staff, wrong module"
// rejection case to prove here — any migrated staff account is accepted.
async function isAuthorizedStaffCaller(userId: string): Promise<boolean> {
  const { data: profile, error } = await admin.from('profiles').select('role').eq('id', userId).single();
  if (error || !profile) return false;
  return isStaffRole(profile.role);
}

let participantId: string;
let staffId: string;

beforeAll(async () => {
  const { data: participant } = await admin.auth.admin.createUser({
    email: `authz-participant-${runId}@test.local`, password: 'password123', email_confirm: true,
  });
  const { data: staff } = await admin.auth.admin.createUser({
    email: `authz-staff-${runId}@test.local`, password: 'password123', email_confirm: true,
  });
  participantId = participant.user!.id;
  staffId = staff.user!.id;

  await admin.from('profiles').update({ role: 'staff' }).eq('id', staffId);
});

afterAll(async () => {
  await Promise.allSettled([
    participantId ? admin.auth.admin.deleteUser(participantId) : Promise.resolve(),
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
  ]);
});

describe('requireStaffCaller role check', () => {
  it('accepts staff', async () => {
    expect(await isAuthorizedStaffCaller(staffId)).toBe(true);
  });

  it('rejects a plain participant', async () => {
    expect(await isAuthorizedStaffCaller(participantId)).toBe(false);
  });
});
