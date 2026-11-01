// Route-specific override of (admin)/loading.tsx's generic page spinner —
// this page's own content is a profiles list table (id, full_name, email,
// role, created_at — see page.tsx), so a table skeleton is a closer match
// to what's about to render than a centered spinner. Same pattern as
// (admin)/applications/loading.tsx.
import { LoadingState } from '@/components/states/loading-state';

export default function StaffLoading() {
  return (
    <div className="p-4 md:p-6">
      <LoadingState variant="table" rows={8} columns={5} />
    </div>
  );
}
