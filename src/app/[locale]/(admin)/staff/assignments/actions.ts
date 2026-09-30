'use server';

import { z } from 'zod';
import { requireSuperAdmin } from '@/lib/auth/require-super-admin';

const ASSIGNMENT_TYPES = ['scanning_gate', 'session_monitor', 'participant_care', 'data_monitoring', 'general'] as const;

const createSchema = z.object({
  staffId: z.string().uuid(),
  assignmentType: z.enum(ASSIGNMENT_TYPES),
  label: z.string().trim().min(1),
  notes: z.string().trim().optional(),
  roomId: z.string().uuid().optional().nullable(),
  startsAt: z.string().optional().nullable(),
  endsAt: z.string().optional().nullable(),
});

export async function createAssignment(input: z.infer<typeof createSchema>) {
  const { service, userId } = await requireSuperAdmin();
  const parsed = createSchema.parse(input);

  const { error } = await service.from('staff_assignments').insert({
    staff_id: parsed.staffId,
    assignment_type: parsed.assignmentType,
    label: parsed.label,
    notes: parsed.notes ?? null,
    room_id: parsed.roomId ?? null,
    starts_at: parsed.startsAt ?? null,
    ends_at: parsed.endsAt ?? null,
    created_by: userId,
  });
  if (error) throw new Error(error.message);
}

export async function deleteAssignment(id: string) {
  const { service } = await requireSuperAdmin();
  if (!id) throw new Error('Missing id');
  const { error } = await service.from('staff_assignments').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
