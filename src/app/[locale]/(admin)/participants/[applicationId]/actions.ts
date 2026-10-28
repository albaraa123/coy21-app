// src/app/[locale]/(admin)/participants/[applicationId]/actions.ts
'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { sendInvitationSchema } from '@/lib/validation/import';
import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { sendInvitation, resendInvitation, revokeInvitation } from '@/lib/import/invitation';
import { reclassifyApplication } from '@/lib/participants/reclassify';

type ServiceClient = SupabaseClient<Database>;

// Thin 'use server' wrappers around src/lib/import/invitation.ts, matching
// the *ForCaller / cookie-based-wrapper split already established by Tasks
// 12-19 (see e.g. confirm/actions.ts, rollback-action.ts): the ForCaller
// variant is what live tests call directly with a service-role caller,
// since 'use server' functions reach next/headers' cookies() via
// requireAgendaStaffCaller, which throws outside a real Next.js request.

export async function sendInvitationActionForCaller(
  applicationIdInput: unknown,
  caller: { userId: string; service: ServiceClient }
) {
  const { applicationId } = sendInvitationSchema.parse({ applicationId: applicationIdInput });
  const { userId, service } = caller;

  const result = await sendInvitation(service, applicationId, userId);

  await writeAuditLog(service, {
    entityType: 'application',
    entityId: applicationId,
    action: 'invitation_sent',
    actorId: userId,
    metadata: { invitedUserId: result.invitedUserId },
  });

  return result;
}

export async function sendInvitationAction(applicationIdInput: unknown) {
  const caller = await requireAgendaStaffCaller();
  return sendInvitationActionForCaller(applicationIdInput, caller);
}

export async function resendInvitationActionForCaller(
  applicationIdInput: unknown,
  caller: { userId: string; service: ServiceClient }
) {
  const { applicationId } = sendInvitationSchema.parse({ applicationId: applicationIdInput });
  const { userId, service } = caller;

  const result = await resendInvitation(service, applicationId);

  await writeAuditLog(service, {
    entityType: 'application',
    entityId: applicationId,
    action: 'invitation_resent',
    actorId: userId,
    metadata: { invitedUserId: result.invitedUserId },
  });

  return result;
}

export async function resendInvitationAction(applicationIdInput: unknown) {
  const caller = await requireAgendaStaffCaller();
  return resendInvitationActionForCaller(applicationIdInput, caller);
}

export async function revokeInvitationActionForCaller(
  applicationIdInput: unknown,
  caller: { userId: string; service: ServiceClient }
) {
  const { applicationId } = sendInvitationSchema.parse({ applicationId: applicationIdInput });
  const { userId, service } = caller;

  const result = await revokeInvitation(service, applicationId);

  await writeAuditLog(service, {
    entityType: 'application',
    entityId: applicationId,
    action: 'invitation_revoked',
    actorId: userId,
  });

  return result;
}

export async function revokeInvitationAction(applicationIdInput: unknown) {
  const caller = await requireAgendaStaffCaller();
  return revokeInvitationActionForCaller(applicationIdInput, caller);
}

// Thin wrapper around src/lib/participants/reclassify.ts's shared
// reclassifyApplication (Task 4), following the same *ForCaller / plain
// split as the invitation actions above. Deliberately uses
// requireAgendaStaffCaller (shared, already widened by Task 3.5 to return
// `session` alongside `userId`/`service`) rather than this file's own
// inline auth pattern used by the invitation actions — reclassifyApplication
// needs the caller's own session client (not just service-role) for its
// QR-reissue branch, and requireAgendaStaffCaller is the one helper that
// already provides both.
export async function updateParticipantTypeActionForCaller(
  applicationId: string,
  newParticipantType: Database['public']['Enums']['participant_type'],
  caller: { userId: string; session: SupabaseClient<Database>; service: ServiceClient }
) {
  const result = await reclassifyApplication(caller.session, caller.service, {
    applicationId,
    newParticipantType,
    actorId: caller.userId,
  });
  if (result.outcome === 'error') throw new Error(result.errorMessage ?? 'Failed to update classification');
  return result;
}

export async function updateParticipantTypeAction(
  applicationId: string,
  newParticipantType: Database['public']['Enums']['participant_type']
) {
  const caller = await requireAgendaStaffCaller();
  return updateParticipantTypeActionForCaller(applicationId, newParticipantType, caller);
}

export type GeneralInfoUpdateInput = Partial<{
  full_name: string | null;
  phone: string | null;
  whatsapp_number: string | null;
  country: string | null;
  nationality: string | null;
  city: string | null;
  gender: string | null;
  birth_date: string | null;
  age_group: string | null;
  education_level: string | null;
  institution_or_workplace: string | null;
  field_of_work: string | null;
  organization: string | null;
  preferred_language: string | null;
  linkedin_url: string | null;
  primary_track: string | null;
  secondary_track: string | null;
  topics_to_learn: string | null;
  content_type_pref: string | null;
  experience_level: string | null;
  climate_experience: string | null;
  past_initiatives: string | null;
  participation_goals: string | null;
  priority_sessions: string | null;
  special_needs: string | null;
  interests: string[] | null;
  track_interests: string[] | null;
  session_languages: string[] | null;
  track_1_focus_areas: string[] | null;
  track_2_focus_areas: string[] | null;
  track_3_focus_areas: string[] | null;
}>;

export type GeneralInfo = GeneralInfoUpdateInput & { id: string };

const GENERAL_INFO_SELECT =
  'id, full_name, phone, whatsapp_number, country, nationality, city, gender, birth_date, age_group, education_level, institution_or_workplace, field_of_work, organization, preferred_language, linkedin_url, primary_track, secondary_track, topics_to_learn, content_type_pref, experience_level, climate_experience, past_initiatives, participation_goals, priority_sessions, special_needs, interests, track_interests, session_languages, track_1_focus_areas, track_2_focus_areas, track_3_focus_areas';

// Plain update, not upsert -- applications always has exactly one row
// per application already, same reasoning as updateGuardianInfoForCaller
// (health-info-management.ts). This action's write surface is EXACTLY
// the 31-column design-spec scope, enforced at the type level by
// GeneralInfoUpdateInput -- it must never be widened to accept
// participant_type/status/guardian_name/etc., which are owned by their
// own dedicated actions.
export async function updateGeneralInfoForCaller(
  applicationId: string,
  input: GeneralInfoUpdateInput,
  caller: { userId: string; service: ServiceClient }
): Promise<GeneralInfo> {
  const { service, userId } = caller;
  const { data: before } = await service.from('applications').select(GENERAL_INFO_SELECT).eq('id', applicationId).maybeSingle();

  const { data, error } = await service
    .from('applications')
    .update(input)
    .eq('id', applicationId)
    .select(GENERAL_INFO_SELECT)
    .single();
  if (error) throw new Error(error.message);

  await writeAuditLog(service, {
    entityType: 'applications',
    entityId: applicationId,
    action: 'general_info_updated',
    actorId: userId,
    oldValues: before,
    newValues: data,
  });

  return data;
}

export async function updateGeneralInfoAction(applicationId: string, input: GeneralInfoUpdateInput) {
  const caller = await requireAgendaStaffCaller();
  return updateGeneralInfoForCaller(applicationId, input, caller);
}
