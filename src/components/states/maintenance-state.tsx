import { Button } from '../ui/button';

export function MaintenanceState({
  title,
  description,
  retryAt,
  contactAction,
}: {
  title: string;
  description: string;
  retryAt?: string;
  contactAction?: { label: string; href: string };
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-charcoal/10 bg-warm-white p-8 text-center dark:border-gray-700 dark:bg-gray-900">
      <h2 className="text-lg font-medium text-charcoal dark:text-gray-100">{title}</h2>
      <p className="text-sm text-charcoal/70 dark:text-gray-400">{description}</p>
      {retryAt && (
        <p className="text-sm text-charcoal/60 dark:text-gray-400">
          <time dateTime={retryAt}>{retryAt}</time>
        </p>
      )}
      {contactAction && (
        <div className="mt-2">
          <Button href={contactAction.href} size="sm" variant="secondary">
            {contactAction.label}
          </Button>
        </div>
      )}
    </div>
  );
}
