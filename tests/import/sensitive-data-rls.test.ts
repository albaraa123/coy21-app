// tests/import/sensitive-data-rls.test.ts
//
// Phase A of the controlled-account-provisioning design
// (docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md,
// section 3.3a). Proves every allowed and denied role combination against
// application_travel_info / application_health_info's real RLS policies,
// using a real signed-in anon-key session per role — mirrors
// tests/allocation/authorization.test.ts's established pattern (RLS returns
// an empty set rather than an error for a denied SELECT; the meaningful
// assertion is that no rows leak, not that the call errors).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const PASSWORD = 'password123';

type RoleFixture = { email: string; role: Database['public']['Enums']['user_role']; id?: string };

const roles: Record<string, RoleFixture> = {
  superAdmin: { email: 'sensitive-rls-super-admin@test.local', role: 'super_admin' },
  travelOps: { email: 'sensitive-rls-travel-ops@test.local', role: 'travel_operations_staff' },
  participantCare: { email: 'sensitive-rls-participant-care@test.local', role: 'participant_care_staff' },
  admission: { email: 'sensitive-rls-admission@test.local', role: 'registration_admission_manager' },
  agenda: { email: 'sensitive-rls-agenda@test.local', role: 'agenda_allocation_manager' },
  comms: { email: 'sensitive-rls-comms@test.local', role: 'communications_attendance_manager' },
  participant: { email: 'sensitive-rls-participant@test.local', role: 'participant' },
};

let ownedApplicationId: string;

beforeAll(async () => {
  for (const key of Object.keys(roles)) {
    const fixture = roles[key];
    const { data, error } = await admin.auth.admin.createUser({
      email: fixture.email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`Failed to create test user ${fixture.email}: ${error?.message}`);
    fixture.id = data.user.id;
    const { error: roleError } = await admin.from('profiles').update({ role: fixture.role }).eq('id', fixture.id);
    if (roleError) throw new Error(`Failed to set role for ${fixture.email}: ${roleError.message}`);
  }

  // The participant fixture owns one application, with one travel row and
  // one health row, so the "select own" policies have something real to
  // return (as opposed to only proving "returns nothing" everywhere, which
  // would also be true of a policy that denied everyone).
  const { data: application, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: roles.participant.id!, status: 'accepted' })
    .select('id')
    .single();
  if (appError || !application) throw new Error(`Failed to create owned application: ${appError?.message}`);
  ownedApplicationId = application.id;

  const { error: travelError } = await admin
    .from('application_travel_info')
    .insert({ application_id: ownedApplicationId, departure_airport: 'RUH' });
  if (travelError) throw new Error(`Failed to seed application_travel_info: ${travelError.message}`);

  const { error: healthError } = await admin
    .from('application_health_info')
    .insert({ application_id: ownedApplicationId, allergies: 'none' });
  if (healthError) throw new Error(`Failed to seed application_health_info: ${healthError.message}`);
});

afterAll(async () => {
  if (ownedApplicationId) {
    await admin.from('applications').delete().eq('id', ownedApplicationId);
  }
  await Promise.allSettled(
    Object.values(roles).map((fixture) => (fixture.id ? admin.auth.admin.deleteUser(fixture.id) : Promise.resolve()))
  );
});

async function sessionFor(fixture: RoleFixture) {
  const client = createClient<Database>(URL, ANON_KEY);
  const { error } = await client.auth.signInWithPassword({ email: fixture.email, password: PASSWORD });
  if (error) throw new Error(`Failed to sign in as ${fixture.email}: ${error.message}`);
  return client;
}

