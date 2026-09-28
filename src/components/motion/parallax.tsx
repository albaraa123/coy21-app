'use client';

// Lightweight scroll-parallax wrapper: shifts its children vertically by
// a fraction of how far the element has scrolled through the viewport.
// Uses a single shared scroll listener via requestAnimationFrame
// (rAF-throttled) rather than one listener per instance, and does
// nothing under prefers-reduced-motion (children render in their normal
// position, unanimated).
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

export function Parallax({
  children,
  strength = 0.15,
  className,
  style,
}: {
  children: ReactNode;
  strength?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let ticking = false;

    function update() {
      ticking = false;
      const rect = node!.getBoundingClientRect();
      const viewportCenter = window.innerHeight / 2;
      const elementCenter = rect.top + rect.height / 2;
      const offset = (viewportCenter - elementCenter) * strength;
      node!.style.transform = `translateY(${offset}px)`;
    }

    function onScroll() {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    }

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [strength]);

  return (
    <div ref={ref} className={className} style={{ willChange: 'transform', ...style }}>
      {children}
    </div>
  );
}
