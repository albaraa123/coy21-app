import { getTranslations } from 'next-intl/server';
import { formatConferenceTime } from '@/lib/datetime/conference-time';

export async function TimeMarker({ startTime, endTime, locale }: { startTime: string; endTime: string; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'schedule.timeMarker' });
  const resolvedLocale = locale === 'ar' ? 'ar' : 'en';
  const format = (iso: string) => formatConferenceTime(iso, resolvedLocale, { hour12: false });
  return (
    <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {format(startTime)} – {format(endTime)} · {t('timezoneLabel')}
    </div>
  );
}
