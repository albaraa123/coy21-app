// src/lib/import/server-helpers.ts
//
// Shared caller-verification for the import pipeline specifically (upload,
// map, validate, preview, confirm, retry, rollback) — reachable by BOTH
// agenda_allocation_manager (pre-existing) and participants_communications_
// manager (new: accepted-participant Excel import is an explicit
// responsibility of that role). Deliberately NOT the same helper as
// requireAgendaStaffCaller (src/lib/agenda/server-helpers.ts), which stays
// scoped to agenda/allocation/schedule-publication server actions only —
// widening that shared helper would incorrectly grant
// participants_communications_manager access to agenda/allocation/schedule
// actions it is explicitly denied.
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isParticipantsCommunicationsStaffRole } from '@/lib/validation/participants-communications';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

// The service-role client bypasses RLS entirely, so this role check — not
// RLS — is the actual authorization gate for every write made by callers of
// this helper. Every import-pipeline server action must call this before
// any service-role read/write, and must not contain an early return that
// skips it.
export async function requireImportStaffCaller(): Promise<{ userId: string; service: ServiceClient }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
  // Single source of truth for these checks is isAgendaStaffRole
  // (src/lib/validation/agenda.ts) and isParticipantsCommunicationsStaffRole
  // (src/lib/validation/participants-communications.ts) — update those
  // helpers, not this call site, if the allowed role sets change.
  if (!isAgendaStaffRole(profile.role) && !isParticipantsCommunicationsStaffRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, service };
}
