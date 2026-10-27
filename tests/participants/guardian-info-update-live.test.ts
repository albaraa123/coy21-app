// tests/participants/guardian-info-update-live.test.ts
//
// Direct-call coverage for updateGuardianInfoForCaller, same style as
// participant-care-live.test.ts's updateHealthInfoForCaller tests: a
// manually constructed { userId, service } caller (no auth-gate
// involved -- see that file's own header comment for why
// requireParticipantCareStaffCaller itself can't be invoked from a
// test, and docs/superpowers/specs/2026-10-27-minor-guardian-info-
// design.md's Testing section for the same reasoning applied here).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { updateGuardianInfoForCaller } from '@/lib/participant-care/health-info-management';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
let staffUserId: string;
let applicantUserId: string;
let applicationId: string;
const auditLogIds: string[] = [];

beforeAll(async () => {
  const { data: staff, error: staffError } = await admin.auth.admin.createUser({
    email: `guardian-update-${runId}-staff@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (staffError || !staff.user) throw new Error(`staff fixture setup failed: ${staffError?.message}`);
  staffUserId = staff.user.id;
  await admin.from('profiles').update({ role: 'super_admin' }).eq('id', staffUserId);

  const { data: applicant, error: applicantError } = await admin.auth.admin.createUser({
    email: `guardian-update-${runId}-applicant@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (applicantError || !applicant.user) throw new Error(`applicant fixture setup failed: ${applicantError?.message}`);
  applicantUserId = applicant.user.id;

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: applicantUserId, status: 'accepted', age_group: 'under_18' })
    .select('id')
    .single();
  if (appError || !app) throw new Error(`application fixture setup failed: ${appError?.message}`);
  applicationId = app.id;
});

afterAll(async () => {
  if (auditLogIds.length > 0) await admin.from('audit_logs').delete().in('id', auditLogIds);
  if (applicationId) await admin.from('applications').delete().eq('id', applicationId);
  for (const id of [staffUserId, applicantUserId].filter(Boolean)) {
    await admin.auth.admin.deleteUser(id);
  }
});

describe('updateGuardianInfoForCaller', () => {
  it('writes guardian_name/guardian_phone onto the right application row', async () => {
    const result = await updateGuardianInfoForCaller(
      { userId: staffUserId, service: admin },
      applicationId,
      { guardian_name: 'Noura Al-Harthy', guardian_phone: '+96899887766' }
    );
    expect(result.guardian_name).toBe('Noura Al-Harthy');
    expect(result.guardian_phone).toBe('+96899887766');

    const { data: row } = await admin
      .from('applications')
      .select('guardian_name, guardian_phone')
      .eq('id', applicationId)
      .single();
    expect(row!.guardian_name).toBe('Noura Al-Harthy');
    expect(row!.guardian_phone).toBe('+96899887766');
  });

  it('writes an audit log entry for the update', async () => {
    const { data: before } = await admin
      .from('audit_logs')
      .select('id')
      .eq('entity_id', applicationId)
      .eq('action', 'guardian_info_updated');
    const beforeCount = before?.length ?? 0;

    await updateGuardianInfoForCaller(
      { userId: staffUserId, service: admin },
      applicationId,
      { guardian_name: 'Updated Name', guardian_phone: '+96899887766' }
    );

    const { data: after } = await admin
      .from('audit_logs')
      .select('id')
      .eq('entity_id', applicationId)
      .eq('action', 'guardian_info_updated');
    for (const row of after ?? []) auditLogIds.push(row.id);
    expect((after?.length ?? 0)).toBe(beforeCount + 1);
  });
});
