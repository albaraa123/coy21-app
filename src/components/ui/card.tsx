import type { CSSProperties, ReactNode } from 'react';

export function Card({
  children,
  className = '',
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`rounded-lg border border-charcoal/10 bg-warm-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900 ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}
