// src/app/[locale]/scanner/layout.tsx
//
// Minimal, mobile-first, kiosk-style wrapper for /scanner — mirrors
// (participant)/(bare)/layout.tsx's exact pattern: a small branded
// header, no sidebar/topbar/nav, and NO auth check of its own. page.tsx
// performs the real, trusted server-side authorization
// (requireScannerDeviceCaller) and renders the appropriate state itself;
// this layout is chrome-only, same division of responsibility as the
// (bare) layout it mirrors.
import Image from 'next/image';

export default function ScannerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-warm-white dark:bg-gray-950">
      <header
        className="flex items-center justify-center border-b border-charcoal/10 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <Image
          src="/brand/logo/logo-horizontal-color.svg"
          alt="COY21 Türkiye 2026"
          width={140}
          height={28}
          className="h-7 w-auto"
          priority
        />
      </header>
      {/* pb accounts for the iOS home indicator / Android gesture bar so
          the Scan Next / manual-entry controls near the bottom of the
          scanner card are never partially covered in standalone mode. */}
      <main
        className="flex flex-1 flex-col items-center justify-center px-4 py-6"
        style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