describe('application_travel_info RLS', () => {
  it('allows super_admin to read', async () => {
    const client = await sessionFor(roles.superAdmin);
    const { data, error } = await client.from('application_travel_info').select('application_id');
    expect(error).toBeNull();
    expect(data).not.toHaveLength(0);
  });

  it('allows travel_operations_staff to read', async () => {
    const client = await sessionFor(roles.travelOps);
    const { data, error } = await client.from('application_travel_info').select('application_id');
    expect(error).toBeNull();
    expect(data).not.toHaveLength(0);
  });

  it('denies participant_care_staff (wrong sensitive area)', async () => {
    const client = await sessionFor(roles.participantCare);
    const { data } = await client.from('application_travel_info').select('application_id');
    expect(data ?? []).toHaveLength(0);
  });

  it('denies registration_admission_manager (general applications access does not imply travel access)', async () => {
    const client = await sessionFor(roles.admission);
    const { data } = await client.from('application_travel_info').select('application_id');
    expect(data ?? []).toHaveLength(0);
  });

  it('denies agenda_allocation_manager', async () => {
    const client = await sessionFor(roles.agenda);
    const { data } = await client.from('application_travel_info').select('application_id');
    expect(data ?? []).toHaveLength(0);
  });

  it('denies communications_attendance_manager (no future access without explicit approval)', async () => {
    const client = await sessionFor(roles.comms);
    const { data } = await client.from('application_travel_info').select('application_id');
    expect(data ?? []).toHaveLength(0);
  });

  it('allows a participant to read their own row only', async () => {
    const client = await sessionFor(roles.participant);
    const { data, error } = await client.from('application_travel_info').select('application_id');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].application_id).toBe(ownedApplicationId);
  });

  it('denies a participant from updating their own row (no self-service write in Phase A)', async () => {
    const client = await sessionFor(roles.participant);
    const { data } = await client
      .from('application_travel_info')
      .update({ departure_airport: 'JED' })
      .eq('application_id', ownedApplicationId)
      .select();
    // No update policy exists for participants, so RLS blocks the write —
    // either surfaced as an error or (PostgREST's default) zero affected rows.
    expect(data ?? []).toHaveLength(0);
  });
});

describe('application_health_info RLS', () => {
  it('allows super_admin to read', async () => {
    const client = await sessionFor(roles.superAdmin);
    const { data, error } = await client.from('application_health_info').select('application_id');
    expect(error).toBeNull();
    expect(data).not.toHaveLength(0);
  });

  it('allows participant_care_staff to read', async () => {
    const client = await sessionFor(roles.participantCare);
    const { data, error } = await client.from('application_health_info').select('application_id');
    expect(error).toBeNull();
    expect(data).not.toHaveLength(0);
  });

  it('denies travel_operations_staff (wrong sensitive area)', async () => {
    const client = await sessionFor(roles.travelOps);
    const { data } = await client.from('application_health_info').select('application_id');
    expect(data ?? []).toHaveLength(0);
  });

  it('denies registration_admission_manager', async () => {
    const client = await sessionFor(roles.admission);
    const { data } = await client.from('application_health_info').select('application_id');
    expect(data ?? []).toHaveLength(0);
  });

  it('denies agenda_allocation_manager', async () => {
    const client = await sessionFor(roles.agenda);
    const { data } = await client.from('application_health_info').select('application_id');
    expect(data ?? []).toHaveLength(0);
  });

  it('denies communications_attendance_manager', async () => {
    const client = await sessionFor(roles.comms);
    const { data } = await client.from('application_health_info').select('application_id');
    expect(data ?? []).toHaveLength(0);
  });

  it('allows a participant to read their own row only', async () => {
    const client = await sessionFor(roles.participant);
    const { data, error } = await client.from('application_health_info').select('application_id');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].application_id).toBe(ownedApplicationId);
  });

  it('denies a participant from updating their own row (no self-service write in Phase A)', async () => {
    const client = await sessionFor(roles.participant);
    const { data } = await client
      .from('application_health_info')
      .update({ allergies: 'changed' })
      .eq('application_id', ownedApplicationId)
      .select();
    expect(data ?? []).toHaveLength(0);
  });
});

describe('general applications/application_answers queries do not leak sensitive columns', () => {
  it('a staff select("*") on applications never returns travel/health columns (they live on separate tables)', async () => {
    const client = await sessionFor(roles.admission);
    const { data, error } = await client.from('applications').select('*').eq('id', ownedApplicationId).maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data).not.toHaveProperty('allergies');
    expect(data).not.toHaveProperty('passport_full_name');
    expect(data).not.toHaveProperty('emergency_contact_phone');
  });
});
