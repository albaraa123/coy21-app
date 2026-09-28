// tests/participants/participant-care-live.test.ts
//
// Live coverage for the Phase 8.2 Participant Care Staff Screen's backend:
// src/lib/participant-care/health-info-management.ts's *ForCaller functions,
// plus a direct proof of the GRANT-layer gap documented in that module's own
// comments — the `authenticated` Postgres role has SELECT but no UPDATE
// grant on application_health_info (see
// supabase/migrations/20260816100000_correct_application_sensitive_tables_update_grant.sql
// and 20260816130000_correct_travel_and_health_info_authenticated_select_grant.sql),
// so a plain session client cannot update this table even when RLS would
// allow it — only the service-role-gated updateHealthInfoForCaller path can.
//
// This file does NOT re-verify application_health_info's RLS role matrix
// (SELECT allow/deny per role) — that's already exhaustively covered by
// tests/import/sensitive-data-rls.test.ts. Here we only prove: (a) the new
// search/fetch/update functions behave correctly for an authorized caller,
// (b) application_travel_info is never touched by this module, (c) the
// GRANT-layer boundary that makes the service-role client mandatory for
// writes.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import {
  searchParticipantsForCareForCaller,
  fetchHealthInfoForCaller,
  updateHealthInfoForCaller,
} from '@/lib/participant-care/health-info-management';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const PASSWORD = 'password123';

vi.setConfig({ testTimeout: 30000 });

let careStaffId: string;
let applicantUserId: string;
let applicationId: string;
let applicationNumber: string;
const auditLogIds: string[] = [];

const careStaffCaller = () => ({ userId: careStaffId, service: admin });

beforeAll(async () => {
  const { data: careStaff } = await admin.auth.admin.createUser({
    email: `participant-care-live-${runId}-staff@test.local`,
    password: PASSWORD,
    email_confirm: true,
  });
  careStaffId = careStaff!.user!.id;
  await admin.from('profiles').update({ role: 'participant_care_staff' }).eq('id', careStaffId);

  applicationNumber = `PCARE-LIVE-${runId}`;
  const { data: applicant } = await admin.auth.admin.createUser({
    email: `participant-care-live-${runId}-applicant@test.local`,
    password: PASSWORD,
    email_confirm: true,
  });
  applicantUserId = applicant!.user!.id;

  const { data: app } = await admin
    .from('applications')
    .insert({
      applicant_id: applicantUserId,
      status: 'accepted',
      application_number: applicationNumber,
      full_name: 'Care Fixture Participant',
    })
    .select('id')
    .single();
  applicationId = app!.id;
});

afterAll(async () => {
  if (auditLogIds.length > 0) {
    await admin.from('audit_logs').delete().in('id', auditLogIds);
  }
  await admin.from('audit_logs').delete().eq('actor_id', careStaffId);
  await admin.from('application_health_info').delete().eq('application_id', applicationId);
  await admin.from('applications').delete().eq('id', applicationId);
  await Promise.allSettled([admin.auth.admin.deleteUser(applicantUserId), admin.auth.admin.deleteUser(careStaffId)]);
});

