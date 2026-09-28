import { getTranslations } from 'next-intl/server';
import { SessionCard, type ScheduleItemForCard } from './session-card';
import { EmptyState } from '@/components/ui/empty-state';

const muscatDateKey = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Muscat', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

export async function DayTimeline({ items, locale }: { items: ScheduleItemForCard[]; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'schedule.dayTimeline' });

  if (items.length === 0) {
    return <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />;
  }

  const sorted = [...items].sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  const byDay = new Map<string, ScheduleItemForCard[]>();
  for (const item of sorted) {
    const dayKey = item.startTime ? muscatDateKey(item.startTime) : 'unscheduled';
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey)!.push(item);
  }

  return (
    <div className="flex flex-col gap-6">
      {Array.from(byDay.entries()).map(([day, dayItems]) => {
        const firstStartTime = dayItems[0]?.startTime;
        const heading =
          day === 'unscheduled' || !firstStartTime
            ? t('unscheduled')
            : new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-US', {
                timeZone: 'Asia/Muscat',
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              }).format(new Date(firstStartTime));
        return (
          <section key={day} aria-labelledby={`day-${day}`}>
            <h2 id={`day-${day}`} className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
              {heading}
            </h2>
            <div className="flex flex-col gap-3 border-s-2 border-gray-200 ps-4 dark:border-gray-700">
              {dayItems.map((item) => (
                <SessionCard key={item.id} item={item} locale={locale} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
