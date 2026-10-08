// src/components/shell/notification-bell.test.ts
//
// Sub-project 6, Task 7: unit tests for notification-bell.tsx's pure,
// extractable logic -- co-located per src/components/scanner/*.test.ts's
// established exception to this codebase's tests/ mirror convention
// (a Client Component with hook logic, same category).
//
// What's NOT covered here, and why: ops-dashboard-client.tsx's debounce
// (1.5s) / max-wait (5s) / 30s-fallback-poll timer structure, which this
// component mirrors closely, has no independently meaningful decision
// logic beyond "start a debounce timer on every event, and a max-wait
// timer only if one isn't already pending" -- that's a single `if
// (!maxWaitTimer)` guard already fully legible at the call site, with no
// edge cases worth exercising in isolation (unlike use-scan-retry.ts's
// nextBackoffDelayMs/isStaleAttempt, which encode real branching/capping
// logic). Extracting a one-line boolean guard into its own "pure
// function" would be a forced abstraction, not a meaningful one -- so it
// stays inline, exactly like ops-dashboard-client.tsx's own version.
//
// What IS genuinely pure and worth testing here: computing the unread
// count from a fetched notification list, and applying an optimistic
// "mark as read" update to that list after a mark_notification_read RPC
// call succeeds (two small list-transform functions, easy to get subtly
// wrong -- e.g. an off-by-one in the count, or updating the wrong row).
//
// Imported from ./notification-bell-logic, NOT ./notification-bell --
// the component module imports next-intl's useRouter (for navigating to
// a notification's link_path on click), which transitively imports
// next/navigation and fails to resolve under vitest's plain node
// environment. notification-bell-logic.ts has no such import, mirroring
// mobile-drawer-logic.ts's split from mobile-drawer.tsx for the same
// reason.
import { describe, expect, it } from 'vitest';
import { countUnread, applyOptimisticRead, type NotificationRow } from './notification-bell-logic';

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 'id-1',
    is_broadcast: false,
    channel: 'booking_confirmed',
    title: 'Title',
    body: null,
    link_path: null,
    created_at: '2026-10-08T00:00:00Z',
    is_read: false,
    ...overrides,
  };
}

describe('countUnread', () => {
  it('returns 0 for an empty list', () => {
    expect(countUnread([])).toBe(0);
  });

  it('counts only rows where is_read is false', () => {
    const rows = [row({ id: 'a', is_read: false }), row({ id: 'b', is_read: true }), row({ id: 'c', is_read: false })];
    expect(countUnread(rows)).toBe(2);
  });

  it('returns 0 when every row is already read', () => {
    const rows = [row({ id: 'a', is_read: true }), row({ id: 'b', is_read: true })];
    expect(countUnread(rows)).toBe(0);
  });
});

describe('applyOptimisticRead', () => {
  it('marks exactly the matching row as read, leaving others untouched', () => {
    const rows = [row({ id: 'a', is_read: false }), row({ id: 'b', is_read: false })];
    const next = applyOptimisticRead(rows, 'a');
    expect(next.find((r) => r.id === 'a')?.is_read).toBe(true);
    expect(next.find((r) => r.id === 'b')?.is_read).toBe(false);
  });

  it('is a no-op (new array, same read values) when the id is not found', () => {
    const rows = [row({ id: 'a', is_read: false })];
    const next = applyOptimisticRead(rows, 'does-not-exist');
    expect(next).not.toBe(rows);
    expect(next).toEqual(rows);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ id: 'a', is_read: false })];
    const next = applyOptimisticRead(rows, 'a');
    expect(rows[0].is_read).toBe(false);
    expect(next[0].is_read).toBe(true);
  });
});
