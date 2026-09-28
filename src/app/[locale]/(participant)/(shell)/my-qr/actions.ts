// src/app/[locale]/(participant)/(shell)/my-qr/actions.ts
'use server';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getMyQrState, type ParticipantQrState } from '@/lib/attendance/participant-qr';
import { issueMyQrCredential, reissueMyQrCredential } from '@/lib/attendance/qr-credential-issuance';
import { renderQrDataUri } from '@/lib/attendance/qr-image';

export interface MyQrActionResult {
  state: ParticipantQrState;
  qrImageDataUri: string | null;
}

async function toActionResult(state: ParticipantQrState): Promise<MyQrActionResult> {
  return { state, qrImageDataUri: state.kind === 'QR_AVAILABLE' ? await renderQrDataUri(state.qrPayload) : null };
}

// Same two-client shape claim/actions.ts documents and justifies: the
// reservation RPCs are SECURITY DEFINER and assert
// requester_id = auth.uid() internally, which only resolves over the
// caller's OWN authenticated session — never a service-role call (which
// has no auth.uid()). The service-role client is still needed for the
// finalize step (service_role-only) and for every OTHER read in this
// file (profile/application/credential lookups), matching
// qr-credential-issuance.ts's own module-level doc comment on why two
// clients are required.
async function requireParticipantCaller() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  return { userId: user.id, session: supabase, service: createServiceRoleClient() };
}

export async function fetchMyQrState(): Promise<MyQrActionResult> {
  const { userId, service } = await requireParticipantCaller();
  return toActionResult(await getMyQrState({ userId, service }));
}

/**
 * Self-service issuance for an accepted participant with no active
 * credential yet. Reuses issueMyQrCredential exactly as-is — no new
 * eligibility logic here; the RPC itself already rejects a non-accepted
 * caller (application_ineligible outcome), and getMyQrState's own
 * 'NOT_YET_AVAILABLE'/'NOT_ELIGIBLE' states are what gate whether this
 * action is even reachable from the UI. Idempotent by construction:
 * a repeated click while a credential already exists returns
 * 'active_credential_already_exists' from the RPC, which this action
 * treats as a success path (re-fetch and display the existing one)
 * rather than an error.
 */
export async function requestMyQrCredential(): Promise<MyQrActionResult> {
  const { userId, session, service } = await requireParticipantCaller();
  const result = await issueMyQrCredential(session, service, randomUUID());
  if (result.outcome !== 'issued' && result.outcome !== 'already_finalized' && result.outcome !== 'active_credential_already_exists') {
    console.error('requestMyQrCredential: unexpected issuance outcome', { userId, outcome: result.outcome });
  }
  return toActionResult(await getMyQrState({ userId, service }));
}

const reissueSchema = z.object({ expectedCurrentCredentialId: z.string().uuid() });

/**
 * Participant self-service reissue — only reachable from the UI when a
 * current active credential already exists (the UI supplies its id back
 * unchanged, never lets the participant type an arbitrary id). Warns the
 * participant client-side before calling this (old QR stops working);
 * server-side this is a single call into the existing reservation/
 * finalizer lifecycle, no new logic. Idempotent: a duplicate click with
 * the same expectedCurrentCredentialId either hits 'already_finalized'
 * (safe replay) or 'active_credential_already_exists' once the first
 * click's new credential is now current (also safe — getMyQrState simply
 * re-reads whatever is current).
 */
export async function reissueMyQrCredentialAction(input: z.infer<typeof reissueSchema>): Promise<MyQrActionResult> {
  const { userId, session, service } = await requireParticipantCaller();
  const parsed = reissueSchema.parse(input);
  const result = await reissueMyQrCredential(session, service, {
    requestKey: randomUUID(),
    expectedCurrentCredentialId: parsed.expectedCurrentCredentialId,
    reissueReasonCode: 'participant_other',
    reissueNote: 'Participant self-service reissue from My QR page',
  });
  if (result.outcome !== 'reissued' && result.outcome !== 'already_finalized') {
    console.error('reissueMyQrCredentialAction: unexpected reissue outcome', { userId, outcome: result.outcome });
  }
  return toActionResult(await getMyQrState({ userId, service }));
}
