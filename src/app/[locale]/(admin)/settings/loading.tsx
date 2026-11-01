// Route-specific override of (admin)/loading.tsx's generic page spinner —
// this page's own content is two stacked form cards (SettingsForm,
// ConferenceSettingsForm — see page.tsx), each fed by its own single-row
// settings query, so a two-block skeleton is a closer match to what's
// about to render than a centered spinner.
import { Skeleton } from '@/components/ui/skeleton';
import { Card } from '@/components/ui/card';

export default function SettingsLoading() {
  // Single live region for the whole skeleton — Skeleton itself carries
  // role="status" aria-label="Loading" per block, intentionally suppressed
  // here via aria-hidden so screen readers announce "Loading" once, not
  // once per block. Same fix LoadingState's own table variant applies.
  return (
    <div className="p-4 md:p-6">
      <div role="status" aria-label="Loading" className="flex flex-col gap-6">
        <div aria-hidden="true">
          <Card>
            <div className="flex flex-col gap-3">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          </Card>
        </div>
        <div aria-hidden="true">
          <Card>
            <div className="flex flex-col gap-3">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-9 w-full" />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
