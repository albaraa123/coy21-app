// src/app/[locale]/(public)/loading.tsx
// Route-segment loading boundary for every (public) page. Mirrors
// (admin)/loading.tsx's reasoning: no 'use client' needed, LoadingState
// (Task 3) has no client-only APIs.
import { LoadingState } from '@/components/states/loading-state';

export default function PublicLoading() {
  return <LoadingState variant="page" />;
}
