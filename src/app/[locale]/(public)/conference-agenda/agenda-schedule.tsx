'use client';

import { useEffect, useRef, useState } from 'react';

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

// Mirrors Reveal's own scroll-triggered fade-up behavior (src/components/
// motion/reveal.tsx), reimplemented locally rather than imported so this
// client module has zero dependency on the page's own client-component
// tree shape -- the whole point of this file is to be a self-contained
// leaf that only ever receives plain data as props.
function RevealBlock({ children, delayMs }: { children: React.ReactNode; delayMs: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-reveal={visible ? 'visible' : 'hidden'}
      style={visible ? { animationDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </div>
  );
}

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
        <RevealBlock key={dayLabel} delayMs={dayIndex * 60}>
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
        </RevealBlock>
      ))}
    </div>
  );
}
