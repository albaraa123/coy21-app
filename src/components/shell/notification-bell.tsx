'use client';

// src/components/shell/notification-bell.tsx
//
// Sub-project 6 (notifications layer), Task 7 -- the participant-shell
// notification bell. See docs/superpowers/specs/2026-10-08-notifications-
// layer-design.md ("Architecture -- Realtime (the bell)") for the full
// design.
//
// Structural precedent: src/app/[locale]/(admin)/attendance/ops-dashboard/
// ops-dashboard-client.tsx -- one Supabase browser client via
// useState(() => createClient()), a single shared request-id-guarded
// fetch helper, a Realtime subscription effect (1.5s debounce / 5s
// max-wait) and an independent 30s fallback poll. Copied closely rather
// than re-derived, per this task's brief.
//
// Two differences from that precedent, both load-bearing:
//   1. Two Realtime channels instead of one -- the caller's own personal
//      channel (notifications-${applicationId}) AND the shared
//      notifications-broadcast channel, both { config: { private: true } }
//      (must match notify_participant_notification()'s `true` private
//      flag on the trigger side -- see
//      supabase/migrations/20261008030000_notifications_realtime_broadcast.sql).
//   2. applicationId can be null defensively (this component is only ever
//      mounted inside the participant shell, where a signed-in user
//      should always have exactly one applications row -- but the layout
//      that instantiates this component queries for it and could find
//      none, e.g. a data inconsistency or a race right after account
//      creation). When null, the personal-channel subscription and the
//      personal half of the feed are simply skipped -- the component
//      still renders (broadcast-only), never throws.
//
// Open/close interaction pattern mirrors UserMenu exactly (./user-menu.tsx):
// useState open flag, containerRef wrapping both toggle button and panel,
// close on outside pointerdown AND Escape via isEscapeKey from
// ./mobile-drawer-logic, role="menu"/aria-haspopup/aria-expanded.
//
// Pure, exported, independently-tested helpers (countUnread,
// applyOptimisticRead, the NotificationRow type) live in
// ./notification-bell-logic.ts, NOT in this file -- that module has no
// next-intl/next/navigation imports, so it can be unit-tested under
// vitest's node environment (see notification-bell.test.ts and that
// module's own header comment for why: next-intl's useRouter below
// transitively imports next/navigation, which fails to resolve outside a
// real Next.js runtime, exactly the problem mobile-drawer-logic.ts was
// split out of mobile-drawer.tsx to avoid). Everything else in this file
// is either plain JSX or timer/Realtime wiring that mirrors ops-dashboard-
// client.tsx's own (untested-in-isolation, by the same precedent)
// stateful effects.
//
// Manual verification note (no browser automation in this environment,
// per this project's own standing practice -- see
// mobile-drawer-logic.ts's identical caveat): the pure logic
// (notification-bell.test.ts) and the get_my_notifications() RPC itself
// (tests/attendance/get-my-notifications-live.test.ts) are verified
// against the real DB. Realtime delivery (both channels actually
// receiving a broadcast and triggering a refetch) and this component's
// own visual rendering (panel open/close, unread badge, row styling) were
// NOT browser-verified -- say so plainly rather than implying more.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from '@/i18n/routing';
import { isEscapeKey } from './mobile-drawer-logic';
import { countUnread, applyOptimisticRead, type NotificationRow } from './notification-bell-logic';

export type { NotificationRow };

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

export interface NotificationBellProps {
  applicationId: string | null;
}

