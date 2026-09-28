'use client';

import { useState } from 'react';

// Antalya centre coordinates
const ANTALYA_LAT = 36.8969;
const ANTALYA_LNG = 30.7133;

type Category = {
  key: string;
  label: string;
  query: string;
};

const CATEGORIES: Category[] = [
  { key: 'all',        label: 'All',         query: 'Antalya Turkey' },
  { key: 'restaurant', label: 'Restaurants',  query: 'restaurants near Antalya Turkey' },
  { key: 'pharmacy',   label: 'Pharmacies',   query: 'pharmacy near Antalya Turkey' },
  { key: 'hospital',   label: 'Hospitals',    query: 'hospital near Antalya Turkey' },
  { key: 'heritage',   label: 'Historic sites', query: 'historic sites Antalya Turkey' },
];

export function MapEmbed() {
  const [active, setActive] = useState('all');

  const category = CATEGORIES.find((c) => c.key === active) ?? CATEGORIES[0];

  // Google Maps embed — no API key required for the standard embed URL.
  // Geo-scoped to Antalya by including coordinates in the q param.
  const src = `https://maps.google.com/maps?q=${encodeURIComponent(category.query)}&ll=${ANTALYA_LAT},${ANTALYA_LNG}&z=14&output=embed`;

  return (
    <div className="flex flex-col gap-3">
      {/* Category filter */}
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            onClick={() => setActive(c.key)}
            className={[
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              active === c.key
                ? 'bg-charcoal text-white dark:bg-white dark:text-charcoal'
                : 'bg-charcoal/10 text-charcoal hover:bg-charcoal/20 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/20',
            ].join(' ')}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Map iframe */}
      <div className="overflow-hidden rounded-xl border border-charcoal/10 dark:border-white/10">
        <iframe
          src={src}
          width="100%"
          height="400"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          className="block"
          title={`Map — ${category.label}`}
        />
      </div>
    </div>
  );
}
