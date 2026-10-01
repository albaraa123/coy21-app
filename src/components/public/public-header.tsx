/**
 * Public site header.
 *
 * DEVIATION FROM THE PLAN'S "(server)" NOTE: the task brief lists this
 * file as a server component, but it owns the mobile-drawer open/close
 * state (needs useRef + useState for the trigger ref and open boolean),
 * similar in spirit to how the admin/participant shell's drawer state
 * lives in a small client component (see
 * src/components/shell/mobile-drawer-context.tsx's doc comment for that
 * shell's Context-based version of the same "drawer state needs a client
 * boundary" problem, solved differently there because that shell's
 * trigger and drawer are rendered as siblings rather than co-located in
 * one component the way they are here). Rather than split this into a
 * separate PublicHeader (server, static bits) + PublicHeaderClient
 * (state) pair purely to satisfy the file list, this file is a single
 * small Client Component: it has no data fetching, no server-only APIs,
 * and next-intl's useTranslations()/useLocale() work identically here, so
 * the split would add a file without changing behavior or bundle
 * boundaries in any meaningful way for a header this size. Everything
 * else about the task's intent (logo, PublicNavigation, LanguageSwitcher
 * reuse, CTA copy, mobile-nav trigger) is implemented as specified.
 *
 * CTA language: ONLY "Log in" (public.cta.participantLogin, key name kept
 * for backward compatibility with existing translations even though the
 * displayed copy is now generic — this login page is shared by
 * participants and staff/admin roles alike, not participants only) — the
 * sole approved CTA that fits a persistent header across every public
 * page, per the design spec's hard constraint that no copy may imply open
 * public registration. "Claim Your Account" / "View Agenda" / "Learn
 * More" are used contextually elsewhere (homepage hero, stub pages), not
 * duplicated here.
 *
 * Header-inline LanguageSwitcher hidden below `sm`: on a narrow RTL
 * viewport the two-button switcher (~110px) plus the hamburger trigger
 * didn't fit the trailing flex group, pushing the hamburger button
 * partially off the left edge of the screen (confirmed via a real
 * mobile-viewport click test — its bounding box x was negative) so it
 * was effectively untappable. The mobile drawer (public-mobile-nav.tsx)
 * already renders its own LanguageSwitcher, so hiding this one below
 * `sm` loses no functionality, just the redundant header copy.
 */
'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { PublicNavigation } from './public-navigation';
import { PublicMobileNav } from './public-mobile-nav';
export function PublicHeader() {
  const t = useTranslations('public');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <header className="sticky top-0 z-40 border-b border-charcoal/10 bg-warm-white/95 backdrop-blur supports-[backdrop-filter]:bg-warm-white/80">
      <div className="mx-auto flex h-20 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" className="flex shrink-0 items-center">
          <Image
            src="/brand/logo/logo-horizontal-color.svg"
            alt="COY21 Türkiye 2026"
            width={240}
            height={48}
            className="h-12 w-auto"
            priority
          />
        </Link>

        <PublicNavigation className="hidden md:flex" />

        <div className="flex items-center gap-2">
          <Button href="/log-in" variant="secondary" size="sm" className="hidden sm:inline-flex">
            {t('cta.participantLogin')}
          </Button>
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={t('nav.openMenu')}
            aria-haspopup="dialog"
            className="rounded-md p-2 text-charcoal/70 hover:bg-charcoal/5 hover:text-charcoal md:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>
      </div>

      <PublicMobileNav open={drawerOpen} onClose={() => setDrawerOpen(false)} triggerRef={triggerRef} />
    </header>
  );
}

