// Accessibility page (Task 9). Describes REAL accessibility work already
// implemented in this phase — keyboard navigation (native <button>
// elements throughout, see faq-accordion.tsx), focus management in the
// mobile drawer (focus trap + return-to-trigger, see
// public-mobile-nav.tsx / mobile-drawer-logic.ts), RTL/LTR support (see
// src/app/[locale]/layout.tsx's dir={locale === 'ar' ? 'rtl' : 'ltr'}),
// and ARIA landmarks/labels (aria-label on <nav>, aria-modal/aria-label
// on the mobile drawer dialog, role="status" on EmptyState). Not generic
// boilerplate — every claim below matches an actual implementation.
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Reveal } from '@/components/motion/reveal';

export default function AccessibilityPage() {
  const t = useTranslations('public.pages.accessibility');

  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <div data-reveal="visible">
        <h1 className="font-[family-name:var(--font-thmanyah)] text-3xl font-semibold text-charcoal">
          {t('title')}
        </h1>
        <p className="mt-4 text-lg text-charcoal/80">{t('intro')}</p>
      </div>

      <div className="mt-10 flex flex-col gap-6">
        <Reveal>
          <Card>
            <h2 className="text-lg font-semibold text-charcoal">{t('keyboardTitle')}</h2>
            <p className="mt-2 text-sm text-charcoal/80">{t('keyboardBody')}</p>
          </Card>
        </Reveal>
        <Reveal>
          <Card>
            <h2 className="text-lg font-semibold text-charcoal">{t('focusTitle')}</h2>
            <p className="mt-2 text-sm text-charcoal/80">{t('focusBody')}</p>
          </Card>
        </Reveal>
        <Reveal>
          <Card>
            <h2 className="text-lg font-semibold text-charcoal">{t('languageTitle')}</h2>
            <p className="mt-2 text-sm text-charcoal/80">{t('languageBody')}</p>
          </Card>
        </Reveal>
        <Reveal>
          <Card>
            <h2 className="text-lg font-semibold text-charcoal">{t('structureTitle')}</h2>
            <p className="mt-2 text-sm text-charcoal/80">{t('structureBody')}</p>
          </Card>
        </Reveal>
        <Reveal>
          <Card>
            <h2 className="text-lg font-semibold text-charcoal">{t('feedbackTitle')}</h2>
            <p className="mt-2 text-sm text-charcoal/80">{t('feedbackBody')}</p>
          </Card>
        </Reveal>
      </div>
    </div>
  );
}
