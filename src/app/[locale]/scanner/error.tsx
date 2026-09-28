// src/app/[locale]/scanner/error.tsx
//
// Route-segment error boundary for /scanner — same 'use client'/reset()
// pattern as (participant)/error.tsx and (admin)/error.tsx. Covers the
// network/server-error state the Phase 7B brief requires (uncaught
// failures, e.g. a network drop mid-request), distinct from page.tsx's
// own handled states (unauthorized/no-assignment/session-unavailable),
// which render normally rather than throwing.
'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/states/error-state';

export default function ScannerError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('scanner.states.error');

  useEffect(() => {
    console.error(error);
  }, [error]);

  return <ErrorState title={t('title')} description={t('description')} onRetry={reset} errorId={error.digest} announce />;
}
