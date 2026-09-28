'use client';

// Fade+rise transition between public-site route changes. Keyed on the
// pathname so React remounts (and thus replays the CSS animation) on
// every navigation. Content is never hidden — the animation only affects
// opacity/transform on an already-rendered tree, so this stays safe for
// crawlers and no-JS clients (same principle as Reveal).
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="animate-page-enter">
      {children}
    </div>
  );
}
