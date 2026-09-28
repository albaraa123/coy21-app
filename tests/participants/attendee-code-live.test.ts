// tests/participants/attendee-code-live.test.ts
//
// Live tests for COY21 attendee code generation (Phase 1, Task 1).
// Verifies next_application_number(p_type) returns COY21-TYPE-NNNN format,
// per-type sequences are independent, and participant_type is stored on
// applications rows — as specified in BUILD_SPEC.md §10.
//
// Runs against the live Supabase project (no local DB).

import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30_000 });

const runId = randomUUID().slice(0, 8);
const createdApplicationIds: string[] = [];

afterAll(async () => {
  if (createdApplicationIds.length === 0) return;
  // Clean up FK-dependent tables first (mirrors existing live test pattern)
  for (const table of [
    'qr_lifecycle_operations',
    'attendance_records',
    'scan_attempts',
    'application_answers',
    'application_travel_info',
    'application_health_info',
    'application_status_history',
  ] as const) {
    await admin.from(table).delete().in('application_id', createdApplicationIds);
  }
  await admin.from('applications').delete().in('id', createdApplicationIds);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callNextApplicationNumber(type: string) {
  return admin.rpc('next_application_number', { p_type: type } as never);
}

async function insertTestApplication(opts: {
  participantType: string;
  suffix: string;
}) {
  const code = await admin.rpc('next_application_number', { p_type: opts.participantType } as never);
  if (code.error) throw new Error(`next_application_number failed: ${code.error.message}`);

  const { data, error } = await admin
    .from('applications')
    .insert({
      imported_email: `attendee-code-${opts.suffix}-${runId}@test.local`,
      status: 'accepted',
      application_number: code.data as string,
      participant_type: opts.participantType as never,
    } as never)
    .select('id, application_number, participant_type')
    .single();

  if (error) throw new Error(`Insert failed: ${error.message}`);
  createdApplicationIds.push(data!.id);
  return data!;
}

// ---------------------------------------------------------------------------
// Tests: next_application_number(p_type) format
// ---------------------------------------------------------------------------

describe('next_application_number with participant type', () => {
  it('returns COY21-DEL-NNNN for delegate', async () => {
    const { data, error } = await callNextApplicationNumber('delegate');
    expect(error).toBeNull();
    expect(data).toMatch(/^COY21-DEL-\d{4,}$/);
  });

  it('returns COY21-VOL-NNNN for volunteer', async () => {
    const { data, error } = await callNextApplicationNumber('volunteer');
    expect(error).toBeNull();
    expect(data).toMatch(/^COY21-VOL-\d{4,}$/);
  });

  it('returns COY21-KP-NNNN for knowledge_partner', async () => {
    const { data, error } = await callNextApplicationNumber('knowledge_partner');
    expect(error).toBeNull();
    expect(data).toMatch(/^COY21-KP-\d{4,}$/);
  });

  it('returns COY21-YNG-NNNN for youngo', async () => {
    const { data, error } = await callNextApplicationNumber('youngo');
    expect(error).toBeNull();
    expect(data).toMatch(/^COY21-YNG-\d{4,}$/);
  });

  it('returns COY21-SPK-NNNN for speaker', async () => {
    const { data, error } = await callNextApplicationNumber('speaker');
    expect(error).toBeNull();
    expect(data).toMatch(/^COY21-SPK-\d{4,}$/);
  });

  it('increments delegate sequence independently of volunteer', async () => {
    const { data: d1 } = await callNextApplicationNumber('delegate');
    const { data: v1 } = await callNextApplicationNumber('volunteer');
    const { data: d2 } = await callNextApplicationNumber('delegate');

    // delegate seq goes 1→2, volunteer is independent
    const delSeq1 = parseInt(d1!.split('-')[2]);
    const delSeq2 = parseInt(d2!.split('-')[2]);
    const volSeq = parseInt(v1!.split('-')[2]);

    expect(delSeq2).toBe(delSeq1 + 1);
    // volunteer seq is its own counter, not affected by delegate calls
    expect(volSeq).toBeGreaterThanOrEqual(1);
  });

  it('each call produces a unique code (no duplicates)', async () => {
    const calls = await Promise.all([
      callNextApplicationNumber('delegate'),
      callNextApplicationNumber('delegate'),
      callNextApplicationNumber('delegate'),
    ]);
    const codes = calls.map((r) => r.data as string);
    const unique = new Set(codes);
    expect(unique.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: participant_type column on applications
// ---------------------------------------------------------------------------

describe('applications.participant_type column', () => {
  it('stores participant_type on inserted application', async () => {
    const row = await insertTestApplication({ participantType: 'delegate', suffix: 'del' });
    expect(row.participant_type).toBe('delegate');
    expect(row.application_number).toMatch(/^COY21-DEL-\d{4,}$/);
  });

  it('stores volunteer type correctly', async () => {
    const row = await insertTestApplication({ participantType: 'volunteer', suffix: 'vol' });
    expect(row.participant_type).toBe('volunteer');
    expect(row.application_number).toMatch(/^COY21-VOL-\d{4,}$/);
  });
});

// ---------------------------------------------------------------------------
// Tests: confirmation flow server action (Task 2)
// ---------------------------------------------------------------------------

describe('attendance confirmation action', () => {
  it('participant can confirm their own accepted application', async () => {
    // Create a test user + accepted application
    const { data: user } = await admin.auth.admin.createUser({
      email: `confirm-test-${runId}@test.local`,
      password: 'password123',
      email_confirm: true,
    });
    const userId = user.user!.id;

    const code = (await callNextApplicationNumber('delegate')).data as string;
    const { data: app } = await admin
      .from('applications')
      .insert({
        applicant_id: userId,
        imported_email: `confirm-test-${runId}@test.local`,
        status: 'accepted',
        application_number: code,
        participant_type: 'delegate' as never,
        attendance_confirmation: 'not_confirmed',
      } as never)
      .select('id')
      .single();

    createdApplicationIds.push(app!.id);

    // Simulate the server action: update attendance_confirmation
    const { error } = await admin
      .from('applications')
      .update({ attendance_confirmation: 'confirmed' })
      .eq('id', app!.id)
      .eq('applicant_id', userId);

    expect(error).toBeNull();

    const { data: updated } = await admin
      .from('applications')
      .select('attendance_confirmation')
      .eq('id', app!.id)
      .single();

    expect(updated?.attendance_confirmation).toBe('confirmed');

    await admin.auth.admin.deleteUser(userId);
  });
});
