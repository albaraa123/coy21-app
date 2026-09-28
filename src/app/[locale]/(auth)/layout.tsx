// src/app/[locale]/(auth)/layout.tsx
//
// Task 7: shared chrome for log-in/ and sign-up/ — a centered, branded
// card with the logo, no sidebar/topbar (these are pre-authentication
// pages; there is no signed-in user yet for AppShell's nav/UserMenu to
// describe). Structurally this mirrors the established
// (participant)/(bare)/layout.tsx exactly (same centered-card-with-logo
// shape, same reasoning: a minimal branded wrapper for a small number of
// simple, linear, pre-shell pages) — see that file's doc comment for the
// full rationale of why a minimal wrapper is the right shape for pages
// like this, which this layout reuses rather than re-deriving.
//
// This layout performs NO auth check and NO redirect of its own, exactly
// like (bare)/layout.tsx: log-in/page.tsx and sign-up/page.tsx each
// remain fully responsible for their own auth flow (sign-in/sign-up
// calls, error handling, and — new in this task — log-in's
// server-verified role-aware redirect via resolvePostLoginRedirectAction).
// Adding a check here would be redundant at best (nothing to gate; both
// pages are meant to be reachable while signed out) and wrong at worst
// (an authenticated user revisiting /log-in should still see the form,
// not be silently bounced by this layout before the page itself can
// decide anything).
import Image from 'next/image';
import { Link } from '@/i18n/routing';
import { Blob } from '@/components/motion/blob';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-12">
      <div
        aria-hidden="true"
        className="animate-gradient-drift absolute inset-0 -z-10 dark:hidden"
        style={{
          backgroundImage:
            'linear-gradient(135deg, color-mix(in srgb, var(--color-turquoise) 22%, var(--color-warm-white)) 0%, color-mix(in srgb, var(--color-green) 16%, var(--color-warm-white)) 50%, color-mix(in srgb, var(--color-gold) 20%, var(--color-warm-white)) 100%)',
        }}
      />
      <div aria-hidden="true" className="absolute inset-0 -z-10 hidden bg-gray-950 dark:block" />
      <Blob color="turquoise" className="left-[-8%] top-[-8%] h-64 w-64" />
      <Blob color="gold" className="bottom-[-10%] right-[-6%] h-72 w-72" />

      <div data-reveal="visible" className="mb-6">
        <Link href="/" className="flex items-center">
          <Image
            src="/brand/logo/logo-horizontal-color.svg"
            alt="COY21 Türkiye 2026"
            width={180}
            height={36}
            className="h-9 w-auto"
            priority
          />
        </Link>
      </div>
      <div
        data-reveal="visible"
        className="w-full max-w-md rounded-lg border border-charcoal/10 bg-white/90 p-6 shadow-lg backdrop-blur-sm dark:border-gray-800 dark:bg-gray-900/90"
        style={{ borderTop: '4px solid var(--color-turquoise)' }}
      >
        {children}
      </div>
    </div>
  );
}
