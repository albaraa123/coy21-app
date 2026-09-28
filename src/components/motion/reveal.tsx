'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

// Scroll-triggered fade-up reveal for public marketing pages. Renders its
// children unconditionally (no display:none, no SSR/no-JS penalty) — the
// data-reveal attribute only ever toggles a CSS animation defined in
// globals.css, which itself no-ops under prefers-reduced-motion. Content
// is never hidden from crawlers or JS-disabled clients; only the visual
// entrance is deferred for a user who can actually see the animation.
export function Reveal({
  children,
  delayMs = 0,
  className,
  style,
}: {
  children: ReactNode;
  delayMs?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-reveal={visible ? 'visible' : 'hidden'}
      style={visible ? { ...style, animationDelay: `${delayMs}ms` } : style}
      className={className}
    >
      {children}
    </div>
  );
}
