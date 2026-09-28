// tests/allocation/authorization.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

let participantId: string | undefined;
let staffId: string | undefined;

beforeAll(async () => {
  const { data: participant } = await admin.auth.admin.createUser({ email: 'allocation-authz-participant@test.local', password: 'password123', email_confirm: true });
  participantId = participant.user!.id;
  await admin.from('profiles').update({ role: 'participant' }).eq('id', participantId);

  const { data: staff } = await admin.auth.admin.createUser({ email: 'allocation-authz-staff@test.local', password: 'password123', email_confirm: true });
  staffId = staff.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);
});

afterAll(async () => {
  await Promise.allSettled([
    participantId ? admin.auth.admin.deleteUser(participantId) : Promise.resolve(),
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
  ]);
});

describe('allocation RLS: non-staff cannot read allocation tables', () => {
  it('rejects a participant reading allocation_runs directly', async () => {
    const client = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await client.auth.signInWithPassword({ email: 'allocation-authz-participant@test.local', password: 'password123' });
    const { data } = await client.from('allocation_runs').select('id');
    // RLS silently returns an empty set for a non-staff caller rather than an
    // error — the meaningful assertion is that no rows leaked.
    expect(data ?? []).toHaveLength(0);
  });

  it('allows staff to read allocation_runs directly', async () => {
    const client = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await client.auth.signInWithPassword({ email: 'allocation-authz-staff@test.local', password: 'password123' });
    const { error } = await client.from('allocation_runs').select('id');
    expect(error).toBeNull();
  });
});