export function NotificationBell({ applicationId }: NotificationBellProps) {
  const t = useTranslations('shell');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // One Supabase browser client for this component's whole lifetime,
  // shared by fetchNotifications and the Realtime effect below -- see
  // ops-dashboard-client.tsx's identical comment for why useState's lazy
  // initializer is used instead of useRef (react-hooks/refs forbids
  // reading ref.current during render, even guarded).
  const [supabase] = useState(() => createClient());

  // Monotonically-increasing request-id guard, shared by the debounced
  // Realtime handler and the 30s poll -- same purpose as
  // ops-dashboard-client.tsx's requestIdRef: a slow-resolving stale
  // response can never clobber a fresher one already applied.
  const requestIdRef = useRef(0);

  const fetchNotifications = useCallback(async () => {
    requestIdRef.current += 1;
    const thisRequestId = requestIdRef.current;
    const { data, error } = await supabase.rpc('get_my_notifications');
    if (error) {
      // Transient failure (e.g. a dropped connection) -- the next poll or
      // broadcast will retry. Nothing actionable to show the user for a
      // background refresh failure; warn so a "bell looks frozen" report
      // is debuggable in prod logs.
      console.warn('notification bell refresh failed:', error.message);
      return;
    }
    if (thisRequestId !== requestIdRef.current) {
      // A newer request was issued while this one was in flight -- discard
      // this now-stale response silently.
      return;
    }
    setRows(data ?? []);
  }, [supabase]);

  // Initial load on mount.
  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  // Realtime subscription: personal channel (skipped entirely when
  // applicationId is null -- defensive guard per the task brief, this
  // component is only ever mounted with a real application id in
  // practice) and the shared broadcast channel. Debounced ~1.5s with a
  // 5s max-wait, mirroring ops-dashboard-client.tsx's reasoning exactly:
  // a trailing-edge debounce alone can starve under sustained broadcast
  // traffic, so maxWaitTimer forces a refresh at least every 5s while
  // events keep arriving.
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

    const triggerFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (maxWaitTimer) clearTimeout(maxWaitTimer);
      debounceTimer = null;
      maxWaitTimer = null;
      void fetchNotifications();
    };

    const handleBroadcast = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(triggerFetch, 1500);
      if (!maxWaitTimer) maxWaitTimer = setTimeout(triggerFetch, 5000);
    };

    const channels: ReturnType<typeof supabase.channel>[] = [];

    // private: true is REQUIRED -- Realtime only checks the
    // realtime.messages RLS policy for private channels. Must match
    // notify_participant_notification()'s `true` private flag on the
    // trigger side -- both ends have to agree (see
    // 20261008030000_notifications_realtime_broadcast.sql).
    if (applicationId) {
      const personalChannel = supabase.channel(`notifications-${applicationId}`, { config: { private: true } });
      personalChannel.on('broadcast', { event: 'change' }, handleBroadcast);
      personalChannel.subscribe();
      channels.push(personalChannel);
    }

    const broadcastChannel = supabase.channel('notifications-broadcast', { config: { private: true } });
    broadcastChannel.on('broadcast', { event: 'change' }, handleBroadcast);
    broadcastChannel.subscribe();
    channels.push(broadcastChannel);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (maxWaitTimer) clearTimeout(maxWaitTimer);
      channels.forEach((channel) => void supabase.removeChannel(channel));
    };
  }, [supabase, fetchNotifications, applicationId]);

  // 30s fallback poll, independent of Realtime -- same two-layer
  // resilience as ops-dashboard-client.tsx.
  useEffect(() => {
    const intervalId = setInterval(() => {
      void fetchNotifications();
    }, 30000);
    return () => clearInterval(intervalId);
  }, [fetchNotifications]);

  // Close on outside pointerdown or Escape -- identical pattern to
  // UserMenu (./user-menu.tsx).
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isEscapeKey(event.key)) {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Clicking a row marks it read AND navigates to its link_path, per the
  // design spec's "link_path — relative in-app path the bell navigates to
  // on click" (Architecture — Database, `notifications` table). A row
  // with no link_path (e.g. a plain announcement with nothing to deep
  // link to) only marks read and closes the panel.
  async function handleRowClick(notificationId: string, linkPath: string | null) {
    // Optimistic update first -- mirrors the responsiveness users expect
    // from a read/unread toggle; a failed RPC call just leaves the row's
    // true server-side state to be corrected by the next fetch (poll or
    // broadcast), same "eventually consistent, never blocking" posture as
    // the rest of this component's refresh model.
    setRows((current) => applyOptimisticRead(current, notificationId));
    setOpen(false);
    if (linkPath) {
      router.push(linkPath);
    }
    const { error } = await supabase.rpc('mark_notification_read', { p_notification_id: notificationId });
    if (error) {
      console.warn('mark_notification_read failed:', error.message);
    }
  }

  const unreadCount = countUnread(rows);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('notifications.triggerAriaLabel')}
        className="relative rounded-md p-2 text-charcoal/70 hover:bg-charcoal/5 hover:text-charcoal"
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" aria-hidden="true">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white"
          >
            {/* Capped at "9+" purely so the badge never outgrows its fixed
                h-4/min-w-4 circle at this participant-scale notification
                volume -- no spec requirement drives this number, it's a
                layout constraint, not a product decision. */}
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('notifications.panelLabel')}
          className="absolute end-0 z-10 mt-2 w-80 max-h-96 overflow-y-auto rounded-md border border-charcoal/10 bg-warm-white p-1 shadow-lg"
        >
          {rows.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-charcoal/60">{t('notifications.empty')}</p>
          ) : (
            <ul className="flex flex-col">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => handleRowClick(row.id, row.link_path)}
                    className={`w-full rounded-md px-3 py-2 text-start text-sm ${
                      row.is_read ? 'text-charcoal/60' : 'bg-gold/10 font-medium text-charcoal'
                    } hover:bg-charcoal/5`}
                  >
                    <span className="block">{row.title}</span>
                    {row.body && <span className="mt-0.5 block text-xs text-charcoal/60">{row.body}</span>}
                    <span className="mt-1 block text-xs text-charcoal/40">{formatTimestamp(row.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
