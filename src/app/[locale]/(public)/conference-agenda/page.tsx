// Conference Agenda page.
//
// TEMPORARY DATA-ACCESS APPROACH — flagged for follow-up review, not the
// final architecture. This queries `sessions`/`rooms`/`tracks` directly
// via the plain (anon-capable) client, relying on the new
// sessions_select_public/rooms_select_public/tracks_select_public RLS
// policies + anon GRANT added in
// supabase/migrations/20260820150000_add_public_sessions_read_policy.sql.
// That is a DIFFERENT pattern from src/lib/content/public-speakers.ts's
// explicit, documented decision to use a service-role client + narrow
// field allowlist instead of a new anon RLS/GRANT precedent on a
// staff-managed table. This page was built quickly to preview real
// session data end-to-end on demo/test data; before this goes live with
// real participant-facing content, revisit whether it should be
// rewritten onto the public-speakers.ts pattern for consistency (a new
// src/lib/content/public-agenda.ts using createServiceRoleClient() +
// an explicit column list), rather than leaving the sessions_select_public
// grant as a second, inconsistent precedent alongside people's staff-only
// RLS.
//
// Was previously a static EmptyState (see Task 9's original investigation,
// preserved above in git history) — the underlying reasons for that
// (schedule_publications/schedule_publication_items are per-applicant, not
// general; sessions had no public RLS policy) are addressed here for
// `sessions` specifically via the migration above, not by exposing any
// per-participant table.
//
// RENDERING NOTE (2026-11-01): the actual day/session list is rendered by
// a Client Component (agenda-schedule.tsx), not inline JSX here, as a
// workaround for a reproduced React 19.2.4 / Next.js 16.2.11 RSC
// streaming bug -- see that file's header comment for the full
// investigation. This Server Component's only remaining job is the
// data fetch and handing plain (JSON-serializable) data down as props.
import { getLocale, getTranslations } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';
import { EmptyState } from '@/components/ui/empty-state';
import { Blob } from '@/components/motion/blob';
import { Parallax } from '@/components/motion/parallax';
import { formatConferenceDate } from '@/lib/datetime/conference-time';
import { AgendaSchedule } from './agenda-schedule';

type PublicSession = {
  id: string;
  session_code: string;
  title_ar: string;
  title_en: string;
  start_time: string;
  end_time: string;
  language: string;
  rooms: { name_ar: string; name_en: string } | null;
  tracks: { name_ar: string; name_en: string } | null;
};

export default async function AgendaPage() {
  const locale = await getLocale();
  const t = await getTranslations('public');

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('sessions')
    .select('id, session_code, title_ar, title_en, start_time, end_time, language, rooms(name_ar, name_en), tracks(name_ar, name_en)')
    .eq('is_public', true)
    .order('start_time', { ascending: true });

  const sessions: PublicSession[] = error ? [] : ((data ?? []) as unknown as PublicSession[]);

  const resolvedLocale = locale === 'ar' ? 'ar' : 'en';
  const dayLabels = sessions.map((session) => formatConferenceDate(session.start_time, resolvedLocale));
  const hasSessions = sessions.length > 0;

  return (
    <>
      {/* HERO — full-bleed gradient band matching the homepage/about hero
          language, instead of a plain stacked title in the reading
          column. */}
      <section className="relative overflow-hidden border-b border-charcoal/10">
        <div
          aria-hidden="true"
          className="animate-gradient-drift absolute inset-0 -z-10"
          style={{
            backgroundImage:
              'linear-gradient(120deg, color-mix(in srgb, var(--color-green) 16%, var(--color-warm-white)) 0%, color-mix(in srgb, var(--color-turquoise) 14%, var(--color-warm-white)) 100%)',
          }}
        />
        <Parallax strength={0.06}>
          <Blob color="green" className="right-[-8%] top-[-10%] h-64 w-64" />
        </Parallax>
        <div data-reveal="visible" className="mx-auto max-w-3xl px-4 py-16 text-center md:py-20">
          <h1 className="font-[family-name:var(--font-thmanyah)] text-3xl font-semibold text-charcoal md:text-4xl">
            {t('pages.agenda.title')}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-charcoal/80">
            {hasSessions ? t('pages.agenda.introPublished') : t('pages.agenda.intro')}
          </p>
        </div>
      </section>

      {!hasSessions ? (
        <div className="mx-auto max-w-3xl px-4 py-16">
          <EmptyState title={t('comingSoon.title')} description={t('pages.agenda.note')} />
        </div>
      ) : (
        <div className="mx-auto max-w-3xl px-4 py-16">
          <AgendaSchedule
            sessions={sessions}
            locale={resolvedLocale}
            dayLabels={dayLabels}
            timezoneLabel={t('pages.agenda.timezoneLabel')}
          />
        </div>
      )}
    </>
  );
}
