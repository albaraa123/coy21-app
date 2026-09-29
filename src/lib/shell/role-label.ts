// src/lib/shell/role-label.ts
//
// Pure mapping from a raw `user_role` enum value (profiles.role — see
// supabase/migrations/20260721200747_roles_and_profiles.sql) to the i18n
// message key that resolves to its human-readable label.
//
// Deliberately NOT a component and NOT itself a translator: it returns a
// message key (`roles.<role>`), and the caller (a Server Component that
// already has a `t` function from next-intl/server, SCOPED to the
// `shell` namespace via `getTranslations({ namespace: 'shell' })`)
// resolves it to the actual localized string. This keeps the function
// framework-free so it can be unit-tested with plain assertions (Task
// 5's established "extract the decision logic into a plain function,
// unit-test THAT" pattern for anything awkward to exercise via a full
// Server Component render — see tests/shell/logout-live.test.ts's doc
// comment for the sibling case of extracting DB-touching logic instead).
//
// NAMESPACE-RELATIVE, not fully-qualified: the keys below are
// `roles.<role>`, NOT `shell.roles.<role>`. Both current call sites
// ((admin)/layout.tsx and (participant)/(shell)/layout.tsx) already
// scope their `t` to the `shell` namespace before calling `t(key)`, so a
// fully-qualified key here would double up the namespace prefix (`t`
// would resolve `shell` + `shell.roles.participant`, i.e.
// `shell.shell.roles.participant`, which doesn't exist — this was a
// real, confirmed production crash for every authenticated user; fixed
// by making this module's contract namespace-relative to match its only
// consumers). If a future caller ever needs this key from an unscoped
// `t`, that caller is responsible for prefixing with `shell.` itself —
// do not change this module back to fully-qualified keys without also
// checking every current importer (see grep note below).
//
// The (admin)/layout.tsx and (participant)/(shell)/layout.tsx server
// components use this to build `userDisplay.roleLabel` BEFORE it crosses
// into AppShell/Topbar/UserMenu — those components must never see the
// raw enum value (see app-shell.tsx's and user-menu.tsx's doc comments
// on that boundary).
export const ROLE_LABEL_KEYS = {
  participant: 'roles.participant',
  super_admin: 'roles.super_admin',
  staff: 'roles.staff',
  scanner_device: 'roles.scanner_device',
} as const;

export type KnownUserRole = keyof typeof ROLE_LABEL_KEYS;

/**
 * Returns the namespace-relative `roles.*` message key (to be resolved
 * via a `t` already scoped to the `shell` namespace) for a given raw
 * role value, or `undefined` if the value isn't a recognized role (e.g.
 * a null/missing profile row, or a future enum value this mapping
 * hasn't been updated for yet). Callers should fall back to a safe
 * generic key rather than throwing — an unrecognized role must never
 * crash the shell.
 */
export function roleLabelKey(role: string | null | undefined): string | undefined {
  if (role == null) return undefined;
  return ROLE_LABEL_KEYS[role as KnownUserRole];
}
