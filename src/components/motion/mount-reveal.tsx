// Fade+rise-on-mount for content that's already in the viewport when a
// page loads (dashboard cards, stat tiles) — as opposed to Reveal
// (./reveal.tsx), which is scroll-triggered via IntersectionObserver for
// long marketing pages where content starts off-screen. Above-the-fold
// dashboard content is visible immediately, so there is nothing to wait
// to scroll into view; this instead plays unconditionally via a CSS
// animation, staggered by `delayMs` so a row of cards cascades in rather
// than popping in as one block. Reuses the same reveal-fade-up keyframe/
// [data-reveal='visible'] CSS Reveal already defines in globals.css
// (including its prefers-reduced-motion no-op), so both components share
// one animation definition and one reduced-motion guard.
//
// Deliberately a plain function, no 'use client': unlike Reveal (which
// needs IntersectionObserver/useState/useRef to detect scroll-into-view),
// this component holds no state and runs no effect — it statically emits
// data-reveal="visible" every render, so it works directly from a Server
// Component (both dashboard pages this was built for are Server
// Components) with zero client JS shipped for it.
import type { AriaRole, CSSProperties, ReactNode } from 'react';

export function MountReveal({
  children,
  delayMs = 0,
  className,
  style,
  role,
}: {
  children: ReactNode;
  delayMs?: number;
  className?: string;
  style?: CSSProperties;
  /** Forwarded straight to the rendered div — lets a caller (e.g. EmptyState) keep its own ARIA role on the same element MountReveal animates, instead of needing an extra wrapper. */
  role?: AriaRole;
}) {
  return (
    <div data-reveal="visible" role={role} style={{ ...style, animationDelay: `${delayMs}ms` }} className={className}>
      {children}
    </div>
  );
}
