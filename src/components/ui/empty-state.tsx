import type { ReactNode } from 'react';
import { Button } from './button';
import { MountReveal } from '../motion/mount-reveal';

interface EmptyStateAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: EmptyStateAction;
}) {
  // EmptyState is always conditionally rendered by its caller (e.g.
  // {items.length === 0 ? <EmptyState/> : ...}), so it's a genuinely
  // fresh mount every time it appears — a one-time fade+rise via the same
  // MountReveal used across the dashboards/list pages is a safe,
  // consistent entrance with no new client JS (MountReveal itself has no
  // 'use client'/hooks, see its own doc comment). role="status" moves onto
  // MountReveal's own div via its role prop, rather than adding a second
  // wrapper element just to keep the ARIA role.
  return (
    <MountReveal
      role="status"
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-charcoal/30 bg-warm-white p-8 text-center dark:border-gray-700"
    >
      {icon && <div className="text-charcoal/60 dark:text-gray-400">{icon}</div>}
      <p className="text-sm font-medium text-charcoal dark:text-gray-100">{title}</p>
      {description && <p className="text-sm text-charcoal/70 dark:text-gray-400">{description}</p>}
      {action && (
        <div className="mt-2">
          {action.href ? (
            <Button href={action.href} size="sm">
              {action.label}
            </Button>
          ) : (
            <Button size="sm" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      )}
    </MountReveal>
  );
}
