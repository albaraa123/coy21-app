// src/components/scanner/use-wake-lock.ts
//
// Screen Wake Lock API as pure progressive enhancement — keeps the
// screen awake while the scanner is the active tab, so an operator
// scanning a line of participants doesn't have the screen dim/lock
// between scans. Every call is wrapped so an unsupported API,
// permission failure, or revoked lock (the OS pages this frequently)
// never throws back into the scanner flow — this hook's correctness
// requirement is "never breaks the scanner," not "always keeps the
// screen on."
'use client';

import { useEffect, useRef } from 'react';

type WakeLockSentinelLike = { released: boolean; release: () => Promise<void> };
type NavigatorWithWakeLock = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } };

export function useWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === 'undefined') return;
    const nav = navigator as NavigatorWithWakeLock;
    if (!nav.wakeLock) return;

    let cancelled = false;

    async function acquire() {
      try {
        const sentinel = await nav.wakeLock!.request('screen');
        if (cancelled) {
          // Component became inactive/unmounted while the request was
          // in flight — release immediately rather than holding a lock
          // nothing wants anymore.
          void sentinel.release().catch(() => {});
          return;
        }
        sentinelRef.current = sentinel;
      } catch {
        // Unsupported, denied, or the page isn't visible — a wake lock
        // is a convenience only, never a scanning precondition.
      }
    }

    async function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && !sentinelRef.current) {
        await acquire();
      }
    }

    void acquire();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel && !sentinel.released) {
        void sentinel.release().catch(() => {});
      }
    };
  }, [active]);
}
