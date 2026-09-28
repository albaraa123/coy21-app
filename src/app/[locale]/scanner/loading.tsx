// src/app/[locale]/scanner/loading.tsx
//
// Route-segment loading boundary for the async ScannerPage render (auth
// check + assignment/session lookup) — same convention as
// (participant)/loading.tsx.
import { LoadingState } from '@/components/states/loading-state';

export default function ScannerLoading() {
  return <LoadingState variant="page" />;
}
