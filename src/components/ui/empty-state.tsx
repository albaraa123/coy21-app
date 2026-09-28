import type { ReactNode } from 'react';
import { Button } from './button';

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
  return (
    <div
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
    </div>
  );
}
