// src/lib/cafeteria/credential-issuance.ts
//
// Self-service issuance for the cafeteria credential, mirroring
// src/lib/attendance/qr-credential-issuance.ts's own
// issueMyQrCredential shape: idempotent (a repeat call returns the
// existing credential rather than erroring), eligibility re-checked
// server-side (never trusts a client claim), never issues for an
// ineligible caller.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { generateCafeteriaToken, hashCafeteriaToken } from './token';
import { isLunchEligible } from './eligibility';
import { renderQrDataUri } from '@/lib/attendance/qr-image';

type ServiceClient = SupabaseClient<Database>;

export type IssueCafeteriaCredentialResult =
  | { outcome: 'issued'; credentialId: string; qrImageDataUri: string }
  | { outcome: 'already_exists'; credentialId: string; qrImageDataUri: string }
  | { outcome: 'not_eligible' }
  | { outcome: 'error'; message: string };

// PostgREST bytea encoding: supabase-js JSON-serializes a raw Node Buffer
// as {"type":"Buffer","data":[...]}, which is NOT a valid bytea literal.
// Same `\x` + hex convention this codebase already uses in
// src/lib/attendance/qr-credential-issuance.ts's toByteaHex and
// tests/cafeteria/lunch-scan-rpc-live.test.ts's own copy of it.
function toByteaHex(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

export async function issueCafeteriaCredentialForCaller(
  caller: { userId: string; service: ServiceClient }
): Promise<IssueCafeteriaCredentialResult> {
  const { userId, service } = caller;

  const { data: profile, error: profileError } = await service.from('profiles').select('role').eq('id', userId).maybeSingle();
  if (profileError) return { outcome: 'error', message: profileError.message };

  const { data: application, error: appError } = await service
    .from('applications')
    .select('id, participant_type, status, attendance_confirmation')
    .eq('applicant_id', userId)
    .maybeSingle();
  if (appError) return { outcome: 'error', message: appError.message };

  const eligible = isLunchEligible(application, profile);
  if (!eligible) return { outcome: 'not_eligible' };

  // Staff (no application) key by profile_id; a participant keys by
  // application_id — matches the schema's one-owner constraint exactly.
  // Kept as two explicit branches (rather than a computed property key)
  // because a computed key widens the insert payload to a generic
  // string-indexed object, which TypeScript then rejects against the
  // generated Insert type's exact shape.
  const ownerFilter: { application_id: string } | { profile_id: string } = application
    ? { application_id: application.id }
    : { profile_id: userId };

  const findExisting = () =>
    'application_id' in ownerFilter
      ? service.from('cafeteria_credentials').select('id, qr_image_data_uri').eq('application_id', ownerFilter.application_id).maybeSingle()
      : service.from('cafeteria_credentials').select('id, qr_image_data_uri').eq('profile_id', ownerFilter.profile_id).maybeSingle();

  const { data: existing, error: existingError } = await findExisting();
  if (existingError) return { outcome: 'error', message: existingError.message };
  if (existing) return { outcome: 'already_exists', credentialId: existing.id, qrImageDataUri: existing.qr_image_data_uri };

  const { rawToken, payload } = generateCafeteriaToken();
  const tokenHash = hashCafeteriaToken(rawToken);
  // The rendered PNG is stored (not just the hash) specifically so a
  // returning visit can redisplay the same code — token_hash is a
  // one-way hash and the raw payload is never recoverable from it. See
  // the design spec's "Redisplay" section.
  const qrImageDataUri = await renderQrDataUri(payload);

  const { data: inserted, error: insertError } = await service
    .from('cafeteria_credentials')
    .insert({
      ...ownerFilter,
      token_hash: toByteaHex(tokenHash) as unknown as never,
      qr_image_data_uri: qrImageDataUri,
    })
    .select('id, qr_image_data_uri')
    .single();
  if (insertError || !inserted) {
    // A unique_violation here means a concurrent request already
    // inserted one (race between this check and this insert) — treat
    // as success, not failure, same idempotent-by-construction
    // reasoning as issueMyQrCredential's own handling. Deliberately not
    // branching on the Postgres error code (e.g. 23505 unique_violation
    // vs. anything else): any insert failure triggers this recheck, and
    // the recheck itself is authoritative either way, so distinguishing
    // error codes here would add complexity without changing behavior.
    const { data: retryExisting, error: retryError } = await findExisting();
    if (retryExisting) return { outcome: 'already_exists', credentialId: retryExisting.id, qrImageDataUri: retryExisting.qr_image_data_uri };
    if (retryError) {
      return { outcome: 'error', message: `Insert failed (${insertError?.message ?? 'no row returned'}); recheck also failed: ${retryError.message}` };
    }
    return { outcome: 'error', message: insertError?.message ?? 'Insert failed' };
  }

  return { outcome: 'issued', credentialId: inserted.id, qrImageDataUri: inserted.qr_image_data_uri };
}
