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
import { getLocale, getTranslations } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';
import { EmptyState } from '@/components/ui/empty-state';
import { Reveal } from '@/components/motion/reveal';
import { Blob } from '@/components/motion/blob';
import { Parallax } from '@/components/motion/parallax';

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

  const formatDay = (iso: string) =>
    new Date(iso).toLocaleDateString(locale === 'ar' ? 'ar' : 'en-US', { timeZone: 'Asia/Muscat', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', { timeZone: 'Asia/Muscat', hour: '2-digit', minute: '2-digit', hour12: false });

  const sessionsByDay = new Map<string, PublicSession[]>();
  for (const session of sessions) {
    const dayLabel = formatDay(session.start_time);
    const existing = sessionsByDay.get(dayLabel) ?? [];
    existing.push(session);
    sessionsByDay.set(dayLabel, existing);
  }

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
            {sessionsByDay.size === 0 ? t('pages.agenda.intro') : t('pages.agenda.introPublished')}
          </p>
        </div>
      </section>

      {sessionsByDay.size === 0 ? (
        <div className="mx-auto max-w-3xl px-4 py-16">
          <EmptyState title={t('comingSoon.title')} description={t('pages.agenda.note')} />
        </div>
      ) : (
        <div className="mx-auto max-w-3xl px-4 py-16">
          <div className="flex flex-col gap-12">
            {(() => {
              const ACCENTS = ['var(--color-turquoise)', 'var(--color-green)', 'var(--color-gold)'];
              let sessionIndex = 0;
              return [...sessionsByDay.entries()].map(([dayLabel, daySessions], dayIndex) => (
                <Reveal key={dayLabel} delayMs={dayIndex * 60}>
                  <div className="flex items-baseline gap-3">
                    <span
                      aria-hidden="true"
                      className="font-[family-name:var(--font-thmanyah)] text-4xl font-bold leading-none opacity-25"
                      style={{ color: ACCENTS[dayIndex % ACCENTS.length] }}
                    >
                      {String(dayIndex + 1).padStart(2, '0')}
                    </span>
                    <h2 className="text-xl font-semibold text-charcoal">{dayLabel}</h2>
                  </div>
                  <div className="mt-4 flex flex-col gap-3">
                    {daySessions.map((session) => {
                      const title = locale === 'ar' ? session.title_ar : session.title_en;
                      const roomName = session.rooms ? (locale === 'ar' ? session.rooms.name_ar : session.rooms.name_en) : null;
                      const trackName = session.tracks ? (locale === 'ar' ? session.tracks.name_ar : session.tracks.name_en) : null;
                      const accent = ACCENTS[sessionIndex++ % ACCENTS.length];
                      return (
                        <div
                          key={session.id}
                          className="rounded-lg border border-charcoal/10 border-s-4 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                          style={{ borderInlineStartColor: accent }}
                        >
                          <div className="text-xs font-medium uppercase tracking-wide text-charcoal/60">
                            {formatTime(session.start_time)} – {formatTime(session.end_time)} · {t('pages.agenda.timezoneLabel')}
                          </div>
                          <p className="mt-1 text-base font-semibold text-charcoal">{title}</p>
                          <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-charcoal/70">
                            {roomName && <span>{roomName}</span>}
                            {trackName && <span>{trackName}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Reveal>
              ));
            })()}
          </div>
        </div>
      )}
    </>
  );
}
