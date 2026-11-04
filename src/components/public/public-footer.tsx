/**
 * Public site footer. Server component — no interaction state needed
 * (SocialLinks is a small client island for its translated labels, same
 * pattern as LanguageSwitcher elsewhere in this codebase).
 * Privacy/Terms/Accessibility/Contact links, plus real social links for
 * the two organizers and the Arab Youth Summit for Climate Action,
 * supplied directly by the user — previously omitted deliberately
 * because no real URLs existed yet (see social-links.tsx).
 */
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { PUBLIC_FOOTER_LINKS } from '@/lib/content/public-content';
import { SocialLinks } from './social-links';

const INCIDENT_REPORT_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSfj3jtwQhjcm7yhstBSVZCVAPGW5VDKiZvntsoe9IJaZrdCfQ/viewform?usp=header';

export function PublicFooter() {
  const t = useTranslations('public');
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-charcoal/10 bg-warm-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <p className="text-sm text-charcoal/70">{t('footer.tagline')}</p>

          <div className="mt-6 flex items-start gap-4 rounded-lg border border-charcoal/10 bg-white p-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- static public asset, no next/image optimization needed for a small fixed footer icon */}
            <img
              src="/incident-report-qr.png"
              alt={t('footer.incidentReportLinkLabel')}
              width={88}
              height={88}
              className="h-22 w-22 shrink-0 rounded border border-charcoal/10"
            />
            <div>
              <h2 className="text-sm font-semibold text-charcoal">{t('footer.incidentReportHeading')}</h2>
              <p className="mt-1 text-xs text-charcoal/70">{t('footer.incidentReportDescription')}</p>
              <a
                href={INCIDENT_REPORT_FORM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-xs font-medium text-green underline hover:text-charcoal"
              >
                {t('footer.incidentReportLinkLabel')}
              </a>
            </div>
          </div>
        </div>

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

