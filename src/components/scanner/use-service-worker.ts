// src/components/scanner/use-service-worker.ts
//
// Phase 7E — registers the scanner's minimal shell-asset service worker
// (src/app/sw.js/route.ts) once, scoped to /scanner only. Deliberately
// NOT registered site-wide from a root layout: the rest of the app has
// no PWA requirement, and keeping registration scanner-scoped keeps the
// blast radius of "something in the SW misbehaves" limited to the one
// route that actually needs installability. Registration failure
// (unsupported browser, non-HTTPS context in local dev, etc.) is
// swallowed — a service worker is a pure enhancement here, never a
// precondition for the scanner to function.
'use client';

import { useEffect } from 'react';

export function useServiceWorker(): void {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }, []);
}
