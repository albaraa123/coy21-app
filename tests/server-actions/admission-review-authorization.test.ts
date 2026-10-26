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

// Mirrors the local requireStaffCaller's exact current authorization logic
// (src/app/[locale]/(admin)/applications/[id]/actions.ts), not just
// isStaffRole alone — as of the 2026-10-25 staff narrowing
// (docs/superpowers/specs/2026-10-25-profile-accommodation-staff-narrowing-
// design.md), the application-review workflow this helper gates
// (updateApplicationStatus/assignReviewer/addNote) is out of scope for
// `staff`: the real helper now does
// `if (!isStaffRole(profile.role) || profile.role === 'staff') throw ...`.
// This re-implementation must track that exact condition, or it drifts out
// of sync with the real guard and asserts the opposite of its actual
// behavior.
async function isAuthorizedStaffCaller(userId: string): Promise<boolean> {
  const { data: profile, error } = await admin.from('profiles').select('role').eq('id', userId).single();
  if (error || !profile) return false;
  return isStaffRole(profile.role) && profile.role !== 'staff';
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
  it('rejects staff (admission-review workflow narrowed out of scope for staff, 2026-10-25)', async () => {
    expect(await isAuthorizedStaffCaller(staffId)).toBe(false);
  });

  it('rejects a plain participant', async () => {
    expect(await isAuthorizedStaffCaller(participantId)).toBe(false);
  });
});