describe('health-info-management — live coverage', () => {
  describe('searchParticipantsForCareForCaller', () => {
    it('finds the participant by exact application_number', async () => {
      const results = await searchParticipantsForCareForCaller(careStaffCaller(), applicationNumber);
      expect(results.map((r) => r.id)).toContain(applicationId);
    });

    it('finds the participant by a substring of full_name', async () => {
      const results = await searchParticipantsForCareForCaller(careStaffCaller(), 'Care Fixture Participant');
      const match = results.find((r) => r.id === applicationId);
      expect(match).toBeTruthy();
      expect(match!.status).toBe('accepted');
    });

    it('returns an empty array for a blank term without querying the database', async () => {
      expect(await searchParticipantsForCareForCaller(careStaffCaller(), '')).toEqual([]);
    });
  });

  describe('fetchHealthInfoForCaller', () => {
    it('returns null for an application with no health-info row yet', async () => {
      const info = await fetchHealthInfoForCaller(careStaffCaller(), applicationId);
      expect(info).toBeNull();
    });
  });

  describe('updateHealthInfoForCaller', () => {
    it('creates a new row on first save (no prior application_health_info row) and writes one audit_logs entry', async () => {
      const saved = await updateHealthInfoForCaller(careStaffCaller(), applicationId, {
        allergies: 'Peanuts',
        medical_conditions: null,
        emergency_medication: null,
        accessibility_requirements: 'Wheelchair access',
        dietary_requirements: 'Vegetarian',
        accommodation_preference: null,
        cultural_or_religious_requirements: null,
        emergency_contact_name: 'Jane Doe',
        emergency_contact_phone: '+966500000000',
        emergency_contact_relationship: 'Sister',
        consent_given: true,
      });
      expect(saved.application_id).toBe(applicationId);
      expect(saved.allergies).toBe('Peanuts');
      expect(saved.accessibility_requirements).toBe('Wheelchair access');
      expect(saved.consent_given).toBe(true);

      const { data: logs } = await admin
        .from('audit_logs')
        .select('id, action, old_values, new_values')
        .eq('entity_type', 'application_health_info')
        .eq('entity_id', applicationId);
      expect(logs).toHaveLength(1);
      expect(logs![0].action).toBe('participant_care_update');
      expect(logs![0].old_values).toBeNull();
      auditLogIds.push(logs![0].id);
    });

    it('updates the existing row in place (no duplicate row) and records old_values on the second edit', async () => {
      const updated = await updateHealthInfoForCaller(careStaffCaller(), applicationId, {
        allergies: 'Peanuts, shellfish',
        medical_conditions: null,
        emergency_medication: null,
        accessibility_requirements: 'Wheelchair access',
        dietary_requirements: 'Vegetarian',
        accommodation_preference: null,
        cultural_or_religious_requirements: null,
        emergency_contact_name: 'Jane Doe',
        emergency_contact_phone: '+966500000000',
        emergency_contact_relationship: 'Sister',
        consent_given: true,
      });
      expect(updated.allergies).toBe('Peanuts, shellfish');

      const { data: rows } = await admin.from('application_health_info').select('application_id').eq('application_id', applicationId);
      expect(rows).toHaveLength(1);

      const { data: logs } = await admin
        .from('audit_logs')
        .select('id, old_values, new_values')
        .eq('entity_type', 'application_health_info')
        .eq('entity_id', applicationId)
        .eq('action', 'participant_care_update')
        .order('created_at', { ascending: false })
        .limit(1);
      expect((logs![0].old_values as { allergies: string }).allergies).toBe('Peanuts');
      expect((logs![0].new_values as { allergies: string }).allergies).toBe('Peanuts, shellfish');
      auditLogIds.push(logs![0].id);
    });

    it('never writes to application_travel_info for this application', async () => {
      const { data: travelRows } = await admin.from('application_travel_info').select('application_id').eq('application_id', applicationId);
      expect(travelRows ?? []).toEqual([]);
    });
  });

  describe('GRANT-layer boundary: authenticated session client cannot UPDATE application_health_info directly', () => {
    it('a real participant_care_staff session is denied at the Postgres GRANT layer, not just RLS', async () => {
      const client = createClient<Database>(URL, ANON_KEY);
      const { error: signInError } = await client.auth.signInWithPassword({
        email: `participant-care-live-${runId}-staff@test.local`,
        password: PASSWORD,
      });
      expect(signInError).toBeNull();

      const { error } = await client.from('application_health_info').update({ allergies: 'should not persist' }).eq('application_id', applicationId);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/permission denied/i);

      const { data: unchanged } = await admin.from('application_health_info').select('allergies').eq('application_id', applicationId).single();
      expect(unchanged!.allergies).toBe('Peanuts, shellfish');
    });
  });
});
