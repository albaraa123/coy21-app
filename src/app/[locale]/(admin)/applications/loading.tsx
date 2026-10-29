// Route-specific override of (admin)/loading.tsx's generic page spinner —
// this page's own content IS a 10-column, up-to-50-row table (see
// page.tsx), so a table skeleton is a closer match to what's about to
// render than a centered spinner. Next.js picks the nearest loading.tsx
// up the segment tree per-route (see loading.md referenced in the parent
// (admin)/loading.tsx's doc comment), so this only affects /applications,
// not sibling admin routes.
import { LoadingState } from '@/components/states/loading-state';

export default function ApplicationsLoading() {
  return (
    <div className="p-4 md:p-6">
      <LoadingState variant="table" rows={10} columns={10} />
    </div>
  );
}
