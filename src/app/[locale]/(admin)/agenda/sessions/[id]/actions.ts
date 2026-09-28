// src/app/[locale]/(admin)/agenda/sessions/[id]/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { sessionStatusTransitionSchema, checkinWindowSchema, SESSION_PERSON_ROLES, type SessionStatus } from '@/lib/validation/agenda';
import type { Database } from '@/types/database';
import { z } from 'zod';

const sessionInputSchema = z
  .object({
    sessionCode: z.string().trim().min(1),
    titleAr: z.string().trim().min(1),
    titleEn: z.string().trim().min(1),
    descriptionAr: z.string().trim().optional().nullable(),
    descriptionEn: z.string().trim().optional().nullable(),
    conferenceDayId: z.string().uuid(),
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
    trackId: z.string().uuid(),
    sessionTypeId: z.string().uuid(),
    roomId: z.string().uuid(),
    language: z.enum(['ar', 'en', 'bilingual']),
    difficultyLevel: z.enum(['beginner', 'intermediate', 'advanced', 'all_levels']),
    capacity: z.number().int().positive(),
    minCapacity: z.number().int().min(0),
    isMandatory: z.boolean(),
    isPublic: z.boolean(),
    includeInAllocation: z.boolean(),
    allocationPriority: z.number().int(),
    enableQrCheckin: z.boolean(),
    checkinOpensAt: z.string().datetime().nullable(),
    checkinClosesAt: z.string().datetime().nullable(),
    internalNotes: z.string().trim().optional().nullable(),
  })
  .refine((data) => new Date(data.endTime) > new Date(data.startTime), {
    message: 'End time must be after start time',
    path: ['endTime'],
  })
  .refine((data) => data.minCapacity <= data.capacity, {
    message: 'Minimum capacity cannot exceed capacity',
    path: ['minCapacity'],
  });

// Postgres error codes this module translates into staff-readable messages,
// rather than surfacing raw DB errors. 23P01 = exclusion_violation (room
// overlap). Trigger-raised exceptions arrive as plain error messages (custom
// RAISE EXCEPTION has no dedicated SQLSTATE here), matched by substring.
function translateSessionWriteError(error: { code?: string; message: string }): Error {
  if (error.code === '23P01') {
    return new Error('This room is already booked for an overlapping time on this day');
  }
  if (error.message.includes('overlaps this time slot') || error.message.includes('creates a conflict for person')) {
    return new Error('One or more assigned people have a scheduling conflict with this time');
  }
  if (error.message.includes('exceeds room capacity')) {
    return new Error(error.message);
  }
  if (error.message.includes('does not match its conference day')) {
    return new Error(error.message);
  }
  return new Error(error.message);
}

