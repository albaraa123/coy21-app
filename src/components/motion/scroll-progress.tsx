'use client';

import { useEffect, useState } from 'react';

// A thin gradient bar fixed to the very top of the viewport that fills as
// the visitor scrolls the page — a lightweight "living page" cue. Pure
// CSS transform (scaleX), no layout thrash; updates via a passive scroll
// listener. Respects prefers-reduced-motion by simply not rendering,
// since a static full/empty bar would be meaningless without the motion
// it exists to provide.
export function ScrollProgress() {
  const [progress, setProgress] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(mql.matches);
    const onChange = () => setReduceMotion(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (reduceMotion) return;
    const onScroll = () => {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(docHeight > 0 ? Math.min(1, scrollTop / docHeight) : 0);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [reduceMotion]);

  if (reduceMotion) return null;

  return (
    <div aria-hidden="true" className="fixed inset-x-0 top-0 z-50 h-1 bg-transparent">
      <div
        className="h-full origin-left bg-gradient-to-r from-turquoise via-green to-gold"
        style={{ transform: `scaleX(${progress})`, transition: 'transform 80ms linear' }}
      />
    </div>
  );
}
