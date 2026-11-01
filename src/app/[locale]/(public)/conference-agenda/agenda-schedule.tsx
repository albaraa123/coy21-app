'use client';

// Renders the day/session list entirely client-side, receiving sessions
// as plain serialized data (not JSX) via props. Introduced as a
// workaround for a reproduced React 19.2.4 / Next.js 16.2.11 Server
// Components bug: with all 3 real conference days present (112 sessions
// total, grouped into 3 day-sections), the RSC payload for the second
// group was silently truncated mid-stream -- React emitted unresolved
// `$Lxx` chunk references for most of its session cards with no error
// anywhere (not in the data -- the server-side fetch always returned all
// 112 rows correctly -- not in a console.error, not in the HTTP
// response). Reproduced identically in `next dev` and a real
// `next build && next start`, so it is not a dev-mode artifact.
// Extensively isolated before landing on this fix: removing the Reveal
// client-component wrapper, extracting each day into its own named
// Server Component (called explicitly, not via .map()), and removing a
// mutable accent-cycling counter all failed to resolve it. The only
// reliable differentiator found across every test was the number of
// distinct day-groups being rendered server-side: 2 groups always
// rendered fully regardless of total session count (up to 99 sessions
// tested); 3 groups broke even as low as ~65-99 total sessions. Moving
// the actual list rendering into a Client Component sidesteps the RSC
// serialization path entirely -- the server now only ever sends this
// component a plain JSON array of session objects, never a large nested
// JSX tree, so whatever the upstream bug is in RSC streaming never gets
// triggered.

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

const ACCENTS = ['var(--color-turquoise)', 'var(--color-green)', 'var(--color-gold)'];

// Deliberately NOT using Reveal's scroll-triggered fade-up animation here
// (unlike the rest of this page's sections). Found live: a 112-session,
// 3-day page is tall enough that the IntersectionObserver's threshold/
// rootMargin tuning (designed for shorter marketing sections) left later
// day-sections permanently stuck at data-reveal="hidden" -- opacity: 0
// per globals.css, present in the DOM and in the server-rendered HTML
// (confirmed: all 112 session cards ARE in the raw HTML) but invisible to
// the user with no error of any kind. Day sections here always render at
// full opacity -- correctness over a cosmetic entrance animation.

export function AgendaSchedule({
  sessions,
  locale,
  dayLabels,
  timezoneLabel,
}: {
  sessions: PublicSession[];
  locale: string;
  // Pre-computed per-session day label (same index order as `sessions`),
  // since Intl.DateTimeFormat with a fixed IANA zone is deterministic and
  // cheap to redo client-side, but keeping the exact label text identical
  // to what the server already decided avoids any drift between the two.
  dayLabels: string[];
  timezoneLabel: string;
}) {
  const sessionsByDay = new Map<string, PublicSession[]>();
  sessions.forEach((session, i) => {
    const dayLabel = dayLabels[i];
    const existing = sessionsByDay.get(dayLabel) ?? [];
    existing.push(session);
    sessionsByDay.set(dayLabel, existing);
  });

  const formatTime = (iso: string) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-US', {
      timeZone: 'Europe/Istanbul',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));

  return (
    <div className="flex flex-col gap-12">
      {[...sessionsByDay.entries()].map(([dayLabel, daySessions], dayIndex) => (
        <div key={dayLabel}>
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
            {daySessions.map((session, sessionIndex) => {
              const title = locale === 'ar' ? session.title_ar : session.title_en;
              const roomName = session.rooms ? (locale === 'ar' ? session.rooms.name_ar : session.rooms.name_en) : null;
              const trackName = session.tracks ? (locale === 'ar' ? session.tracks.name_ar : session.tracks.name_en) : null;
              const accent = ACCENTS[sessionIndex % ACCENTS.length];
              return (
                <div
                  key={session.id}
                  className="rounded-lg border border-charcoal/10 border-s-4 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                  style={{ borderInlineStartColor: accent }}
                >
                  <div className="text-xs font-medium uppercase tracking-wide text-charcoal/60">
                    {formatTime(session.start_time)} – {formatTime(session.end_time)} · {timezoneLabel}
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
        </div>
      ))}
    </div>
  );
}
