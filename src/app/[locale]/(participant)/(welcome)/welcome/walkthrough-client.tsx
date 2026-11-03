'use client';

// src/app/[locale]/(participant)/(welcome)/welcome/walkthrough-client.tsx
//
// The 8-slide first-login walkthrough itself. No Skip control by design
// (explicit user decision) -- the only way forward is Next, and the only
// way out of the gate is completing the last slide, which calls
// completeOnboarding() and only then navigates away. If that action fails,
// the participant stays on the last slide with an inline error rather than
// being silently let through without the flag actually being set server-
// side -- otherwise a transient failure would let them in once but then
// re-trigger the gate on their very next page load.
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { completeOnboarding } from './actions';
import { SLIDE_ILLUSTRATIONS } from './slide-illustrations';

const SLIDE_KEYS = ['slide1', 'slide2', 'slide3', 'slide4', 'slide5', 'slide6', 'slide7', 'slide8'] as const;

export function WelcomeWalkthrough() {
  const t = useTranslations('welcome');
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLast = index === SLIDE_KEYS.length - 1;
  const slideKey = SLIDE_KEYS[index];
  const Illustration = SLIDE_ILLUSTRATIONS[index];

  async function handleAdvance() {
    if (!isLast) {
      setIndex((i) => i + 1);
      return;
    }
    setError(null);
    setFinishing(true);
    try {
      const result = await completeOnboarding();
      if (!result.success) {
        setError(result.errorMessage);
        return;
      }
      router.push('/my-dashboard');
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-16">
      <div className="mb-8 flex items-center gap-3">
        <div className="flex-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-charcoal/10 dark:bg-gray-800">
            <div
              className="h-full rounded-full bg-turquoise transition-all duration-300"
              style={{ width: `${((index + 1) / SLIDE_KEYS.length) * 100}%` }}
            />
          </div>
        </div>
        <span className="shrink-0 text-xs font-medium text-charcoal/50 dark:text-gray-500">
          {t('progressLabel', { current: index + 1, total: SLIDE_KEYS.length })}
        </span>
      </div>

      <div key={slideKey} className="flex flex-col gap-5">
        <Illustration />
        <div className="flex flex-col gap-4">
          <span className="text-xs font-semibold uppercase tracking-wide text-turquoise">{t(`${slideKey}.eyebrow`)}</span>
          <h1 className="font-serif text-2xl font-semibold leading-tight text-charcoal dark:text-gray-100 sm:text-3xl">
            {t(`${slideKey}.title`)}
          </h1>
          <p className="text-base leading-relaxed text-charcoal/70 dark:text-gray-400">{t(`${slideKey}.body`)}</p>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="mt-10">
        <Button onClick={() => void handleAdvance()} disabled={finishing} className="w-full sm:w-auto">
          {isLast ? (finishing ? t('finishing') : t('finish')) : t('next')}
        </Button>
      </div>
    </div>
  );
}
