// src/components/shell/notification-bell-logic.ts
//
// Pure, router/next-intl-free logic split out of notification-bell.tsx so
// it can be unit-tested under vitest's node environment without pulling
// in next/navigation (which next-intl's useRouter/createNavigation
// transitively imports, and which fails to resolve outside a Next.js
// runtime -- same "extract the pure logic into its own import-light
// module" convention as mobile-drawer-logic.ts, split out of
// mobile-drawer.tsx for the identical reason).
import type { Database } from '@/types/database';

// supabase gen types declares `body`/`link_path` as non-nullable `string`
// for this `returns table` function, which doesn't match reality: both
// columns are nullable in the notifications table itself (see
// supabase/migrations/20261008010000_notifications_table.sql), and
// get_my_notifications() selects them straight through with no coalesce.
// Widened back to `| null` here so the component (and this file's own
// tests) handle a real null body/link_path correctly rather than trusting
// a generated type that's wrong on this point.
export type NotificationRow = Omit<
  Database['public']['Functions']['get_my_notifications']['Returns'][number],
  'body' | 'link_path'
> & {
  body: string | null;
  link_path: string | null;
};

/** Count of rows not yet read -- drives the bell's badge. */
export function countUnread(rows: readonly NotificationRow[]): number {
  return rows.reduce((count, row) => (row.is_read ? count : count + 1), 0);
}

/**
 * Returns a NEW array with the row matching `notificationId` marked read,
 * leaving every other row untouched. A no-op (new array, same values) if
 * no row matches -- never throws, never mutates the input.
 */
export function applyOptimisticRead(rows: readonly NotificationRow[], notificationId: string): NotificationRow[] {
  return rows.map((row) => (row.id === notificationId ? { ...row, is_read: true } : row));
}
