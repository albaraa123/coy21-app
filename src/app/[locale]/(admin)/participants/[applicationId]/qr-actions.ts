// src/app/[locale]/(admin)/participants/[applicationId]/qr-actions.ts
'use server';

import { randomUUID } from 'node:crypto';
import { requireAgendaStaffCaller } from '@/lib/agenda/server-helpers'; // widened by Task 3.5 to also return `session`
import { issueStaffQrCredential } from '@/lib/attendance/qr-credential-issuance';

export async function issueQrForApplicationAction(applicationId: string): Promise<{ error: string | null }> {
  const { session, service } = await requireAgendaStaffCaller();

  const { data: application, error: fetchError } = await service
    .from('applications')
    .select('status')
    .eq('id', applicationId)
    .single();
  if (fetchError || !application) return { error: 'Application not found' };
  if (application.status !== 'accepted') return { error: 'Only accepted applications can be issued a QR code' };

  const result = await issueStaffQrCredential(session, service, {
    requestKey: randomUUID(),
    applicationId,
    issuanceReasonCode: 'staff_other',
    issuanceNote: 'Issued from participant detail page',
  });

  if (result.outcome !== 'issued' && result.outcome !== 'already_finalized' && result.outcome !== 'active_credential_already_exists') {
    return { error: `Unexpected issuance outcome: ${result.outcome}` };
  }
  return { error: null };
}
