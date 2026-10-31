// src/app/[locale]/(participant)/(shell)/venue-map/page.tsx
//
// COY21 venue map — Akdeniz Üniversitesi Yerleşkesi (Antalya), the real
// COY21 conference venue. Replaces the earlier BUILD_SPEC §8 placeholder
// now that the real campus map graphic exists (public/venue/campus-map.webp,
// rendered 2026-11-01 from the venue's own harita.pdf at 2400px wide,
// WebP for a ~298KB payload vs. the ~7.2MB raw PNG render).
//
// Only 3 locations are confirmed and pinned (per explicit user mapping):
// - Main Hall      -> Atatürk Konferans Salonu (map marker #24)
// - Cafeteria      -> Merkezi Yemekhane (map marker #21)
// - Side Event rooms -> İBB Fakültesi building cluster (map marker #46)
// "Foyer" and "Off-campus" (real rooms in the `rooms` table) have no
// confirmed map location yet and are deliberately NOT shown here, per
// explicit user decision, rather than guessing or inventing a pin.
//
// Pin coordinates are percentages of the image's natural dimensions
// (2400x1350), measured by overlaying test markers on the rendered map
// and visually confirming each one lands on the correct numbered circle
// -- see the session's working notes for the exact calibration crops.
// Percentage (not fixed pixel) positioning keeps pins correctly placed
// at any responsive image width.

import Image from 'next/image';
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { MountReveal } from '@/components/motion/mount-reveal';

// Natural dimensions of public/venue/campus-map.webp (rendered at this
// exact size) -- next/image requires explicit width/height for a plain
// string `src`, matching this codebase's existing convention (see e.g.
// (auth)/layout.tsx's logo Image) rather than a static import.
const MAP_WIDTH = 2400;
const MAP_HEIGHT = 1350;

interface VenueLocation {
  id: string;
  nameEn: string;
  nameAr: string;
  /** Percentage of the image's natural width/height, 0-100. */
  xPct: number;
  yPct: number;
}

const VENUE_LOCATIONS: VenueLocation[] = [
  { id: 'main-hall', nameEn: 'Main Hall (Atatürk Konferans Salonu)', nameAr: 'القاعة الرئيسية (Atatürk Konferans Salonu)', xPct: 56.5, yPct: 28.7 },
  { id: 'cafeteria', nameEn: 'Cafeteria (Merkezi Yemekhane)', nameAr: 'الكافتيريا (Merkezi Yemekhane)', xPct: 56.7, yPct: 44.0 },
  { id: 'side-events', nameEn: 'Side Event Rooms (İBB Fakültesi)', nameAr: 'قاعات الفعاليات الجانبية (İBB Fakültesi)', xPct: 49.6, yPct: 39.0 },
];

// Google's own search-query URL (not a bare lat/lng pin) so it resolves
// to Google's verified "Akdeniz Üniversitesi" place card -- more
// reliable than a raw coordinate, which can drop slightly off a large
// campus. Coordinates (36.895, 30.6511) cross-checked against Wikipedia
// and the Turkish e-Devlet government portal as a sanity fallback, not
// used directly in the URL.
const GOOGLE_MAPS_URL = 'https://www.google.com/maps/search/?api=1&query=Akdeniz+%C3%9Cniversitesi+Antalya';

export default async function VenueMapPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6 md:p-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">Venue Map</h1>
          <p className="mt-1 text-sm text-charcoal/60 dark:text-gray-400">
            Akdeniz Üniversitesi Yerleşkesi — COY21 Antalya conference venue
          </p>
        </div>
        <a
          href={GOOGLE_MAPS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-charcoal/20 px-3 py-1.5 text-sm font-medium text-charcoal transition-colors hover:bg-charcoal/5 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
          </svg>
          Open in Google Maps
        </a>
      </div>

      <MountReveal delayMs={0}>
        <div className="overflow-auto rounded-xl border border-charcoal/10 dark:border-gray-700">
          <div className="relative w-full min-w-[800px]">
            <Image
              src="/venue/campus-map.webp"
              alt="Akdeniz Üniversitesi campus map"
              width={MAP_WIDTH}
              height={MAP_HEIGHT}
              className="h-auto w-full"
              priority
            />
            {VENUE_LOCATIONS.map((loc) => (
              <div
                key={loc.id}
                className="group absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${loc.xPct}%`, top: `${loc.yPct}%` }}
              >
                <span
                  aria-hidden="true"
                  className="block h-5 w-5 rounded-full border-2 border-white bg-turquoise shadow-md ring-2 ring-turquoise/40"
                />
                <span className="pointer-events-none absolute start-1/2 top-full z-10 mt-1 w-max max-w-[180px] -translate-x-1/2 rounded-md bg-charcoal px-2 py-1 text-center text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 dark:bg-gray-900">
                  {locale === 'ar' ? loc.nameAr : loc.nameEn}
                </span>
              </div>
            ))}
          </div>
        </div>
      </MountReveal>

      <MountReveal delayMs={80}>
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-charcoal/70 dark:text-gray-400">Key locations</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {VENUE_LOCATIONS.map((loc) => (
              <div
                key={loc.id}
                className="flex items-center gap-2 rounded-lg bg-charcoal/5 px-3 py-2 text-xs text-charcoal/70 dark:bg-white/5 dark:text-gray-300"
              >
                <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-turquoise" />
                {locale === 'ar' ? loc.nameAr : loc.nameEn}
              </div>
            ))}
          </div>
        </div>
      </MountReveal>
    </div>
  );
}
