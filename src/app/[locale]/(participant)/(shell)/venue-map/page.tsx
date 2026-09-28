// src/app/[locale]/(participant)/(shell)/venue-map/page.tsx
//
// COY21 Phase 5 — Venue Map placeholder (BUILD_SPEC §8).
// The actual Green Zone map graphic will be produced by the Comms team.
// This page is intentionally a placeholder: drop the final image/interactive
// map into <VenueMapContent> without restructuring the app.

import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';

export default async function VenueMapPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 md:p-10">
      <div>
        <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">Venue Map</h1>
        <p className="mt-1 text-sm text-charcoal/60 dark:text-gray-400">
          Green Zone — COY21 Antalya conference venue
        </p>
      </div>

      {/* ----------------------------------------------------------------
          MAP PLACEHOLDER
          Replace this Card with the final map image or interactive embed
          once the Comms team delivers it. The surrounding layout stays.
      ---------------------------------------------------------------- */}
      <div className="flex min-h-[480px] flex-col items-center justify-center rounded-xl border-2 border-dashed border-charcoal/20 bg-charcoal/5 dark:border-white/20 dark:bg-white/5">
        <div className="flex flex-col items-center gap-3 text-center">
          {/* Simple location pin SVG — no icon library needed */}
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" className="text-charcoal/30 dark:text-gray-600" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
          </svg>
          <p className="text-sm font-medium text-charcoal/50 dark:text-gray-500">
            Venue map coming soon
          </p>
          <p className="max-w-xs text-xs text-charcoal/40 dark:text-gray-600">
            The Green Zone map is being prepared by the Comms team and will appear here before the event.
          </p>
        </div>
      </div>

      {/* Room quick-reference legend — update once room list is finalised */}
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-charcoal/70 dark:text-gray-400">Key locations</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[
            'Main Plenary Hall',
            'Registration Desk',
            'Breakout Room A',
            'Breakout Room B',
            'Cafeteria',
            'Prayer Room',
            'Medical Point',
            'Info Desk',
          ].map((room) => (
            <div
              key={room}
              className="rounded-lg bg-charcoal/5 px-3 py-2 text-xs text-charcoal/60 dark:bg-white/5 dark:text-gray-400"
            >
              {room}
            </div>
          ))}
        </div>
        <p className="mt-1 text-xs text-charcoal/30 dark:text-gray-600">
          Room list is provisional — final locations will be shown on the map.
        </p>
      </div>
    </div>
  );
}
