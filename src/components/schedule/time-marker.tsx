import { getTranslations } from 'next-intl/server';

export async function TimeMarker({ startTime, endTime, locale }: { startTime: string; endTime: string; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'schedule.timeMarker' });
  const format = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Muscat', hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {format(startTime)} – {format(endTime)} · {t('timezoneLabel')}
    </div>
  );
}
