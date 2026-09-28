export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div role="status" aria-label="Loading" className={`animate-pulse rounded bg-gray-200 dark:bg-gray-700 ${className}`} />;
}
