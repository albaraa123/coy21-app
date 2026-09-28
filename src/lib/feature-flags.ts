// src/lib/feature-flags.ts
//
// Simple env-var-backed feature flags. No DB-backed flag infrastructure
// exists in this codebase; an env var is sufficient for "explicitly enabled
// through configuration" gates like the legacy self-registration flow below.

export function isSelfRegistrationEnabled(): boolean {
  return process.env.ENABLE_SELF_REGISTRATION === 'true';
}
