// tests/participants/travel-ops-live.test.ts
//
// Live coverage for the Phase 8.6 Travel Operations screen's backend:
// src/lib/travel-ops/travel-info-management.ts's *ForCaller functions,
// plus a direct proof of the same GRANT-layer gap already documented and
// tested for application_health_info in Phase 8.2
// (tests/participants/participant-care-live.test.ts) — the `authenticated`
// Postgres role has SELECT but no UPDATE grant on application_travel_info
// (see supabase/migrations/20260816100000_correct_application_sensitive_
// tables_update_grant.sql and 20260816130000_correct_travel_and_health_
// info_authenticated_select_grant.sql), so a plain session client cannot
// update this table even when RLS would allow it — only the
// service-role-gated updateTravelInfoForCaller path can.
//
// This file does NOT re-verify application_travel_info's RLS role matrix
// — that's already exhaustively covered by tests/import/sensitive-data-
// rls.test.ts. Here we only prove: (a) the new search/fetch/update
// functions behave correctly for an authorized caller, (b)
// application_health_info is never touched by this module, (c) the
// GRANT-layer boundary that makes the service-role client mandatory for
// writes, (d) passport_copy_url/passport_photo_url are never written by
// updateTravelInfoForCaller (out-of-scope Drive-link editing).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import {
  searchParticipantsForTravelForCaller,
  fetchTravelInfoForCaller,
  updateTravelInfoForCaller,
} from '@/lib/travel-ops/travel-info-management';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const PASSWORD = 'password123';

vi.setConfig({ testTimeout: 30000 });

let travelStaffId: string;
let applicantUserId: string;
let applicationId: string;
let applicationNumber: string;
const auditLogIds: string[] = [];

const travelStaffCaller = () => ({ userId: travelStaffId, service: admin });

beforeAll(async () => {
  const { data: travelStaff } = await admin.auth.admin.createUser({
    email: `travel-ops-live-${runId}-staff@test.local`,
    password: PASSWORD,
    email_confirm: true,
  });
  travelStaffId = travelStaff!.user!.id;
  await admin.from('profiles').update({ role: 'travel_operations_staff' }).eq('id', travelStaffId);

  applicationNumber = `TRAVEL-LIVE-${runId}`;
  const { data: applicant } = await admin.auth.admin.createUser({
    email: `travel-ops-live-${runId}-applicant@test.local`,
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
      full_name: 'Travel Fixture Participant',
    })
    .select('id')
    .single();
  applicationId = app!.id;
});

afterAll(async () => {
  if (auditLogIds.length > 0) {
    await admin.from('audit_logs').delete().in('id', auditLogIds);
  }
  await admin.from('audit_logs').delete().eq('actor_id', travelStaffId);
  await admin.from('application_travel_info').delete().eq('application_id', applicationId);
  await admin.from('applications').delete().eq('id', applicationId);
  await Promise.allSettled([admin.auth.admin.deleteUser(applicantUserId), admin.auth.admin.deleteUser(travelStaffId)]);
});

