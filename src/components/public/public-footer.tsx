/**
 * Public site footer. Server component â€” no interaction state needed
 * (SocialLinks is a small client island for its translated labels, same
 * pattern as LanguageSwitcher elsewhere in this codebase).
 * Privacy/Terms/Accessibility/Contact links, plus real social links for
 * the two organizers and the Arab Youth Summit for Climate Action,
 * supplied directly by the user â€” previously omitted deliberately
 * because no real URLs existed yet (see social-links.tsx).
 */
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { PUBLIC_FOOTER_LINKS } from '@/lib/content/public-content';
import { SocialLinks } from './social-links';

export function PublicFooter() {
  const t = useTranslations('public');
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-charcoal/10 bg-warm-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 md:flex-row md:items-start md:justify-between">
        <p className="max-w-sm text-sm text-charcoal/70">{t('footer.tagline')}</p>

        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-charcoal/50">
            {t('footer.linksHeading')}
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {PUBLIC_FOOTER_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="text-sm text-charcoal/80 hover:text-charcoal">
                  {t(`nav.${link.labelKey}`)}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-charcoal/50">
            {t('pages.contact.followUsHeading')}
          </h2>
          <SocialLinks className="mt-3 flex flex-col gap-2" />
        </div>
      </div>

      <div className="border-t border-charcoal/10 px-4 py-4">
        <p className="mx-auto max-w-6xl text-xs text-charcoal/50">
          COY21 Türkiye 2026 &copy; {year}. {t('footer.rights')}
        </p>
      </div>
    </footer>
  );
}

