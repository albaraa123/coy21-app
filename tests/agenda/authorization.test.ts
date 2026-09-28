// tests/agenda/authorization.test.ts
//
// Verifies the role-check that gates every agenda server action
// (requireAgendaStaffCaller in src/lib/agenda/server-helpers.ts). Mirrors
// the logic-replication approach from Phase 2's admission-review
// authorization test — 'use server' functions can't be invoked outside a
// Next.js request context, so this exercises the same profiles.role lookup
// and rejection the real helper performs, against the live database with
// real authenticated users.
//
// This file constitutes Scenario 7 of the design spec's 8 required
// behavioral test scenarios; scenarios 1-6 and 8 live in the sibling
// tests/agenda/conflict-and-validation.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { isAgendaStaffRole } from '@/lib/validation/agenda';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);

async function isAuthorizedAgendaStaffCaller(userId: string): Promise<boolean> {
  const { data: profile, error } = await admin.from('profiles').select('role').eq('id', userId).single();
  if (error || !profile) return false;
  // Delegates to the same isAgendaStaffRole helper requireAgendaStaffCaller
  // (src/lib/agenda/server-helpers.ts) uses, so this test exercises the real
  // shared check rather than a re-implementation that could drift out of
  // sync with it — matching Phase 2's admission-review-authorization.test.ts
  // pattern.
  return isAgendaStaffRole(profile.role);
}

let participantId: string;
let agendaStaffId: string;
let wrongRoleId: string; // registration_admission_manager — real staff, wrong module

beforeAll(async () => {
  const { data: participant } = await admin.auth.admin.createUser({ email: `agenda-authz-participant-${runId}@test.local`, password: 'password123', email_confirm: true });
  const { data: staff } = await admin.auth.admin.createUser({ email: `agenda-authz-staff-${runId}@test.local`, password: 'password123', email_confirm: true });
  const { data: wrongRole } = await admin.auth.admin.createUser({ email: `agenda-authz-wrongrole-${runId}@test.local`, password: 'password123', email_confirm: true });
  participantId = participant.user!.id;
  agendaStaffId = staff.user!.id;
  wrongRoleId = wrongRole.user!.id;

  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', agendaStaffId);
  await admin.from('profiles').update({ role: 'registration_admission_manager' }).eq('id', wrongRoleId);
});

afterAll(async () => {
  await Promise.allSettled([
    participantId ? admin.auth.admin.deleteUser(participantId) : Promise.resolve(),
    agendaStaffId ? admin.auth.admin.deleteUser(agendaStaffId) : Promise.resolve(),
    wrongRoleId ? admin.auth.admin.deleteUser(wrongRoleId) : Promise.resolve(),
  ]);
});

describe('requireAgendaStaffCaller role check', () => {
  it('accepts agenda_allocation_manager', async () => {
    expect(await isAuthorizedAgendaStaffCaller(agendaStaffId)).toBe(true);
  });
  it('rejects a plain participant', async () => {
    expect(await isAuthorizedAgendaStaffCaller(participantId)).toBe(false);
  });
  it('rejects registration_admission_manager (real staff, wrong module)', async () => {
    expect(await isAuthorizedAgendaStaffCaller(wrongRoleId)).toBe(false);
  });
});
