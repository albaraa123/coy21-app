import { Button } from '../ui/button';

/**
 * Fails safely on access-denied. Deliberately generic: never mention the
 * page the caller was blocked from, any role/permission name, or anything
 * about the data that page would have shown. The only page-specific text on
 * screen is the caller-supplied `destination.label`, chosen by the caller
 * (not this component) so it can never leak more than the caller already
 * knows about their own permitted destination.
 */
export function UnauthorizedState({ destination }: { destination: { href: string; label: string } }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-charcoal/10 bg-warm-white p-8 text-center dark:border-gray-700 dark:bg-gray-900">
      <h2 className="text-sm font-medium text-charcoal dark:text-gray-100">Access not available</h2>
      <p className="text-sm text-charcoal/70 dark:text-gray-400">
        You don&apos;t have access to this page.
      </p>
      <div className="mt-2">
        <Button href={destination.href} size="sm">
          {destination.label}
        </Button>
      </div>
    </div>
  );
}
