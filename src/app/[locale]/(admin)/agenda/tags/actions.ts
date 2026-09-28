// src/app/[locale]/(admin)/agenda/tags/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { z } from 'zod';

const tagInputSchema = z.object({
  code: z.string().trim().min(1),
  nameAr: z.string().trim().min(1),
  nameEn: z.string().trim().min(1),
});

export async function createTag(input: z.infer<typeof tagInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = tagInputSchema.parse(input);

  const { data: existing } = await service.from('tags').select('id').eq('code', parsed.code).maybeSingle();
  if (existing) throw new Error(`Tag code "${parsed.code}" is already in use`);

  const { data: tag, error } = await service
    .from('tags')
    .insert({
      code: parsed.code,
      name_ar: parsed.nameAr,
      name_en: parsed.nameEn,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error || !tag) {
    console.error('createTag: insert failed', { input: parsed, userId, error });
    throw error ?? new Error('Failed to create tag');
  }

  await writeAuditLog(service, { entityType: 'tag', entityId: tag.id, action: 'create', actorId: userId, newValues: parsed });
  return { id: tag.id };
}

export async function updateTag(id: string, input: z.infer<typeof tagInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = tagInputSchema.parse(input);

  const { data: existing } = await service.from('tags').select('*').eq('id', id).single();
  if (!existing) throw new Error('Tag not found');

  const { data: codeConflict } = await service.from('tags').select('id').eq('code', parsed.code).neq('id', id).maybeSingle();
  if (codeConflict) throw new Error(`Tag code "${parsed.code}" is already in use`);

  const { error } = await service
    .from('tags')
    .update({
      code: parsed.code,
      name_ar: parsed.nameAr,
      name_en: parsed.nameEn,
      updated_by: userId,
    })
    .eq('id', id);
  if (error) {
    console.error('updateTag: update failed', { id, input: parsed, userId, error });
    throw error;
  }

  await writeAuditLog(service, { entityType: 'tag', entityId: id, action: 'update', actorId: userId, oldValues: existing, newValues: parsed });
  return { id };
}

export async function deactivateTag(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('tags').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Tag not found');

  const { error } = await service.from('tags').update({ is_active: false, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('deactivateTag: update failed', { id, userId, error });
    throw error;
  }

  await writeAuditLog(service, {
    entityType: 'tag',
    entityId: id,
    action: 'deactivate',
    actorId: userId,
    oldValues: { is_active: existing.is_active },
    newValues: { is_active: false },
  });
  return { id };
}

export async function reactivateTag(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('tags').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Tag not found');

  const { error } = await service.from('tags').update({ is_active: true, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('reactivateTag: update failed', { id, userId, error });
    throw error;
  }
  await writeAuditLog(service, { entityType: 'tag', entityId: id, action: 'reactivate', actorId: userId, oldValues: { is_active: existing.is_active }, newValues: { is_active: true } });
  return { id };
}
