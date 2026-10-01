import { getTranslations } from 'next-intl/server';
import { SessionCard, type ScheduleItemForCard } from './session-card';
import { EmptyState } from '@/components/ui/empty-state';
import { formatConferenceDate } from '@/lib/datetime/conference-time';

// Used only as an internal Map grouping key (not displayed), so it keeps its
// own compact en-CA (YYYY-MM-DD) format rather than formatConferenceDate's
// long display format — only the timezone source changes here.
const conferenceDateKey = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

export async function DayTimeline({ items, locale }: { items: ScheduleItemForCard[]; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'schedule.dayTimeline' });

  if (items.length === 0) {
    return <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />;
  }

  const sorted = [...items].sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  const byDay = new Map<string, ScheduleItemForCard[]>();
  for (const item of sorted) {
    const dayKey = item.startTime ? conferenceDateKey(item.startTime) : 'unscheduled';
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
            : formatConferenceDate(firstStartTime, locale === 'ar' ? 'ar' : 'en');
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
