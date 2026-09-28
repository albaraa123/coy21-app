// tests/attendance/disposable-database-guard.ts
//
// Shared guard for the Phase 6 QR live test suites
// (qr-issuance-reservation.test.ts, qr-credentials-lifecycle-trigger.test.ts).
// Both suites install SECURITY DEFINER test-only helpers and/or perform
// permanent state transitions (encryption-key-registry rotation) that must
// never touch a shared, staging, or production project. The default and
// only unconditional path remains local: NEXT_PUBLIC_SUPABASE_URL hostname
// must be 127.0.0.1 or localhost.
//
// A non-local hostname is permitted ONLY when every one of these holds:
//   1. PHASE6_ALLOW_DISPOSABLE_REMOTE_TESTS === 'true'
//   2. PHASE6_DISPOSABLE_PROJECT_REF is set and passes strict Supabase
//      project-ref format validation (20 lowercase alphanumeric chars)
//   3. the target URL's hostname is exactly `${ref}.supabase.co`
//      (subdomain match, not a loose substring check)
//   4. the ref is not one of the known production/staging refs listed in
//      KNOWN_NON_DISPOSABLE_PROJECT_REFS below
//
// This exists solely because local Docker is unavailable on the
// maintainer's machine right now. It does not loosen production QR
// authorization, RLS, or RPC behavior in any way — test-harness only.

const SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

// Populate with any project ref that must never be treated as disposable,
// even if someone sets the override env vars pointing at it by mistake.
// Left empty here because no production/staging ref is known to this test
// harness; add real refs if/when they become available in this repo.
const KNOWN_NON_DISPOSABLE_PROJECT_REFS: readonly string[] = [];

export interface DisposableRemoteCheckResult {
  allowed: boolean;
  hostname: string;
  reason: string;
}

function parseHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    throw new Error(`disposable-database-guard: "${rawUrl}" is not a valid URL.`);
  }
}

// Pure decision function — no throwing, no env reads — so it can be unit
// tested directly against arbitrary inputs (see disposable-database-guard.test.ts).
export function evaluateDisposableDatabaseAccess(
  rawUrl: string,
  env: {
    allowRemote?: string;
    disposableProjectRef?: string;
  },
): DisposableRemoteCheckResult {
  const hostname = parseHostname(rawUrl);

  if (hostname === '127.0.0.1' || hostname === 'localhost') {
    return { allowed: true, hostname, reason: 'local' };
  }

  if (env.allowRemote !== 'true') {
    return {
      allowed: false,
      hostname,
      reason: 'PHASE6_ALLOW_DISPOSABLE_REMOTE_TESTS is not "true"',
    };
  }

  const ref = env.disposableProjectRef ?? '';
  if (ref.length === 0 || !SUPABASE_PROJECT_REF_PATTERN.test(ref)) {
    return {
      allowed: false,
      hostname,
      reason: 'PHASE6_DISPOSABLE_PROJECT_REF is missing or not a valid 20-char lowercase alphanumeric Supabase project ref',
    };
  }

  if (KNOWN_NON_DISPOSABLE_PROJECT_REFS.includes(ref)) {
    return {
      allowed: false,
      hostname,
      reason: `project ref "${ref}" is on the known non-disposable list and can never be used for remote tests`,
    };
  }

  if (hostname !== `${ref}.supabase.co`) {
    return {
      allowed: false,
      hostname,
      reason: `NEXT_PUBLIC_SUPABASE_URL host "${hostname}" does not match PHASE6_DISPOSABLE_PROJECT_REF "${ref}" (expected host "${ref}.supabase.co")`,
    };
  }

  return { allowed: true, hostname, reason: `remote disposable project "${ref}"` };
}

// Throwing wrapper used directly by the live test suites at module load
// time. `suiteName` is only used to make the thrown error identify which
// suite refused to run.
export function assertDisposableDatabase(suiteName: string, rawUrl: string): DisposableRemoteCheckResult {
  const result = evaluateDisposableDatabaseAccess(rawUrl, {
    allowRemote: process.env.PHASE6_ALLOW_DISPOSABLE_REMOTE_TESTS,
    disposableProjectRef: process.env.PHASE6_DISPOSABLE_PROJECT_REF,
  });

  if (!result.allowed) {
    throw new Error(
      `${suiteName}: refusing to run against "${result.hostname}" — ${result.reason}. ` +
        'This suite installs SECURITY DEFINER test-only helpers and/or performs permanent state transitions ' +
        'that must never touch a shared, staging, or production project. Run against the local Supabase stack, ' +
        'or set PHASE6_ALLOW_DISPOSABLE_REMOTE_TESTS=true and PHASE6_DISPOSABLE_PROJECT_REF=<ref> for an isolated, ' +
        'disposable Supabase Cloud project created solely for this verification.',
    );
  }

  if (result.reason !== 'local') {
    console.log(
      `\nREMOTE DISPOSABLE SUPABASE TEST MODE\nProject ref: ${process.env.PHASE6_DISPOSABLE_PROJECT_REF}\nProduction data must not be present.\n`,
    );
  }

  return result;
}
