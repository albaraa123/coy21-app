'use server';

import { z } from 'zod';
import { requireSuperAdmin } from '@/lib/auth/require-super-admin';
import { sendRoleWelcomeEmail, type RoleWelcomeEmailRole } from '@/lib/email/resend';

// As of the 2026-09-29 staff role consolidation (see
// docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md),
// the 7 domain-specific staff roles this list used to enumerate
// (registration_admission_manager, agenda_allocation_manager,
// communications_attendance_manager, travel_operations_staff,
// participant_care_staff, participants_communications_manager,
// program_attendance_manager) collapsed into a single 'staff' role. This
// schema must reject them so a super_admin can no longer assign a
// deprecated role through this action, matching staff-manager.tsx's
// shrunk dropdown — assigning one here would silently diverge from what
// the UI offers and from every isStaffRole()-based authorization check
// elsewhere in the codebase.
//
// scanner_device (added by 20260804110000_add_scanner_device_role.sql,
// predates the consolidation above) is a separate, still-active role: a
// non-human per-device identity with its own RLS policies
// (20260804150000_attendance_rls_policies.sql), not one of the 7 merged
// into 'staff'. It was never wired into this admin UI — the only way to
// assign it was a direct DB update — so it's included here deliberately,
// not a regression of the consolidation above.
const STAFF_ROLES = ['super_admin', 'staff', 'scanner_device'] as const;

type StaffRole = (typeof STAFF_ROLES)[number];

const createStaffSchema = z.object({
  fullName: z.string().trim().min(2),
  email: z.string().trim().email(),
  role: z.enum(STAFF_ROLES),
  password: z.string().min(8),
});

export async function createStaffAccount(input: z.infer<typeof createStaffSchema>) {
  const { service } = await requireSuperAdmin();
  const parsed = createStaffSchema.parse(input);

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: parsed.email,
    password: parsed.password,
    email_confirm: true,
    user_metadata: { full_name: parsed.fullName },
  });
  if (createError || !created.user) {
    throw new Error(createError?.message ?? 'Failed to create user');
  }

  const { error: roleError } = await service
    .from('profiles')
    .update({ role: parsed.role, full_name: parsed.fullName })
    .eq('id', created.user.id);
  if (roleError) {
    throw new Error(roleError.message);
  }
}

const updateRoleSchema = z.object({
  staffId: z.string().uuid(),
  role: z.enum(STAFF_ROLES),
});

export async function updateStaffRole(input: z.infer<typeof updateRoleSchema>) {
  const { service } = await requireSuperAdmin();
  const parsed = updateRoleSchema.parse(input);

  const { error } = await service
    .from('profiles')
    .update({ role: parsed.role })
    .eq('id', parsed.staffId);
  if (error) throw new Error(error.message);
}

export async function deleteStaffAccount(staffId: string) {
  const { service } = await requireSuperAdmin();
  if (!staffId) throw new Error('Missing staffId');

  const { error } = await service.auth.admin.deleteUser(staffId);
  if (error) throw new Error(error.message);
}

export type ExistingStaffWelcomeEmailResult =
  | { id: string; email: string; status: 'sent' }
  | { id: string; email: string; status: 'failed'; error: string };

const sendExistingStaffWelcomeEmailsSchema = z.object({
  staffIds: z.array(z.string().uuid()).min(1),
  temporaryPassword: z.string().min(8),
});

// Sends sendRoleWelcomeEmail to a selection of already-existing staff/
// super_admin/scanner_device accounts, picked from the Staff Management
// table (not a fresh bulk-import batch -- see bulk-import-actions.ts's
// sendWelcomeEmailsForBatch for that case). Needed because the real COY21
// volunteer cohort includes 42 scanner_device accounts created earlier in
// a prior session, before this welcome-email flow existed -- there is no
// "batch" to hand this one, only a set of existing profile rows to pick
// from the table. The caller supplies ONE password for the whole
// selection (matching the shared-password pattern every other bulk
// account action in this file uses) since Supabase never exposes a
// user's actual password hash back out -- this codebase has no way to
// recover what password an existing account was created with, so the
// admin must know and re-enter it themselves.
export async function sendExistingStaffWelcomeEmails(
  input: z.infer<typeof sendExistingStaffWelcomeEmailsSchema>
): Promise<{ results: ExistingStaffWelcomeEmailResult[]; sentCount: number; failedCount: number }> {
  const { service } = await requireSuperAdmin();
  const parsed = sendExistingStaffWelcomeEmailsSchema.parse(input);

  const { data: rows, error: fetchError } = await service
    .from('profiles')
    .select('id, full_name, email, role')
    .in('id', parsed.staffIds);
  if (fetchError) throw new Error(fetchError.message);

  const results: ExistingStaffWelcomeEmailResult[] = [];
  let sentCount = 0;
  let failedCount = 0;

  for (const id of parsed.staffIds) {
    const row = rows?.find((r) => r.id === id);
    if (!row || !row.email) {
      results.push({ id, email: row?.email ?? '', status: 'failed', error: 'Account not found or has no email' });
      failedCount++;
      continue;
    }
    if (!STAFF_ROLES.includes(row.role as StaffRole)) {
      results.push({ id, email: row.email, status: 'failed', error: `Unsupported role: ${row.role}` });
      failedCount++;
      continue;
    }

    const { error } = await sendRoleWelcomeEmail({
      to: row.email,
      fullName: row.full_name || row.email,
      temporaryPassword: parsed.temporaryPassword,
      role: row.role as RoleWelcomeEmailRole,
    });

    if (error) {
      results.push({ id, email: row.email, status: 'failed', error });
      failedCount++;
      continue;
    }

    results.push({ id, email: row.email, status: 'sent' });
    sentCount++;
  }

  return { results, sentCount, failedCount };
}
