// Purely decorative, aria-hidden organic background shape. Pointer-events
// disabled so it never intercepts clicks/taps on real content stacked
// above it. Color is passed in so callers can vary it per section
// (turquoise/green/gold) without a new component per hue.
export function Blob({
  color,
  className = '',
}: {
  color: 'turquoise' | 'green' | 'gold';
  className?: string;
}) {
  const colorVar = `var(--color-${color})`;
  return (
    <div
      aria-hidden="true"
      className={`animate-blob pointer-events-none absolute -z-10 rounded-full blur-3xl ${className}`}
      style={{ background: colorVar, opacity: 0.18 }}
    />
  );
}
