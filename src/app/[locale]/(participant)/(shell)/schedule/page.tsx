import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getMyAttendanceForApplication } from '@/lib/dashboard/participant-dashboard-queries';
import { getAlternativesForTimeslotForCaller } from '@/lib/program-attendance/session-alternatives';
import { DayTimeline } from '@/components/schedule/day-timeline';
import type { ScheduleItemForCard } from '@/components/schedule/session-card';

export default async function SchedulePage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const { data: application } = await supabase.from('applications').select('id').eq('applicant_id', user.id).maybeSingle();
  if (!application) {
    redirect({ href: '/register', locale });
    return;
  }

  // RLS (schedule_publications_select_own / schedule_publication_items_select_own)
  // is the actual gate here, not this .eq — matches the established
  // my-application/page.tsx pattern of relying on RLS for a participant's
  // own-data read via the plain session client.
  const { data: publication } = await supabase
    .from('schedule_publications')
    .select('id')
    .eq('application_id', application.id)
    .eq('status', 'active')
    .maybeSingle();

  const service = createServiceRoleClient();

  let items: ScheduleItemForCard[] = [];
  if (publication) {
    const { data: itemRows } = await supabase
      .from('schedule_publication_items')
      .select('*')
      .eq('schedule_publication_id', publication.id);

    // admission_policy is read live from sessions (not snapshotted onto
    // schedule_publication_items at publish time — that column doesn't
    // exist there), via the service-role client since a participant's own
    // session client has no broad SELECT on `sessions` beyond what agenda
    // RLS already exposes publicly; the service-role read here is
    // read-only and scoped to exactly the session ids already visible to
    // this participant via their own published schedule. A live join
    // means the label reflects the CURRENT policy, which may differ from
    // what was true at publish time — same tradeoff already accepted for
    // is_mandatory's snapshot vs. a live value, just in the other
    // direction; documented here since the design spec didn't resolve it
    // explicitly (see Phase 8.4 investigation notes).
    const sessionIds = (itemRows ?? []).map((row) => row.session_id).filter((id): id is string => id !== null);
    const { data: sessionRows } = sessionIds.length > 0
      ? await service.from('sessions').select('id, admission_policy').in('id', sessionIds)
      : { data: [] };
    const admissionPolicyBySessionId = new Map((sessionRows ?? []).map((s) => [s.id, s.admission_policy]));

    const attendanceResult = await getMyAttendanceForApplication({ userId: user.id, service }, application.id);
    const attendanceBySessionId = attendanceResult.kind === 'data' ? attendanceResult.value : {};

    // Phase 9.3 — alternatives are fetched per active, session-linked item
    // only (a gap item or a cancelled/superseded item has nothing to find
    // alternatives for). Run concurrently via Promise.all: each call is
    // read-only, scoped to its own session_id, and independent of the
    // others, so there is no ordering or shared-state requirement forcing
    // sequential execution. With a full-size agenda (dozens of sessions
    // per day) getAlternativesForTimeslotForCaller's own per-candidate DB
    // round-trips compound across every active schedule item, so running
    // the outer loop sequentially made this page's load time scale with
    // item count x candidate count — confirmed live (500-participant /
    // 60-session test data) to push page load past several seconds per
    // participant. Promise.all collapses that back down to the single
    // slowest item's own latency.
    const alternativesEntries = await Promise.all(
      (itemRows ?? [])
        .filter((row) => row.session_id !== null && row.item_status === 'active')
        .map(async (row) => [row.session_id as string, await getAlternativesForTimeslotForCaller({ userId: user.id, service }, application.id, row.session_id as string)] as const)
    );
    const alternativesBySessionId = new Map(alternativesEntries);

    items = (itemRows ?? []).map((row) => ({
      id: row.id,
      sessionTitleAr: row.session_title_ar,
      sessionTitleEn: row.session_title_en,
      roomNameAr: row.room_name_ar,
      roomNameEn: row.room_name_en,
      startTime: row.start_time,
      endTime: row.end_time,
      isMandatory: row.is_mandatory,
      admissionPolicy: row.session_id ? admissionPolicyBySessionId.get(row.session_id) ?? null : null,
      attendance: row.session_id ? attendanceBySessionId[row.session_id] ?? null : null,
      alternatives: row.session_id ? alternativesBySessionId.get(row.session_id) ?? [] : [],
      speakers: Array.isArray(row.speakers)
        ? (row.speakers as { full_name_ar: string; full_name_en: string; role: string }[]).map((s) => ({
            fullNameAr: s.full_name_ar,
            fullNameEn: s.full_name_en,
            role: s.role,
          }))
        : [],
      itemStatus: row.item_status as ScheduleItemForCard['itemStatus'],
      gapReason: row.gap_reason,
    }));
  }

  const t = await getTranslations({ locale, namespace: 'schedule.page' });

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 md:p-10">
      <div>
        <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('personalizationNotice')}</p>
      </div>
      <DayTimeline items={items} locale={locale} />
    </div>
  );
}
