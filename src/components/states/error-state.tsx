import { Button } from '../ui/button';

export function ErrorState({
  title,
  description,
  onRetry,
  errorId,
  technicalDetail,
  announce = false,
}: {
  title: string;
  description?: string;
  onRetry?: () => void;
  errorId?: string;
  technicalDetail?: string;
  announce?: boolean;
}) {
  return (
    <div
      {...(announce ? { role: 'alert' } : {})}
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-charcoal/10 bg-warm-white p-8 text-center dark:border-gray-700 dark:bg-gray-900"
    >
      <h2 className="text-sm font-medium text-charcoal dark:text-gray-100">{title}</h2>
      {description && <p className="text-sm text-charcoal/70 dark:text-gray-400">{description}</p>}
      {onRetry && (
        <div className="mt-2">
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
      {errorId && <p className="mt-2 text-xs text-charcoal/50 dark:text-gray-500">{errorId}</p>}
      {technicalDetail && (
        <details className="mt-2 w-full text-left text-xs text-charcoal/60 dark:text-gray-400">
          <summary className="cursor-pointer">Technical details</summary>
          <pre className="mt-1 whitespace-pre-wrap">{technicalDetail}</pre>
        </details>
      )}
    </div>
  );
}
