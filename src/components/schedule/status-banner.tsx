import { getTranslations } from 'next-intl/server';

export async function StatusBanner({
  status,
  locale,
}: {
  status: 'stale' | 'changed' | 'cancelled' | 'pending_review';
  locale: string;
}) {
  const t = await getTranslations({ locale, namespace: 'schedule.statusBanner' });

  return (
    <div role="alert" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
      {t(status)}
    </div>
  );
}
