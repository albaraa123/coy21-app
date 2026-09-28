// src/app/[locale]/(admin)/agenda/people/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { z } from 'zod';

// Postgres error code for a unique-constraint violation. Used below to
// detect a duplicate people.linked_profile_id (constraint
// people_linked_profile_id_key) without substring-matching error.message.
const UNIQUE_VIOLATION = '23505';

const personInputSchema = z.object({
  fullNameAr: z.string().trim().min(1),
  fullNameEn: z.string().trim().min(1),
  titleAr: z.string().trim().optional().nullable(),
  titleEn: z.string().trim().optional().nullable(),
  organizationAr: z.string().trim().optional().nullable(),
  organizationEn: z.string().trim().optional().nullable(),
  bioAr: z.string().trim().optional().nullable(),
  bioEn: z.string().trim().optional().nullable(),
  photoPath: z.string().trim().optional().nullable(),
  email: z.string().trim().email().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  linkedProfileId: z.string().uuid().optional().nullable(),
  isPublic: z.boolean().optional(),
});

export async function createPerson(input: z.infer<typeof personInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = personInputSchema.parse(input);

  const { data: person, error } = await service
    .from('people')
    .insert({
      full_name_ar: parsed.fullNameAr,
      full_name_en: parsed.fullNameEn,
      title_ar: parsed.titleAr ?? null,
      title_en: parsed.titleEn ?? null,
      organization_ar: parsed.organizationAr ?? null,
      organization_en: parsed.organizationEn ?? null,
      bio_ar: parsed.bioAr ?? null,
      bio_en: parsed.bioEn ?? null,
      photo_path: parsed.photoPath ?? null,
      email: parsed.email ?? null,
      phone: parsed.phone ?? null,
      linked_profile_id: parsed.linkedProfileId ?? null,
      is_public: parsed.isPublic ?? false,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error || !person) {
    if (error?.code === UNIQUE_VIOLATION) {
      throw new Error('This platform account is already linked to another person record');
    }
    console.error('createPerson: insert failed', { input: parsed, userId, error });
    throw error ?? new Error('Failed to create person');
  }

  await writeAuditLog(service, { entityType: 'person', entityId: person.id, action: 'create', actorId: userId, newValues: parsed });
  return { id: person.id };
}

export async function updatePerson(id: string, input: z.infer<typeof personInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = personInputSchema.parse(input);

  const { data: existing } = await service.from('people').select('*').eq('id', id).single();
  if (!existing) throw new Error('Person not found');

  const { error } = await service
    .from('people')
    .update({
      full_name_ar: parsed.fullNameAr,
      full_name_en: parsed.fullNameEn,
      title_ar: parsed.titleAr ?? null,
      title_en: parsed.titleEn ?? null,
      organization_ar: parsed.organizationAr ?? null,
      organization_en: parsed.organizationEn ?? null,
      bio_ar: parsed.bioAr ?? null,
      bio_en: parsed.bioEn ?? null,
      photo_path: parsed.photoPath ?? null,
      email: parsed.email ?? null,
      phone: parsed.phone ?? null,
      linked_profile_id: parsed.linkedProfileId ?? null,
      is_public: parsed.isPublic ?? false,
      updated_by: userId,
    })
    .eq('id', id);
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new Error('This platform account is already linked to another person record');
    }
    console.error('updatePerson: update failed', { id, input: parsed, userId, error });
    throw error;
  }

  await writeAuditLog(service, { entityType: 'person', entityId: id, action: 'update', actorId: userId, oldValues: existing, newValues: parsed });
  return { id };
}

export async function deactivatePerson(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('people').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Person not found');

  const { error } = await service.from('people').update({ is_active: false, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('deactivatePerson: update failed', { id, userId, error });
    throw error;
  }

  await writeAuditLog(service, {
    entityType: 'person',
    entityId: id,
    action: 'deactivate',
    actorId: userId,
    oldValues: { is_active: existing.is_active },
    newValues: { is_active: false },
  });
  return { id };
}

export async function reactivatePerson(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('people').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Person not found');

  const { error } = await service.from('people').update({ is_active: true, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('reactivatePerson: update failed', { id, userId, error });
    throw error;
  }
  await writeAuditLog(service, { entityType: 'person', entityId: id, action: 'reactivate', actorId: userId, oldValues: { is_active: existing.is_active }, newValues: { is_active: true } });
  return { id };
}
