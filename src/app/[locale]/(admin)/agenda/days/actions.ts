// src/app/[locale]/(admin)/agenda/days/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { z } from 'zod';

const conferenceDayInputSchema = z.object({
  conferenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'conferenceDate must be an ISO date string (YYYY-MM-DD)'),
  labelAr: z.string().trim().min(1),
  labelEn: z.string().trim().min(1),
  displayOrder: z.number().int(),
});

export async function createConferenceDay(input: z.infer<typeof conferenceDayInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = conferenceDayInputSchema.parse(input);

  const { data: existing } = await service
    .from('conference_days')
    .select('id')
    .eq('conference_date', parsed.conferenceDate)
    .maybeSingle();
  if (existing) throw new Error(`Conference date "${parsed.conferenceDate}" is already in use`);

  const { data: day, error } = await service
    .from('conference_days')
    .insert({
      conference_date: parsed.conferenceDate,
      label_ar: parsed.labelAr,
      label_en: parsed.labelEn,
      display_order: parsed.displayOrder,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error || !day) {
    console.error('createConferenceDay: insert failed', { input: parsed, userId, error });
    throw error ?? new Error('Failed to create conference day');
  }

  await writeAuditLog(service, { entityType: 'conference_day', entityId: day.id, action: 'create', actorId: userId, newValues: parsed });
  return { id: day.id };
}

export async function updateConferenceDay(id: string, input: z.infer<typeof conferenceDayInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = conferenceDayInputSchema.parse(input);

  const { data: existing } = await service.from('conference_days').select('*').eq('id', id).single();
  if (!existing) throw new Error('Conference day not found');

  const { data: dateConflict } = await service
    .from('conference_days')
    .select('id')
    .eq('conference_date', parsed.conferenceDate)
    .neq('id', id)
    .maybeSingle();
  if (dateConflict) throw new Error(`Conference date "${parsed.conferenceDate}" is already in use`);

  const { error } = await service
    .from('conference_days')
    .update({
      conference_date: parsed.conferenceDate,
      label_ar: parsed.labelAr,
      label_en: parsed.labelEn,
      display_order: parsed.displayOrder,
      updated_by: userId,
    })
    .eq('id', id);
  if (error) {
    console.error('updateConferenceDay: update failed', { id, input: parsed, userId, error });
    throw error;
  }

  await writeAuditLog(service, { entityType: 'conference_day', entityId: id, action: 'update', actorId: userId, oldValues: existing, newValues: parsed });
  return { id };
}

export async function deactivateConferenceDay(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('conference_days').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Conference day not found');

  const { error } = await service.from('conference_days').update({ is_active: false, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('deactivateConferenceDay: update failed', { id, userId, error });
    throw error;
  }

  await writeAuditLog(service, {
    entityType: 'conference_day',
    entityId: id,
    action: 'deactivate',
    actorId: userId,
    oldValues: { is_active: existing.is_active },
    newValues: { is_active: false },
  });
  return { id };
}

export async function reactivateConferenceDay(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('conference_days').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Conference day not found');

  const { error } = await service.from('conference_days').update({ is_active: true, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('reactivateConferenceDay: update failed', { id, userId, error });
    throw error;
  }
  await writeAuditLog(service, { entityType: 'conference_day', entityId: id, action: 'reactivate', actorId: userId, oldValues: { is_active: existing.is_active }, newValues: { is_active: true } });
  return { id };
}
