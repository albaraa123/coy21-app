// src/lib/cafeteria/lunch-scan.ts
//
// Trusted server boundary for cafeteria scan submission — mirrors
// src/lib/attendance/scan-qr-attempt.ts's shape exactly (parse payload
// here, call the RPC, never trust client-supplied eligibility/result).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { parseCanonicalCafeteriaPayload, hashCafeteriaToken } from './token';

type ServiceClient = SupabaseClient<Database>;

export interface CafeteriaScanResult {
  result: 'admitted' | 'already_used_today' | 'ineligible' | 'invalid_qr';
  scanId: string | null;
}

// PostgREST bytea encoding: supabase-js JSON-serializes a raw Node Buffer
// as {"type":"Buffer","data":[...]}, which is NOT a valid bytea literal.
// Same `\x` + hex convention this codebase already uses in
// src/lib/attendance/qr-credential-issuance.ts's toByteaHex,
// src/lib/attendance/scan-qr-attempt.ts's toByteaHexOrNull, and
// src/lib/cafeteria/credential-issuance.ts's own copy of it. Required for
// BOTH the .eq('token_hash', ...) filter below and the p_token_hash RPC
// argument — passing the raw Buffer to either would silently produce a
// hash that matches no row.
function toByteaHex(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

export async function confirmCafeteriaLunchScanForCaller(
  params: { qrPayload: string },
  caller: { userId: string; service: ServiceClient }
): Promise<{ ok: true; result: CafeteriaScanResult } | { ok: false; message: string }> {
  const parsed = parseCanonicalCafeteriaPayload(params.qrPayload);
  if (!parsed.ok) {
    return { ok: true, result: { result: 'invalid_qr', scanId: null } };
  }

  const tokenHash = hashCafeteriaToken(parsed.rawToken);
  const tokenHashHex = toByteaHex(tokenHash);

  // Resolve the credential first (outside the RPC) so an unknown token
  // never reaches cafeteria_lunch_scan_transactional at all — that
  // function raises on an unresolvable hash by design (Task 3), not
  // returns a row, so this check must happen here.
  const { data: credential, error: credError } = await caller.service
    .from('cafeteria_credentials')
    .select('id')
    .eq('token_hash', tokenHashHex)
    .maybeSingle();
  if (credError) return { ok: false, message: credError.message };
  if (!credential) return { ok: true, result: { result: 'invalid_qr', scanId: null } };

  const { data, error } = await caller.service.rpc('cafeteria_lunch_scan_transactional', {
    p_token_hash: tokenHashHex,
    p_scanned_by: caller.userId,
  });
  if (error) return { ok: false, message: error.message };

  return { ok: true, result: { result: data.result as CafeteriaScanResult['result'], scanId: data.id } };
}
