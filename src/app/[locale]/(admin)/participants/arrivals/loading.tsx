// Route-specific override of (admin)/loading.tsx's generic page spinner —
// this page's own content IS a 6-column arrivals table, so a table
// skeleton is a closer match to what's about to render than a centered
// spinner. See applications/loading.tsx for the full Next.js
// per-route-loading.tsx rationale (identical pattern, different column
// count).
import { LoadingState } from '@/components/states/loading-state';

export default function ParticipantsArrivalsLoading() {
  return (
    <div className="p-4 md:p-6">
      <LoadingState variant="table" rows={8} columns={6} />
    </div>
  );
}
