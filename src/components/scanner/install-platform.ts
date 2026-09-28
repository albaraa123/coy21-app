// src/components/scanner/install-platform.ts
//
// Pure platform/standalone-detection logic extracted from
// install-guidance.tsx specifically so it's unit-testable without a
// React renderer or next-intl provider — same "extract the decision
// logic, unit-test that" convention as scan-state-machine.ts.
export type InstallPlatform = 'ios' | 'android' | 'other';

export function detectInstallPlatform(userAgent: string | undefined): InstallPlatform {
  if (!userAgent) return 'other';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return 'other';
}
