// src/app/[locale]/(admin)/attendance/issue-qr/actions.ts
//
// One-click bulk pre-issuance of the conference (attendance) QR for every
// accepted participant who does not have an active one yet, so nobody has
// to request it on their phone in the registration line. Runs as the
// signed-in super_admin (the staff issuance RPC requires a real staff
// identity), in small batches so each call stays well inside the
// serverless time limit; the client calls it repeatedly until none remain.
'use server';

import { randomUUID } from 'node:crypto';
import { requireAgendaStaffCaller } from '@/lib/agenda/server-helpers';
import { issueStaffQrCredential } from '@/lib/attendance/qr-credential-issuance';

const BATCH_SIZE = 10;

async function listMissing(service: Awaited<ReturnType<typeof requireAgendaStaffCaller>>['service']) {
  const { data: apps } = await service.from('applications').select('id').eq('status', 'accepted');
  const { data: active } = await service.from('qr_credentials').select('application_id').eq('status', 'active');
  const have = new Set((active ?? []).map((q) => q.application_id));
  return (apps ?? []).map((a) => a.id).filter((id) => !have.has(id));
}

export async function issueMissingQrBatchAction(): Promise<{ issued: number; failed: number; remaining: number; error: string | null }> {
  const { session, service } = await requireAgendaStaffCaller();
  const missing = await listMissing(service);
  let issued = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (const applicationId of missing.slice(0, BATCH_SIZE)) {
    try {
      const r = await issueStaffQrCredential(session, service, {
        requestKey: randomUUID(),
        applicationId,
        issuanceReasonCode: 'staff_other',
        issuanceNote: 'Pre-issued before Day 3 registration (organizer request)',
      });
      if (r.outcome === 'issued' || r.outcome === 'already_finalized' || r.outcome === 'active_credential_already_exists') issued++;
      else {
        failed++;
        firstError ??= `Unexpected outcome: ${r.outcome}`;
      }
    } catch (e) {
      failed++;
      firstError ??= e instanceof Error ? e.message : String(e);
    }
  }
  const remaining = (await listMissing(service)).length;
  return { issued, failed, remaining, error: firstError };
}
