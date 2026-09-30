'use server';

import { z } from 'zod';
import { requireSuperAdmin } from '@/lib/auth/require-super-admin';

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
const STAFF_ROLES = ['super_admin', 'staff'] as const;

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
