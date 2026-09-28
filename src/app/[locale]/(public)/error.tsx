// src/app/[locale]/(public)/error.tsx
// Route-segment error boundary for (public). 'use client' is required
// (error boundaries must be Client Components — see (admin)/error.tsx's
// doc comment for the doc citation, same reasoning applies here).
'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/states/error-state';

export default function PublicError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('states.error');

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-6xl p-8">
      <ErrorState title={t('title')} description={t('description')} onRetry={reset} errorId={error.digest} announce />
    </div>
  );
}
