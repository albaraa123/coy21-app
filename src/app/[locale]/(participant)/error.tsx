// src/app/[locale]/(participant)/error.tsx
//
// Route-segment error boundary shared by both nested groups under
// (participant) — see loading.tsx's doc comment for why this is placed
// once at (participant)/ rather than duplicated in (shell)/ and
// (bare)/. Same 'use client' requirement and `reset()` rationale as
// (admin)/error.tsx — see that file's doc comment.
'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/states/error-state';
import { useTranslations } from 'next-intl';

export default function ParticipantError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('states.error');

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="p-8">
      <ErrorState
        title={t('title')}
        description={t('description')}
        onRetry={reset}
        errorId={error.digest}
        announce
      />
    </div>
  );
}
