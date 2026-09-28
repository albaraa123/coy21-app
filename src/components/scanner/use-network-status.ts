// src/components/scanner/use-network-status.ts
//
// Phase 7E — the scanner is explicitly ONLINE-ONLY (no offline
// admission queue, no local optimistic success — see the Phase 7E
// brief and docs/superpowers/specs/2026-07-31-flexible-admission-qr-
// attendance-design.md's own warning against local "optimistic"
// admission causing double-booking on reconnect). This hook only
// tracks the browser's own connectivity signal; it never predicts
// server reachability beyond what navigator.onLine promises, which is
// itself a weak/best-effort signal (it can read true on a captive
// portal or dead Wi-Fi) — that weakness is exactly why the *result* of
// a submission attempt (see scanner-client.tsx's isRequestUncertain
// classification) is treated as more authoritative than this flag
// alone, not less.
'use client';

import { useEffect, useState } from 'react';

export type NetworkStatus = 'online' | 'offline';

// Exported so the underlying connectivity-reading decision can be unit
// tested directly, without a React renderer — same "extract the
// decision logic, unit-test that" convention as scan-state-machine.ts.
export function readNetworkStatus(): NetworkStatus {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return 'online';
  return navigator.onLine ? 'online' : 'offline';
}

export function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>('online');

  useEffect(() => {
    setStatus(readNetworkStatus());
    const handleOnline = () => setStatus('online');
    const handleOffline = () => setStatus('offline');
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return status;
}
