// tests/participants/general-info-update-live.test.ts
//
// Direct-call coverage for updateGeneralInfoForCaller, same style as
// tests/participants/guardian-info-update-live.test.ts: a manually
// constructed caller (no auth-gate involved -- requireAgendaStaffCaller
// can't be invoked outside a request context, same reasoning as every
// other *ForCaller test in this codebase).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import { updateGeneralInfoForCaller } from '@/app/[locale]/(admin)/participants/[applicationId]/actions';

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
    email: `general-info-${runId}-staff@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (staffError || !staff.user) throw new Error(`staff fixture setup failed: ${staffError?.message}`);
  staffUserId = staff.user.id;
  await admin.from('profiles').update({ role: 'super_admin' }).eq('id', staffUserId);

  const { data: applicant, error: applicantError } = await admin.auth.admin.createUser({
    email: `general-info-${runId}-applicant@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (applicantError || !applicant.user) throw new Error(`applicant fixture setup failed: ${applicantError?.message}`);
  applicantUserId = applicant.user.id;

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: applicantUserId, status: 'accepted', full_name: 'Original Name' })
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

describe('updateGeneralInfoForCaller', () => {
  it('writes a representative subset of plain-text and array fields, round-tripping correctly', async () => {
    const result = await updateGeneralInfoForCaller(
      applicationId,
      {
        full_name: 'Updated Name',
        country: 'Oman',
        organization: 'Test Org',
        interests: ['climate policy', 'youth engagement', 'renewable energy'],
        track_1_focus_areas: ['Policy and Governance'],
      },
      { userId: staffUserId, service: admin }
    );
    expect(result.full_name).toBe('Updated Name');
    expect(result.country).toBe('Oman');
    expect(result.organization).toBe('Test Org');
    expect(result.interests).toEqual(['climate policy', 'youth engagement', 'renewable energy']);
    expect(result.track_1_focus_areas).toEqual(['Policy and Governance']);

    const { data: row } = await admin
      .from('applications')
      .select('full_name, country, organization, interests, track_1_focus_areas')
      .eq('id', applicationId)
      .single();
    expect(row!.full_name).toBe('Updated Name');
    expect(row!.interests).toEqual(['climate policy', 'youth engagement', 'renewable energy']);
  });

  it('writes an audit log entry with action=general_info_updated and old/new values', async () => {
    const { data: before } = await admin
      .from('audit_logs')
      .select('id')
      .eq('entity_id', applicationId)
      .eq('action', 'general_info_updated');
    const beforeCount = before?.length ?? 0;

    await updateGeneralInfoForCaller(
      applicationId,
      { full_name: 'Second Update' },
      { userId: staffUserId, service: admin }
    );

    const { data: after } = await admin
      .from('audit_logs')
      .select('id, old_values, new_values')
      .eq('entity_id', applicationId)
      .eq('action', 'general_info_updated')
      .order('created_at', { ascending: true });
    for (const row of after ?? []) auditLogIds.push(row.id);
    expect((after?.length ?? 0)).toBe(beforeCount + 1);
    const latest = after![after!.length - 1];
    expect((latest.new_values as Record<string, unknown>).full_name).toBe('Second Update');
  });
});

describe('requireAgendaStaffCaller auth condition (logic replication)', () => {
  it('rejects plain staff', async () => {
    const { data: staffUser, error } = await admin.auth.admin.createUser({
      email: `general-info-auth-${runId}-plain-staff@test.local`,
      password: 'password123',
      email_confirm: true,
    });
    if (error || !staffUser.user) throw new Error(`plain-staff fixture setup failed: ${error?.message}`);
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffUser.user.id);
    const { data: profile } = await admin.from('profiles').select('role').eq('id', staffUser.user.id).single();

    const isAuthorized = isStaffRole(profile!.role) && profile!.role !== 'staff';
    expect(isAuthorized).toBe(false);

    await admin.auth.admin.deleteUser(staffUser.user.id);
  });

  it('accepts super_admin', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', staffUserId).single();
    const isAuthorized = isStaffRole(profile!.role) && profile!.role !== 'staff';
    expect(isAuthorized).toBe(true);
  });
});
