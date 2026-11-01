// Route-specific override of (admin)/loading.tsx's generic page spinner —
// this page's own content is a 7-card metric grid, fed by 7 independent
// queries run in parallel (see page.tsx's Promise.all), so a matching
// card-grid skeleton (same grid-cols-1/sm:2/lg:3 breakpoints) is a closer
// match to what's about to render than a centered spinner.
import { Skeleton } from '@/components/ui/skeleton';
import { Card } from '@/components/ui/card';

const CARD_COUNT = 7;

export default function DashboardLoading() {
  // Single live region for the whole grid — Skeleton itself carries
  // role="status" aria-label="Loading" per card, intentionally suppressed
  // here via aria-hidden so screen readers announce "Loading" once, not
  // once per card. Same fix LoadingState's own table variant applies.
  return (
    <div className="p-4 md:p-6">
      <Skeleton className="mb-4 h-5 w-48 md:mb-6" />
      <div role="status" aria-label="Loading" className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:gap-4 lg:grid-cols-3">
        {Array.from({ length: CARD_COUNT }).map((_, i) => (
          <div key={i} aria-hidden="true">
            <Card>
              <Skeleton className="mb-3 h-3 w-2/3" />
              <Skeleton className="h-7 w-1/3" />
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}