describe('travel-info-management — live coverage', () => {
  describe('searchParticipantsForTravelForCaller', () => {
    it('finds the participant by exact application_number', async () => {
      const results = await searchParticipantsForTravelForCaller(travelStaffCaller(), applicationNumber);
      expect(results.map((r) => r.id)).toContain(applicationId);
    });

    it('finds the participant by a substring of full_name', async () => {
      const results = await searchParticipantsForTravelForCaller(travelStaffCaller(), 'Travel Fixture Participant');
      const match = results.find((r) => r.id === applicationId);
      expect(match).toBeTruthy();
      expect(match!.status).toBe('accepted');
    });

    it('returns an empty array for a blank term without querying the database', async () => {
      expect(await searchParticipantsForTravelForCaller(travelStaffCaller(), '')).toEqual([]);
    });
  });

  describe('fetchTravelInfoForCaller', () => {
    it('returns null for an application with no travel-info row yet', async () => {
      const info = await fetchTravelInfoForCaller(travelStaffCaller(), applicationId);
      expect(info).toBeNull();
    });
  });

  describe('updateTravelInfoForCaller', () => {
    it('creates a new row on first save (no prior application_travel_info row) and writes one audit_logs entry', async () => {
      const saved = await updateTravelInfoForCaller(travelStaffCaller(), applicationId, {
        support_level_requested: 'Full support',
        can_attend_without_full_support: false,
        departure_airport: 'MCT',
        visa_required: true,
        invitation_letter_required: true,
        passport_full_name: 'John Doe',
        passport_full_name_ar: 'جون دو',
        passport_issue_date: '2020-01-01',
        passport_expiry_date: '2030-01-01',
        passport_place_of_issue: 'Muscat',
        passport_birth_date: '1990-01-01',
      });
      expect(saved.application_id).toBe(applicationId);
      expect(saved.support_level_requested).toBe('Full support');
      expect(saved.departure_airport).toBe('MCT');
      expect(saved.visa_required).toBe(true);
      // Not writable by this function — must remain untouched (null, since
      // no import ever populated them for this fixture application).
      expect(saved.passport_copy_url).toBeNull();
      expect(saved.passport_photo_url).toBeNull();

      const { data: logs } = await admin
        .from('audit_logs')
        .select('id, action, old_values, new_values')
        .eq('entity_type', 'application_travel_info')
        .eq('entity_id', applicationId);
      expect(logs).toHaveLength(1);
      expect(logs![0].action).toBe('travel_ops_update');
      expect(logs![0].old_values).toBeNull();
      auditLogIds.push(logs![0].id);
    });

    it('updates the existing row in place (no duplicate row) and records old_values on the second edit', async () => {
      const updated = await updateTravelInfoForCaller(travelStaffCaller(), applicationId, {
        support_level_requested: 'Partial support',
        can_attend_without_full_support: true,
        departure_airport: 'DXB',
        visa_required: true,
        invitation_letter_required: true,
        passport_full_name: 'John Doe',
        passport_full_name_ar: 'جون دو',
        passport_issue_date: '2020-01-01',
        passport_expiry_date: '2030-01-01',
        passport_place_of_issue: 'Muscat',
        passport_birth_date: '1990-01-01',
      });
      expect(updated.departure_airport).toBe('DXB');

      const { data: rows } = await admin.from('application_travel_info').select('application_id').eq('application_id', applicationId);
      expect(rows).toHaveLength(1);

      const { data: logs } = await admin
        .from('audit_logs')
        .select('id, old_values, new_values')
        .eq('entity_type', 'application_travel_info')
        .eq('entity_id', applicationId)
        .eq('action', 'travel_ops_update')
        .order('created_at', { ascending: false })
        .limit(1);
      expect((logs![0].old_values as { departure_airport: string }).departure_airport).toBe('MCT');
      expect((logs![0].new_values as { departure_airport: string }).departure_airport).toBe('DXB');
      auditLogIds.push(logs![0].id);
    });

    it('never writes to application_health_info for this application', async () => {
      const { data: healthRows } = await admin.from('application_health_info').select('application_id').eq('application_id', applicationId);
      expect(healthRows ?? []).toEqual([]);
    });
  });

  describe('GRANT-layer boundary: authenticated session client cannot UPDATE application_travel_info directly', () => {
    it('a real travel_operations_staff session is denied at the Postgres GRANT layer, not just RLS', async () => {
      const client = createClient<Database>(URL, ANON_KEY);
      const { error: signInError } = await client.auth.signInWithPassword({
        email: `travel-ops-live-${runId}-staff@test.local`,
        password: PASSWORD,
      });
      expect(signInError).toBeNull();

      const { error } = await client.from('application_travel_info').update({ departure_airport: 'should not persist' }).eq('application_id', applicationId);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/permission denied/i);

      const { data: unchanged } = await admin.from('application_travel_info').select('departure_airport').eq('application_id', applicationId).single();
      expect(unchanged!.departure_airport).toBe('DXB');
    });
  });
});
