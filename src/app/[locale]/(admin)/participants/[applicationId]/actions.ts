// src/app/[locale]/(admin)/participants/[applicationId]/actions.ts
'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { sendInvitationSchema } from '@/lib/validation/import';
import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { sendInvitation, resendInvitation, revokeInvitation } from '@/lib/import/invitation';

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
