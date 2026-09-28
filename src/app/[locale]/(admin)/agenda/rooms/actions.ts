// src/app/[locale]/(admin)/agenda/rooms/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { z } from 'zod';

const roomInputSchema = z.object({
  code: z.string().trim().min(1),
  nameAr: z.string().trim().min(1),
  nameEn: z.string().trim().min(1),
  capacity: z.number().int().positive(),
  location: z.string().trim().optional().nullable(),
  floor: z.string().trim().optional().nullable(),
  isAccessible: z.boolean(),
});

export async function createRoom(input: z.infer<typeof roomInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = roomInputSchema.parse(input);

  const { data: existing } = await service.from('rooms').select('id').eq('code', parsed.code).maybeSingle();
  if (existing) throw new Error(`Room code "${parsed.code}" is already in use`);

  const { data: room, error } = await service
    .from('rooms')
    .insert({
      code: parsed.code,
      name_ar: parsed.nameAr,
      name_en: parsed.nameEn,
      capacity: parsed.capacity,
      location: parsed.location ?? null,
      floor: parsed.floor ?? null,
      is_accessible: parsed.isAccessible,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error || !room) {
    console.error('createRoom: insert failed', { input: parsed, userId, error });
    throw error ?? new Error('Failed to create room');
  }

  await writeAuditLog(service, { entityType: 'room', entityId: room.id, action: 'create', actorId: userId, newValues: parsed });
  return { id: room.id };
}

export async function updateRoom(id: string, input: z.infer<typeof roomInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = roomInputSchema.parse(input);

  const { data: existing } = await service.from('rooms').select('*').eq('id', id).single();
  if (!existing) throw new Error('Room not found');

  const { data: codeConflict } = await service.from('rooms').select('id').eq('code', parsed.code).neq('id', id).maybeSingle();
  if (codeConflict) throw new Error(`Room code "${parsed.code}" is already in use`);

  // Room-capacity-reduction conflicts are caught by the DB trigger
  // (revalidate_sessions_on_room_capacity_change) — this action does not
  // pre-check separately, it lets the trigger reject and translates the
  // resulting Postgres error into a clear message.
  const { error } = await service
    .from('rooms')
    .update({
      code: parsed.code,
      name_ar: parsed.nameAr,
      name_en: parsed.nameEn,
      capacity: parsed.capacity,
      location: parsed.location ?? null,
      floor: parsed.floor ?? null,
      is_accessible: parsed.isAccessible,
      updated_by: userId,
    })
    .eq('id', id);
  if (error) {
    if (error.message.includes('exceed that capacity')) {
      throw new Error(error.message); // trigger's message is already staff-readable
    }
    console.error('updateRoom: update failed', { id, input: parsed, userId, error });
    throw error;
  }

  await writeAuditLog(service, { entityType: 'room', entityId: id, action: 'update', actorId: userId, oldValues: existing, newValues: parsed });
  return { id };
}

export async function deactivateRoom(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('rooms').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Room not found');

  const { error } = await service.from('rooms').update({ is_active: false, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('deactivateRoom: update failed', { id, userId, error });
    throw error;
  }

  await writeAuditLog(service, { entityType: 'room', entityId: id, action: 'deactivate', actorId: userId, oldValues: { is_active: existing.is_active }, newValues: { is_active: false } });
  return { id };
}

export async function reactivateRoom(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('rooms').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Room not found');

  const { error } = await service.from('rooms').update({ is_active: true, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('reactivateRoom: update failed', { id, userId, error });
    throw error;
  }
  await writeAuditLog(service, { entityType: 'room', entityId: id, action: 'reactivate', actorId: userId, oldValues: { is_active: existing.is_active }, newValues: { is_active: true } });
  return { id };
}
