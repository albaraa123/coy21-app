// src/app/[locale]/(admin)/agenda/session-types/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { z } from 'zod';

const sessionTypeInputSchema = z.object({
  code: z.string().trim().min(1),
  nameAr: z.string().trim().min(1),
  nameEn: z.string().trim().min(1),
});

export async function createSessionType(input: z.infer<typeof sessionTypeInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = sessionTypeInputSchema.parse(input);

  const { data: existing } = await service.from('session_types').select('id').eq('code', parsed.code).maybeSingle();
  if (existing) throw new Error(`Session type code "${parsed.code}" is already in use`);

  const { data: sessionType, error } = await service
    .from('session_types')
    .insert({
      code: parsed.code,
      name_ar: parsed.nameAr,
      name_en: parsed.nameEn,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error || !sessionType) {
    console.error('createSessionType: insert failed', { input: parsed, userId, error });
    throw error ?? new Error('Failed to create session type');
  }

  await writeAuditLog(service, { entityType: 'session_type', entityId: sessionType.id, action: 'create', actorId: userId, newValues: parsed });
  return { id: sessionType.id };
}

export async function updateSessionType(id: string, input: z.infer<typeof sessionTypeInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = sessionTypeInputSchema.parse(input);

  const { data: existing } = await service.from('session_types').select('*').eq('id', id).single();
  if (!existing) throw new Error('Session type not found');

  const { data: codeConflict } = await service.from('session_types').select('id').eq('code', parsed.code).neq('id', id).maybeSingle();
  if (codeConflict) throw new Error(`Session type code "${parsed.code}" is already in use`);

  const { error } = await service
    .from('session_types')
    .update({
      code: parsed.code,
      name_ar: parsed.nameAr,
      name_en: parsed.nameEn,
      updated_by: userId,
    })
    .eq('id', id);
  if (error) {
    console.error('updateSessionType: update failed', { id, input: parsed, userId, error });
    throw error;
  }

  await writeAuditLog(service, { entityType: 'session_type', entityId: id, action: 'update', actorId: userId, oldValues: existing, newValues: parsed });
  return { id };
}

export async function deactivateSessionType(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('session_types').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Session type not found');

  const { error } = await service.from('session_types').update({ is_active: false, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('deactivateSessionType: update failed', { id, userId, error });
    throw error;
  }

  await writeAuditLog(service, {
    entityType: 'session_type',
    entityId: id,
    action: 'deactivate',
    actorId: userId,
    oldValues: { is_active: existing.is_active },
    newValues: { is_active: false },
  });
  return { id };
}

export async function reactivateSessionType(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('session_types').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Session type not found');

  const { error } = await service.from('session_types').update({ is_active: true, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('reactivateSessionType: update failed', { id, userId, error });
    throw error;
  }
  await writeAuditLog(service, { entityType: 'session_type', entityId: id, action: 'reactivate', actorId: userId, oldValues: { is_active: existing.is_active }, newValues: { is_active: true } });
  return { id };
}
