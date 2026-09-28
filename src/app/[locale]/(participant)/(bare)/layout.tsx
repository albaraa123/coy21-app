// src/app/[locale]/(participant)/(bare)/layout.tsx
//
// Shell exception for claim/page.tsx and register/page.tsx (Step 3 of
// Task 6's plan). Neither of these two pages goes through the full
// participant shell (sidebar/topbar/nav, rendered by the sibling
// (shell)/layout.tsx via the shell component from
// @/components/shell/app-shell) — this layout gives them a minimal,
// branded, centered-card wrapper instead.
//
// WHY: claim/page.tsx is explicitly documented (read the file itself,
// top-of-file comment) as a pre-claim, pre-authentication-in-the-normal-
// sense state — it's 'use client' and does its own client-side session
// detection via onAuthStateChange, because a server-rendered check would
// incorrectly read "no session" on the very request the invite link
// produces (the PKCE code-for-session exchange only happens in the
// browser). It genuinely cannot sit inside (shell)/layout.tsx, which
// performs a server-side auth.getUser() check and redirects to /log-in
// on no session — that would incorrectly bounce every legitimately
// invited user before their client-side exchange ever runs.
//
// register/page.tsx is a GENUINELY DIFFERENT, independently-verified
// flow: it IS already-authenticated (calls createClient() server-side,
// checks supabase.auth.getUser(), redirects to /log-in itself if no
// user), it's feature-flagged (isSelfRegistrationEnabled(), notFound()
// if disabled), and it's a participant filling out/editing a DRAFT
// application before submission. It does NOT need claim's client-side
// session-detection workaround. It is grouped into this same (bare)
// layout for a SEPARATE, independently-justified reason: it is a simple,
// linear, single-purpose form page, and the full sidebar/dashboard shell
// (with nav to "My Schedule" etc.) is not meaningful yet for a
// participant who hasn't finished their initial application — those nav
// destinations either don't have real data yet or don't apply. This is a
// deliberate UX choice for register, not an assumption that it mirrors
// claim's auth mechanics.
//
// TECHNIQUE: (bare) is a route group (parenthesized, not in the URL)
// nested inside (participant), as a SIBLING of (shell) (which holds
// my-application/ and schedule/ and owns the full-shell-rendering
// layout). Next.js layouts nest by filesystem position, not by route
// group name — a route group only strips its own segment from the URL,
// it does not "escape" the layout tree of its parent directories. So
// nesting (bare) as a sibling of (shell), both directly under
// (participant), means:
//   - (participant)/(shell)/layout.tsx wraps ONLY my-application/ and
//     schedule/ (the full sidebar/topbar shell).
//   - (participant)/(bare)/layout.tsx (this file) wraps ONLY claim/ and
//     register/ (this minimal card).
//   - There is intentionally NO layout.tsx directly at (participant)/ —
//     it was removed; if one existed there, it would wrap BOTH (shell)
//     and (bare) since both are its filesystem children, which is
//     exactly what Step 3 forbids.
// URLs are unaffected: /claim and /register (in both /ar and /en) keep
// their exact existing paths, since (participant) and (bare) are both
// non-rendering path segments.
//
// This layout deliberately performs NO auth check and NO redirect of its
// own — claim/page.tsx and register/page.tsx already each do their own
// (client-side session detection, and server-side getUser() + redirect,
// respectively; see their own files). Adding a check here would either
// duplicate that logic incorrectly (this is a Server Component; it
// cannot replicate claim's client-side onAuthStateChange workaround) or
// risk contradicting it. This layout is chrome-only.
import Image from 'next/image';
import { Link } from '@/i18n/routing';

export default function ParticipantBareLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-warm-white px-4 py-12 dark:bg-gray-950">
      <div className="mb-6">
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
      <div className="w-full max-w-md rounded-lg border border-charcoal/10 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        {children}
      </div>
    </div>
  );
}
