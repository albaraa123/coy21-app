// src/app/[locale]/(admin)/error.tsx
//
// Route-segment error boundary for (admin). Per Next.js's own docs
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-
// conventions/error.md): "Error boundaries must be Client Components" —
// confirmed directly from the doc rather than assumed from training
// data, since this project's AGENTS.md explicitly warns this Next
// version may differ. 'use client' is required here, not optional.
//
// `reset()` is used (not the newer unstable_retry(), added in v16.2.0
// per that doc's Version History) since `reset` is the long-stable,
// documented API and this component's need (re-render the boundary's
// children) doesn't require unstable_retry's re-fetch semantics.
//
// error.js sits BELOW layout.js in the component hierarchy, so this
// catches errors thrown by an (admin) page itself, not errors in
// (admin)/layout.tsx's own auth/profile fetch (a throw there is not
// caught by this file — see the loading.tsx doc comment for the same
// hierarchy point applied to Suspense).
'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/states/error-state';
import { useTranslations } from 'next-intl';

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
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
