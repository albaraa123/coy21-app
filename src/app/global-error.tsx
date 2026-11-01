// src/app/global-error.tsx
//
// Catches errors thrown ABOVE every route-group error.tsx -- specifically
// in src/app/[locale]/layout.tsx itself (its own await params/hasLocale/
// notFound(), or NextIntlClientProvider) -- which none of the 4 existing
// (admin)/(public)/(participant)/scanner error.tsx boundaries can catch,
// since error.js sits below layout.js in the component hierarchy (see
// those files' own doc comments for the same point). Without this file,
// a throw at that level shows Next.js's raw, unstyled default crash
// screen instead of anything matching this app's design.
//
// Per Next.js's own docs (node_modules/next/dist/docs/01-app/03-api-
// reference/03-file-conventions/error.md): global-error "must define its
// own <html> and <body> tags, global styles, fonts, or other
// dependencies" (it replaces the root layout entirely when active), and
// `metadata`/`generateMetadata` exports are unsupported here. Kept
// deliberately minimal -- no next-intl (no locale context exists this
// high up; this fires before/outside LocaleLayout ever renders), no
// custom font import -- so this fallback has as little as possible that
// could itself fail. globals.css is imported directly for the design
// tokens/base styles (:root color tokens, body defaults); Tailwind
// utility classes below resolve against those same tokens exactly as
// everywhere else in the app.
//
// reset() (not the newer unstable_retry(), added in v16.2.0) to match
// the deliberate choice already made in every other error.tsx in this
// app -- see (admin)/error.tsx's doc comment for the same reasoning.
'use client';

import './globals.css';

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" dir="ltr">
      <body className="flex min-h-screen items-center justify-center bg-warm-white p-8 dark:bg-gray-950">
        <title>COY21 Türkiye 2026</title>
        <div
          role="alert"
          className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-charcoal/10 bg-white p-8 text-center shadow-sm dark:border-gray-700 dark:bg-gray-900"
        >
          <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">Something went wrong</h1>
          <p className="text-sm text-charcoal/70 dark:text-gray-400">
            An unexpected error occurred. Please try again, or reload the page if the problem continues.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-2 rounded-md bg-turquoise px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
