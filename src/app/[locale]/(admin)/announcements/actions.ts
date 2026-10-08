'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

// The service-role client bypasses RLS entirely, so this role check — not
// RLS — is the actual authorization gate for every write in this file. Every
// exported action must call this before any service-role read/write, and
// must not contain an early return that skips it. Replica (not a shared
// import — src/app/[locale]/(admin)/applications/[id]/actions.ts's own
// requireStaffCaller() is not exported, matching this codebase's established
// per-file pattern for this check) of the SAME SHAPE requireAdmissionStaffCaller
// (src/lib/admission/server-helpers.ts) and
// changeClassificationForSelectedForCaller
// (src/app/[locale]/(admin)/participants/accounts/actions.ts) already use —
// NOT a byte-for-byte copy of applications/[id]/actions.ts's own version,
// which has no `session` field. This one also returns `session` — the
// caller's own cookie-backed, auth.uid()-carrying client — because
// create_announcement is SECURITY DEFINER and derives the caller from
// auth.uid() internally via coalesce(is_staff(), false), with deliberately
// no service_role carve-out (see
// supabase/migrations/20261008020000_notification_writer_rpcs.sql's
// comment on create_announcement). The service-role client has no
// auth.uid() context, so calling the RPC through `service` would make
// is_staff() always see NULL and always reject, for staff and non-staff
// callers alike.
async function requireStaffCaller(): Promise<{ userId: string; session: SupabaseClient<Database>; service: ServiceClient }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (error || !profile) throw new Error('Profile not found');
  // Single source of truth for this check is isStaffRole in
  // src/lib/auth/is-staff-role.ts, also used by page.tsx's page-level gate.
  // Update the helper, not this call site, if the allowed role set changes.
  if (!isStaffRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, session: supabase, service };
}

// *ForCaller split follows this codebase's established live-test pattern
// (see updateApplicationStatusForCaller in
// src/app/[locale]/(admin)/applications/[id]/actions.ts and
// requireAdmissionStaffCaller's callers in participants/accounts/
// actions.ts): requireStaffCaller() reaches next/headers' cookies() via
// createClient(), which throws outside a real Next.js request — live tests
// call this variant with a signed-in anon-key client substituted for
// `session` instead (see tests/participants/classification-controls-live.
// test.ts's identical use of a real signInWithPassword client), while every
// DB-touching line is still exercised. Note create_announcement's own
// coalesce(is_staff(), false) guard (Task 1) is the real server-side
// authorization boundary for the insert itself -- this action's
// requireStaffCaller() role check is an additional fail-fast gate before
// the RPC round-trip, not a substitute for it.
export async function createAnnouncementForCaller(
  title: string,
  body: string | undefined,
  caller: { userId: string; session: SupabaseClient<Database>; service: ServiceClient }
) {
  const trimmedTitle = title.trim();
  if (trimmedTitle === '') {
    throw new Error('Title is required');
  }
  const { session } = caller;

  // p_body is left undefined (never an empty string) for a blank body
  // field. supabase-js's rpc() JSON.stringifies the args object, and
  // JSON.stringify drops undefined-valued keys entirely -- so an omitted
  // p_body falls through to create_announcement's own `p_body text
  // default null` (supabase/migrations/20261008020000_notification_writer_rpcs.sql),
  // landing as SQL NULL. This depends on that RPC default staying in
  // place; if create_announcement's signature ever drops `default null`,
  // this call site would need an explicit null instead.
  const { data, error } = await session.rpc('create_announcement', {
    p_title: trimmedTitle,
    p_body: body,
  });
  if (error) {
    throw error;
  }
  if (!data) {
    throw new Error('create_announcement returned no row');
  }

  return data;
}

export async function createAnnouncement(title: string, body: string | undefined) {
  const caller = await requireStaffCaller();
  return createAnnouncementForCaller(title, body, caller);
}
