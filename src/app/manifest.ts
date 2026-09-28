// src/app/manifest.ts
//
// Web app manifest for the scanner PWA â€” Phase 7E. A manifest is a
// single static route (no [locale] segment), so start_url intentionally
// omits a locale prefix; src/proxy.ts's next-intl middleware negotiates
// the visitor's locale on that request the same way it does for any
// other unprefixed URL, so this never hardcodes Arabic or English.
//
// name/short_name/description are kept bilingual-neutral (the brand
// name itself, not translated UI copy) since a manifest has no locale
// variants in this Next.js convention.
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'COY21 Türkiye 2026 Scanner',
    short_name: 'COY21 Scanner',
    description: 'COY21 Türkiye 2026 conference attendance scanner',
    start_url: '/scanner',
    // Explicit '/' (not '/scanner') because start_url immediately
    // redirects to a locale-prefixed path (/ar/scanner or
    // /en/scanner) via src/proxy.ts â€” scope must cover the URL the
    // browser actually lands on, not just the launch URL.
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    // --color-turquoise (src/app/globals.css) â€” the app's own brand
    // accent, not an invented PWA-only color.
    theme_color: '#007a78',
    orientation: 'portrait',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

