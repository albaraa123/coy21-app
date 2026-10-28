// src/lib/cafeteria/coffee-scan.ts
//
// Trusted server boundary for the coffee-break credit flow — mirrors
// src/lib/cafeteria/lunch-scan.ts's shape exactly, but exposes two
// functions (balance check, then deduction) instead of one, matching
// the two-RPC design (design spec's "Scan Flow — Two RPCs, Not One").
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { parseCanonicalCafeteriaPayload, hashCafeteriaToken } from './token';
import { toByteaHex } from '@/lib/supabase/bytea-hex';

type ServiceClient = SupabaseClient<Database>;

export interface CoffeeBalanceResult {
  eligible: boolean;
  remainingBalance: number | null; // null only when eligible=false (no meaningful balance to show)
}

export interface CoffeeDeductionResult {
  result: 'deducted' | 'insufficient_balance' | 'ineligible' | 'invalid_qr';
  amountDeducted: number | null;
  scanId: string | null;
}

// Note (implementer choice, per plan footnote): lunch-scan.ts does not
// extract a shared helper for its one credential-resolution call site, and
// this file has two call sites with near-identical resolution logic. Kept
// as inline duplication in both exported functions below anyway, matching
// lunch-scan.ts's existing style exactly rather than introducing a new
// shared helper — no resolveCredentialId helper in this file.

export async function checkCafeteriaCoffeeBalanceForCaller(
  params: { qrPayload: string },
  caller: { service: ServiceClient }
): Promise<{ ok: true; result: CoffeeBalanceResult | { eligible: false; remainingBalance: null; invalidQr: true } } | { ok: false; message: string }> {
  const parsed = parseCanonicalCafeteriaPayload(params.qrPayload);
  if (!parsed.ok) {
    return { ok: true, result: { eligible: false, remainingBalance: null, invalidQr: true } };
  }

  const tokenHashHex = toByteaHex(hashCafeteriaToken(parsed.rawToken));
  const { data: credential, error: credError } = await caller.service
    .from('cafeteria_credentials')
    .select('id')
    .eq('token_hash', tokenHashHex)
    .maybeSingle();
  if (credError) return { ok: false, message: credError.message };
  if (!credential) {
    return { ok: true, result: { eligible: false, remainingBalance: null, invalidQr: true } };
  }

  const { data, error } = await caller.service.rpc('cafeteria_coffee_check_balance', { p_token_hash: tokenHashHex });
  if (error) return { ok: false, message: error.message };

  const row = data?.[0];
  return {
    ok: true,
    result: { eligible: row?.eligible ?? false, remainingBalance: row?.eligible ? Number(row.remaining_balance) : null },
  };
}

export async function confirmCafeteriaCoffeeDeductionForCaller(
  params: { qrPayload: string; amount: number },
  caller: { userId: string; service: ServiceClient }
): Promise<{ ok: true; result: CoffeeDeductionResult } | { ok: false; message: string }> {
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    return { ok: false, message: 'Amount must be a positive number' };
  }

  const parsed = parseCanonicalCafeteriaPayload(params.qrPayload);
  if (!parsed.ok) {
    return { ok: true, result: { result: 'invalid_qr', amountDeducted: null, scanId: null } };
  }

  const tokenHashHex = toByteaHex(hashCafeteriaToken(parsed.rawToken));
  const { data: credential, error: credError } = await caller.service
    .from('cafeteria_credentials')
    .select('id')
    .eq('token_hash', tokenHashHex)
    .maybeSingle();
  if (credError) return { ok: false, message: credError.message };
  if (!credential) {
    return { ok: true, result: { result: 'invalid_qr', amountDeducted: null, scanId: null } };
  }

  const { data, error } = await caller.service.rpc('cafeteria_coffee_deduct_transactional', {
    p_token_hash: tokenHashHex,
    p_scanned_by: caller.userId,
    p_amount: params.amount,
  });
  if (error) return { ok: false, message: error.message };

  return {
    ok: true,
    result: {
      result: data.result as CoffeeDeductionResult['result'],
      amountDeducted: data.amount_deducted !== null ? Number(data.amount_deducted) : null,
      scanId: data.id,
    },
  };
}
