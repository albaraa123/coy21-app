// src/components/scanner/device-identifier.ts
//
// Client-side, convenience-only device label — NOT a credential. Per the
// approved Phase 7C decision: device_identifier (scan_attempts/
// attendance_records column) has zero constraints/validation/
// authorization role anywhere in the schema or RPCs; it is stored purely
// as an audit label alongside scanned_by (the real identity, derived
// server-side from the authenticated session via requireScannerDeviceCaller).
// Possession of this value grants no authority whatsoever — clearing
// localStorage and getting a fresh id is explicitly acceptable, and
// verifyScannerScope/requireScannerDeviceCaller remain the sole
// authorization gates, completely independent of this value.
const STORAGE_KEY = 'rcoy-scanner-device-id';

/**
 * Returns a stable per-browser identifier, generating and persisting one
 * on first use. Falls back to null (never throws, never blocks scanner
 * operation) if localStorage is unavailable — e.g. private browsing
 * modes that disable it, or a non-browser environment.
 */
export function getOrCreateDeviceIdentifier(): string | null {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const generated = crypto.randomUUID();
    window.localStorage.setItem(STORAGE_KEY, generated);
    return generated;
  } catch {
    return null;
  }
}
