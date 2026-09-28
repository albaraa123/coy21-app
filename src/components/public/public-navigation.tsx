// Public nav link list (Home/About/Agenda/Speakers/FAQ/Partners/Contact/
// Accessibility), reused as-is inside both the desktop header and the
// mobile drawer (see public-mobile-nav.tsx). Matches the plan's
// structural config in src/lib/content/public-content.ts (labels/hrefs
// only, real copy comes from the `public.nav` i18n namespace).
//
// 'use client': the optional onNavigate callback (used by the mobile
// drawer to close itself when a link is tapped) is a function prop, which
// cannot be passed from a Server Component parent into a Server Component
// child. next-intl's useTranslations() works identically in either
// environment, so making this a Client Component costs nothing here.
'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { PUBLIC_NAV_LINKS } from '@/lib/content/public-content';

export function PublicNavigation({ className = '', onNavigate }: { className?: string; onNavigate?: () => void }) {
  const t = useTranslations('public.nav');

  return (
    <nav className={className} aria-label={t('mainNavigation')}>
      <ul className="flex flex-col gap-1 md:flex-row md:items-center md:gap-6">
        {PUBLIC_NAV_LINKS.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              onClick={onNavigate}
              className="block rounded-md px-2 py-2 text-sm font-medium text-charcoal/80 transition-colors hover:text-charcoal md:px-0 md:py-0"
            >
              {t(link.labelKey)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
