// src/app/[locale]/(admin)/loading.tsx
//
// Route-segment loading boundary for every (admin) page. Per Next.js's
// component hierarchy, loading.js sits BELOW layout.js — so this renders
// while an individual admin page (or its own nested loading.js) is
// suspended, inside the (admin)/layout.tsx chrome that has already
// resolved by then (see node_modules/next/dist/docs/01-app/03-api-
// reference/03-file-conventions/loading.md: "Because loading.js sits
// below layout.js in the component hierarchy, it cannot show a fallback
// for uncached or runtime data access in the layout itself" — this file
// covers page-level suspense, not the layout's own auth/profile fetch).
// No 'use client' needed: LoadingState (Task 3) has no client-only APIs.
import { LoadingState } from '@/components/states/loading-state';

export default function AdminLoading() {
  return <LoadingState variant="page" />;
}
