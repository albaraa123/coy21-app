// Route-specific override of (admin)/loading.tsx's generic page spinner —
// this page's own content IS an 8-column sessions table, so a table
// skeleton is a closer match to what's about to render than a centered
// spinner. See applications/loading.tsx for the full Next.js
// per-route-loading.tsx rationale (identical pattern, different column
// count).
import { LoadingState } from '@/components/states/loading-state';

export default function AgendaSessionsLoading() {
  return (
    <div className="p-4 md:p-6">
      <LoadingState variant="table" rows={10} columns={8} />
    </div>
  );
}
