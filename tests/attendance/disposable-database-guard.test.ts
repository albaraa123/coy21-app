// tests/attendance/disposable-database-guard.test.ts
//
// Pure unit coverage for evaluateDisposableDatabaseAccess() — the shared
// guard that qr-issuance-reservation.test.ts and
// qr-credentials-lifecycle-trigger.test.ts both call before doing anything
// else. No network access, no Supabase client, no database: this only
// proves the decision function itself is correct, independent of whether a
// live database (local or remote) is reachable at all.
import { describe, expect, it } from 'vitest';
import { evaluateDisposableDatabaseAccess } from './disposable-database-guard';

const DISPOSABLE_REF = 'abcdefghijklmnopqrst'; // 20 lowercase alphanumeric chars

describe('evaluateDisposableDatabaseAccess', () => {
  it('allows localhost with no override present at all', () => {
    const result = evaluateDisposableDatabaseAccess('http://localhost:54321', {});
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('local');
  });

  it('allows 127.0.0.1 with no override present at all', () => {
    const result = evaluateDisposableDatabaseAccess('http://127.0.0.1:54321', {});
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('local');
  });

  it('rejects an arbitrary remote Supabase URL with no overrides set', () => {
    const result = evaluateDisposableDatabaseAccess(`https://${DISPOSABLE_REF}.supabase.co`, {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/PHASE6_ALLOW_DISPOSABLE_REMOTE_TESTS/);
  });

  it('rejects a remote URL when only the boolean override is set (no project ref)', () => {
    const result = evaluateDisposableDatabaseAccess(`https://${DISPOSABLE_REF}.supabase.co`, {
      allowRemote: 'true',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/PHASE6_DISPOSABLE_PROJECT_REF/);
  });

  it('rejects a remote URL when the project ref does not match the URL hostname', () => {
    const result = evaluateDisposableDatabaseAccess(`https://${DISPOSABLE_REF}.supabase.co`, {
      allowRemote: 'true',
      disposableProjectRef: 'zzzzzzzzzzzzzzzzzzzz',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/does not match/);
  });

  it('rejects a malformed project ref even if it happens to match a (fake) hostname', () => {
    const badRef = 'not-a-valid-ref';
    const result = evaluateDisposableDatabaseAccess(`https://${badRef}.supabase.co`, {
      allowRemote: 'true',
      disposableProjectRef: badRef,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/valid 20-char/);
  });

  it('accepts the exact disposable project URL with matching boolean override and project ref', () => {
    const result = evaluateDisposableDatabaseAccess(`https://${DISPOSABLE_REF}.supabase.co`, {
      allowRemote: 'true',
      disposableProjectRef: DISPOSABLE_REF,
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain(DISPOSABLE_REF);
  });

  it('rejects a hostname crafted to substring-match a valid ref (subdomain confusion)', () => {
    // e.g. an attacker-controlled or accidental host like
    // "abcdefghijklmnopqrst.supabase.co.evil.example.com" must not pass
    // just because it starts with the expected subdomain.
    const result = evaluateDisposableDatabaseAccess(`https://${DISPOSABLE_REF}.supabase.co.evil.example.com`, {
      allowRemote: 'true',
      disposableProjectRef: DISPOSABLE_REF,
    });
    expect(result.allowed).toBe(false);
  });

  it('throws a clear error for a malformed URL rather than silently rejecting', () => {
    expect(() => evaluateDisposableDatabaseAccess('not a url', {})).toThrow(/not a valid URL/);
  });
});
