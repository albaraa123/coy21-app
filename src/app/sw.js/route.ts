// src/app/sw.js/route.ts
//
// Phase 7E — serves the scanner's service worker as a Route Handler
// (not a static public/sw.js file) specifically so its cache-version
// string can be derived from the actual build/deployment identity
// (VERCEL_GIT_COMMIT_SHA, injected automatically by Vercel at build
// time) rather than a manually-bumped constant someone has to remember
// to change on every deploy. See #22 in the Phase 7E brief: if hosting
// moves to Cloudflare Workers/OpenNext, this env var and this whole
// approach must be reverified — Cloudflare does not inject the same
// variable, so a fallback build-time Date.now() stamp is used when it's
// absent (still correct — just less precise than a real commit SHA —
// never falls back to a hardcoded/unversioned string).
//
// Caching policy — deliberately minimal (Phase 7E brief section 15/16):
//   - Cache ONLY the fixed, non-sensitive static asset list below.
//   - NEVER cache navigation requests (any HTML page, including
//     /scanner itself) — every page load re-runs the real server-side
//     auth/role/assignment check in page.tsx; caching that response
//     would let a logged-out/deauthorized/reassigned device keep
//     showing a stale "authorized" scanner UI, which is exactly what
//     section 18/19 forbid.
//   - NEVER cache the scan-qr-attempt Route Handler's requests, any
//     Supabase/API response, or anything containing a QR payload or
//     participant summary.
//   - On activate, delete every cache whose name doesn't match the
//     CURRENT build's cache name — so a new deployment's service
//     worker (browser-detected via its byte-for-byte-changed content,
//     since this string is embedded directly in the response body)
//     immediately drops the previous deploy's cached assets rather
//     than serving them indefinitely.
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA ?? `fallback-${Date.now()}`;
const CACHE_NAME = `rcoy-scanner-shell-${BUILD_ID}`;

// Fixed, small, non-sensitive allow-list — static assets only. No HTML,
// no API routes, no manifest data that could go stale in a way that
// matters (the manifest itself is safe to cache since it carries no
// auth/session data).
const PRECACHE_URLS = ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png', '/apple-icon.png', '/icon.png'];

const SERVICE_WORKER_SOURCE = `
const CACHE_NAME = ${JSON.stringify(CACHE_NAME)};
const PRECACHE_URLS = ${JSON.stringify(PRECACHE_URLS)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  // Take over from any previous worker immediately rather than waiting
  // for every open tab to close — see the Phase 7E "update safety"
  // requirement: a controlled refresh is preferred over devices being
  // silently trapped on stale code for an entire conference day.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Never intercept navigations (HTML page loads) — always hit the
  // network so the server's real auth/role/assignment check runs on
  // every visit. This is the single most important line in this file.
  if (request.mode === 'navigate') return;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!PRECACHE_URLS.includes(url.pathname)) return;

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
`;

export async function GET() {
  return new Response(SERVICE_WORKER_SOURCE, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Never let an intermediary/browser cache the worker script
      // itself beyond what the browser's own SW update check already
      // does — the whole update-safety story depends on the browser
      // being able to fetch a fresh copy of this route on its periodic
      // update check.
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
    },
  });
}
