// src/app/[locale]/(admin)/agenda/tracks/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { z } from 'zod';

const trackInputSchema = z.object({
  code: z.string().trim().min(1),
  nameAr: z.string().trim().min(1),
  nameEn: z.string().trim().min(1),
  color: z.string().trim().optional().nullable(),
});

export async function createTrack(input: z.infer<typeof trackInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = trackInputSchema.parse(input);

  const { data: existing } = await service.from('tracks').select('id').eq('code', parsed.code).maybeSingle();
  if (existing) throw new Error(`Track code "${parsed.code}" is already in use`);

  const { data: track, error } = await service
    .from('tracks')
    .insert({
      code: parsed.code,
      name_ar: parsed.nameAr,
      name_en: parsed.nameEn,
      color: parsed.color ?? null,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error || !track) {
    console.error('createTrack: insert failed', { input: parsed, userId, error });
    throw error ?? new Error('Failed to create track');
  }

  await writeAuditLog(service, { entityType: 'track', entityId: track.id, action: 'create', actorId: userId, newValues: parsed });
  return { id: track.id };
}

export async function updateTrack(id: string, input: z.infer<typeof trackInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = trackInputSchema.parse(input);

  const { data: existing } = await service.from('tracks').select('*').eq('id', id).single();
  if (!existing) throw new Error('Track not found');

  const { data: codeConflict } = await service.from('tracks').select('id').eq('code', parsed.code).neq('id', id).maybeSingle();
  if (codeConflict) throw new Error(`Track code "${parsed.code}" is already in use`);

  const { error } = await service
    .from('tracks')
    .update({
      code: parsed.code,
      name_ar: parsed.nameAr,
      name_en: parsed.nameEn,
      color: parsed.color ?? null,
      updated_by: userId,
    })
    .eq('id', id);
  if (error) {
    console.error('updateTrack: update failed', { id, input: parsed, userId, error });
    throw error;
  }

  await writeAuditLog(service, { entityType: 'track', entityId: id, action: 'update', actorId: userId, oldValues: existing, newValues: parsed });
  return { id };
}

export async function deactivateTrack(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('tracks').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Track not found');

  const { error } = await service.from('tracks').update({ is_active: false, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('deactivateTrack: update failed', { id, userId, error });
    throw error;
  }

  await writeAuditLog(service, {
    entityType: 'track',
    entityId: id,
    action: 'deactivate',
    actorId: userId,
    oldValues: { is_active: existing.is_active },
    newValues: { is_active: false },
  });
  return { id };
}

export async function reactivateTrack(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('tracks').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Track not found');

  const { error } = await service.from('tracks').update({ is_active: true, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('reactivateTrack: update failed', { id, userId, error });
    throw error;
  }
  await writeAuditLog(service, { entityType: 'track', entityId: id, action: 'reactivate', actorId: userId, oldValues: { is_active: existing.is_active }, newValues: { is_active: true } });
  return { id };
}
