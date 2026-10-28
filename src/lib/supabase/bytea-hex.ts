// src/lib/supabase/bytea-hex.ts
//
// PostgREST bytea encoding: supabase-js JSON-serializes a raw Node Buffer
// as {"type":"Buffer","data":[...]}, which is NOT a valid bytea literal.
// Postgres/PostgREST's own `\x` + hex text representation is required for
// both RPC arguments and .eq(...) filters on bytea columns -- passing a raw
// Buffer to either silently produces a hash that matches no row. Previously
// duplicated verbatim across qr-credential-issuance.ts, lunch-scan.ts,
// credential-issuance.ts, coffee-scan.ts, and (as a null-safe variant)
// scan-qr-attempt.ts; consolidated here.
export function toByteaHex(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

export function toByteaHexOrNull(buf: Buffer | null): string | null {
  return buf ? toByteaHex(buf) : null;
}

export function fromByteaHex(value: string): Buffer {
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  return Buffer.from(hex, 'hex');
}
