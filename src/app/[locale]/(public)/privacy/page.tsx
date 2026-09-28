// Privacy page (Task 9). Standard, reasonable placeholder legal-document
// structure. Explicitly marked as a DRAFT pending real legal review —
// never presented as final/authoritative without the user's sign-off,
// per the design spec's hard rule.
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';

export default function PrivacyPage() {
  const t = useTranslations('public.pages.privacy');

  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="font-[family-name:var(--font-thmanyah)] text-3xl font-semibold text-charcoal">
        {t('title')}
      </h1>

      <div
        role="status"
        className="mt-4 rounded-md border border-gold bg-gold/10 px-4 py-3 text-sm font-medium text-charcoal"
      >
        {t('draftNotice')}
      </div>

      <p className="mt-6 text-charcoal/80">{t('intro')}</p>

      <div className="mt-8 flex flex-col gap-6">
        <Card>
          <h2 className="text-lg font-semibold text-charcoal">{t('collectionTitle')}</h2>
          <p className="mt-2 text-sm text-charcoal/80">{t('collectionBody')}</p>
        </Card>
        <Card>
          <h2 className="text-lg font-semibold text-charcoal">{t('useTitle')}</h2>
          <p className="mt-2 text-sm text-charcoal/80">{t('useBody')}</p>
        </Card>
        <Card>
          <h2 className="text-lg font-semibold text-charcoal">{t('sharingTitle')}</h2>
          <p className="mt-2 text-sm text-charcoal/80">{t('sharingBody')}</p>
        </Card>
        <Card>
          <h2 className="text-lg font-semibold text-charcoal">{t('contactTitle')}</h2>
          <p className="mt-2 text-sm text-charcoal/80">{t('contactBody')}</p>
        </Card>
      </div>
    </div>
  );
}
