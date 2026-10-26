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
import { isStaffRole } from '@/lib/auth/is-staff-role';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);

async function isAuthorizedAgendaStaffCaller(userId: string): Promise<boolean> {
  const { data: profile, error } = await admin.from('profiles').select('role').eq('id', userId).single();
  if (error || !profile) return false;
  // Mirrors requireAgendaStaffCaller's exact current authorization logic
  // (src/lib/agenda/server-helpers.ts), not just isStaffRole alone — as of
  // the 2026-10-25 staff narrowing (docs/superpowers/specs/2026-10-25-
  // profile-accommodation-staff-narrowing-design.md), agenda management is
  // out of scope for `staff`: the real helper now does
  // `if (!isStaffRole(profile.role) || profile.role === 'staff') throw ...`.
  // This re-implementation must track that exact condition, or it silently
  // drifts out of sync with the real guard and asserts the opposite of
  // its actual behavior (which is exactly what happened here before this
  // fix — this test asserted staff was accepted after the real helper had
  // already started rejecting it).
  return isStaffRole(profile.role) && profile.role !== 'staff';
}

let participantId: string;
let agendaStaffId: string;

beforeAll(async () => {
  const { data: participant } = await admin.auth.admin.createUser({ email: `agenda-authz-participant-${runId}@test.local`, password: 'password123', email_confirm: true });
  const { data: staff } = await admin.auth.admin.createUser({ email: `agenda-authz-staff-${runId}@test.local`, password: 'password123', email_confirm: true });
  participantId = participant.user!.id;
  agendaStaffId = staff.user!.id;

  await admin.from('profiles').update({ role: 'staff' }).eq('id', agendaStaffId);
});

afterAll(async () => {
  await Promise.allSettled([
    participantId ? admin.auth.admin.deleteUser(participantId) : Promise.resolve(),
    agendaStaffId ? admin.auth.admin.deleteUser(agendaStaffId) : Promise.resolve(),
  ]);
});

describe('requireAgendaStaffCaller role check', () => {
  it('rejects staff (agenda management narrowed out of scope for staff, 2026-10-25)', async () => {
    expect(await isAuthorizedAgendaStaffCaller(agendaStaffId)).toBe(false);
  });
  it('rejects a plain participant', async () => {
    expect(await isAuthorizedAgendaStaffCaller(participantId)).toBe(false);
  });
});