export async function createSession(input: z.infer<typeof sessionInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = sessionInputSchema.parse(input);
  checkinWindowSchema.parse({
    enableQrCheckin: parsed.enableQrCheckin,
    checkinOpensAt: parsed.checkinOpensAt,
    checkinClosesAt: parsed.checkinClosesAt,
  });

  const { data: codeConflict } = await service.from('sessions').select('id').eq('session_code', parsed.sessionCode).maybeSingle();
  if (codeConflict) throw new Error(`Session code "${parsed.sessionCode}" is already in use`);

  const { data: session, error } = await service
    .from('sessions')
    .insert({
      session_code: parsed.sessionCode,
      title_ar: parsed.titleAr,
      title_en: parsed.titleEn,
      description_ar: parsed.descriptionAr ?? null,
      description_en: parsed.descriptionEn ?? null,
      conference_day_id: parsed.conferenceDayId,
      start_time: parsed.startTime,
      end_time: parsed.endTime,
      track_id: parsed.trackId,
      session_type_id: parsed.sessionTypeId,
      room_id: parsed.roomId,
      language: parsed.language,
      difficulty_level: parsed.difficultyLevel,
      capacity: parsed.capacity,
      min_capacity: parsed.minCapacity,
      is_mandatory: parsed.isMandatory,
      is_public: parsed.isPublic,
      include_in_allocation: parsed.includeInAllocation,
      allocation_priority: parsed.allocationPriority,
      enable_qr_checkin: parsed.enableQrCheckin,
      checkin_opens_at: parsed.checkinOpensAt,
      checkin_closes_at: parsed.checkinClosesAt,
      internal_notes: parsed.internalNotes ?? null,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error || !session) {
    console.error('createSession: insert failed', { input: parsed, userId, error });
    throw error ? translateSessionWriteError(error) : new Error('Failed to create session');
  }

  await writeAuditLog(service, { entityType: 'session', entityId: session.id, action: 'create', actorId: userId, newValues: parsed });
  return { id: session.id };
}

export async function updateSession(id: string, input: z.infer<typeof sessionInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = sessionInputSchema.parse(input);
  checkinWindowSchema.parse({
    enableQrCheckin: parsed.enableQrCheckin,
    checkinOpensAt: parsed.checkinOpensAt,
    checkinClosesAt: parsed.checkinClosesAt,
  });

  const { data: existing } = await service.from('sessions').select('*').eq('id', id).single();
  if (!existing) throw new Error('Session not found');

  const { data: codeConflict } = await service.from('sessions').select('id').eq('session_code', parsed.sessionCode).neq('id', id).maybeSingle();
  if (codeConflict) throw new Error(`Session code "${parsed.sessionCode}" is already in use`);

  // Delegates the write + speaker-conflict re-validation to a single Postgres
  // function so both happen inside one real transaction (see
  // supabase/migrations/20260723050000_update_session_transactional_function.sql).
  // A two-step client-side update-then-revalidate cannot be made atomic here:
  // PostgREST/Supabase-js calls are not composable into one client
  // transaction, so a re-validation failure after a committed client-side
  // UPDATE would leave a partially-applied change. The RPC closes that gap.
  // Note: the generated RPC arg types (src/types/database.ts) narrow every
  // parameter to its non-null Postgres type — `supabase gen types` does not
  // reflect plpgsql parameter nullability, even though every one of these
  // columns is nullable in the `sessions` table and the SQL function body
  // accepts null for them. Cast through `as string | null` at the call sites
  // that pass a nullable value rather than widening the whole Args type.
  const { data: result, error } = await service.rpc('update_session_transactional', {
    p_id: id,
    p_session_code: parsed.sessionCode,
    p_title_ar: parsed.titleAr,
    p_title_en: parsed.titleEn,
    p_description_ar: (parsed.descriptionAr ?? null) as string,
    p_description_en: (parsed.descriptionEn ?? null) as string,
    p_conference_day_id: parsed.conferenceDayId,
    p_start_time: parsed.startTime,
    p_end_time: parsed.endTime,
    p_track_id: parsed.trackId,
    p_session_type_id: parsed.sessionTypeId,
    p_room_id: parsed.roomId,
    p_language: parsed.language,
    p_difficulty_level: parsed.difficultyLevel,
    p_capacity: parsed.capacity,
    p_min_capacity: parsed.minCapacity,
    p_is_mandatory: parsed.isMandatory,
    p_is_public: parsed.isPublic,
    p_include_in_allocation: parsed.includeInAllocation,
    p_allocation_priority: parsed.allocationPriority,
    p_enable_qr_checkin: parsed.enableQrCheckin,
    p_checkin_opens_at: parsed.checkinOpensAt as string,
    p_checkin_closes_at: parsed.checkinClosesAt as string,
    p_internal_notes: (parsed.internalNotes ?? null) as string,
    p_updated_by: userId,
  });
  if (error) {
    console.error('updateSession: rpc failed', { id, input: parsed, userId, error });
    throw translateSessionWriteError(error);
  }

  await writeAuditLog(service, { entityType: 'session', entityId: id, action: 'update', actorId: userId, oldValues: existing, newValues: parsed });
  return { id: result.id };
}

export async function updateSessionStatus(id: string, to: SessionStatus, cancellationReason?: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('sessions').select('status').eq('id', id).single();
  if (!existing) throw new Error('Session not found');

  sessionStatusTransitionSchema.parse({ from: existing.status, to, cancellationReason });

  const updates: Database['public']['Tables']['sessions']['Update'] = { status: to, updated_by: userId };
  if (to === 'published') updates.published_at = new Date().toISOString();
  if (to === 'confirmed') updates.confirmed_at = new Date().toISOString();
  if (to === 'cancelled') {
    updates.cancelled_at = new Date().toISOString();
    updates.cancellation_reason = cancellationReason;
  }

  // Optimistic-concurrency guard: re-check the expected prior status on the
  // UPDATE itself and require exactly one affected row, exactly like Phase
  // 2's updateApplicationStatus (src/app/[locale]/(admin)/applications/[id]/actions.ts).
  // PostgREST returns error: null when an UPDATE matches zero rows — without
  // the explicit rowcount check below, a concurrent status change by another
  // admin between the read above and this write would silently no-op while
  // this function still wrote an audit log and returned success.
  const { data: updatedRows, error } = await service
    .from('sessions')
    .update(updates)
    .eq('id', id)
    .eq('status', existing.status)
    .select('id');
  if (error) {
    console.error('updateSessionStatus: update failed', { id, to, userId, error });
    throw translateSessionWriteError(error);
  }
  if (!updatedRows || updatedRows.length === 0) {
    throw new Error('Session status changed by someone else, please refresh');
  }

  await writeAuditLog(service, {
    entityType: 'session',
    entityId: id,
    action: 'status_change',
    actorId: userId,
    oldValues: { status: existing.status },
    newValues: { status: to, cancellationReason },
  });
  return { id, status: to };
}

const sessionPersonRoleSchema = z.enum(SESSION_PERSON_ROLES);

const assignPersonSchema = z.object({
  personId: z.string().uuid(),
  role: sessionPersonRoleSchema,
  displayOrder: z.number().int().default(0),
  isPrimary: z.boolean().default(false),
});

export async function assignSessionPerson(sessionId: string, input: z.infer<typeof assignPersonSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = assignPersonSchema.parse(input);

  const { data, error } = await service.rpc('assign_session_person_transactional', {
    p_session_id: sessionId, p_person_id: parsed.personId, p_role: parsed.role,
    p_display_order: parsed.displayOrder, p_is_primary: parsed.isPrimary, p_updated_by: userId,
  });
  if (error) {
    console.error('assignSessionPerson: rpc failed', { sessionId, input: parsed, userId, error });
    throw translateSessionWriteError(error);
  }

  await writeAuditLog(service, { entityType: 'session_people', entityId: data.id, action: 'create', actorId: userId, newValues: { sessionId, ...parsed } });
  return { id: data.id };
}

export async function removeSessionPerson(sessionPeopleId: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { error } = await service.rpc('remove_session_person', { p_session_people_id: sessionPeopleId });
  if (error) {
    console.error('removeSessionPerson: rpc failed', { sessionPeopleId, userId, error });
    throw error;
  }
  await writeAuditLog(service, { entityType: 'session_people', entityId: sessionPeopleId, action: 'delete', actorId: userId });
  return { id: sessionPeopleId };
}

const combinedUpdateSchema = z.object({
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  roomId: z.string().uuid(),
  assignments: z.array(z.object({
    personId: z.string().uuid(),
    role: sessionPersonRoleSchema,
    displayOrder: z.number().int().default(0),
    isPrimary: z.boolean().default(false),
  })),
});

export async function updateSessionScheduleAndAssignments(sessionId: string, input: z.infer<typeof combinedUpdateSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = combinedUpdateSchema.parse(input);

  const { data, error } = await service.rpc('update_session_and_assignments_transactional', {
    p_id: sessionId, p_start_time: parsed.startTime, p_end_time: parsed.endTime, p_room_id: parsed.roomId,
    p_updated_by: userId,
    p_new_assignments: parsed.assignments.map((a) => ({ person_id: a.personId, role: a.role, display_order: a.displayOrder, is_primary: a.isPrimary })),
  });
  if (error) {
    console.error('updateSessionScheduleAndAssignments: rpc failed', { sessionId, input: parsed, userId, error });
    throw translateSessionWriteError(error);
  }

  await writeAuditLog(service, { entityType: 'session', entityId: sessionId, action: 'update_schedule_and_assignments', actorId: userId, newValues: parsed });
  return { id: data.id };
}

const setTagsSchema = z.array(z.object({ tagId: z.string().uuid(), weight: z.number().min(0).max(1) }));

export async function setSessionTags(sessionId: string, tags: z.infer<typeof setTagsSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = setTagsSchema.parse(tags);

  const { error: deleteError } = await service.from('session_tags').delete().eq('session_id', sessionId);
  if (deleteError) throw deleteError;

  if (parsed.length > 0) {
    const { error: insertError } = await service.from('session_tags').insert(
      parsed.map((t) => ({ session_id: sessionId, tag_id: t.tagId, weight: t.weight, updated_by: userId }))
    );
    if (insertError) {
      console.error('setSessionTags: insert failed', { sessionId, tags: parsed, userId, error: insertError });
      throw insertError;
    }
  }

  await writeAuditLog(service, { entityType: 'session_tags', entityId: sessionId, action: 'update', actorId: userId, newValues: { tags: parsed } });
  return { sessionId };
}
