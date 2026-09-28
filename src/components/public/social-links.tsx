'use client';

// Real social-media links for the three organizing/related bodies,
// supplied directly by the user (not invented). Rendered as icon-only
// links (Instagram + LinkedIn), grouped per organization so it's clear
// whose account is whose rather than one ambiguous flat icon row.
// Icons are inline SVG (no new icon-library dependency), sized for a
// comfortable touch target on mobile. 'use client' only because
// useTranslations is needed for accessible per-organization labels
// ("Madad for Development on Instagram", not a bare "Instagram" repeated
// three times with no way to tell the links apart via a screen reader).
import { useTranslations } from 'next-intl';

const ORGANIZATIONS = [
  {
    nameKey: 'madadName',
    instagram: 'https://www.instagram.com/coy.youngo/',
    linkedin: 'https://www.linkedin.com/company/coy19baku/posts/?feedView=all',
  },
] as const;

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path d="M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1 4.98 2.12 4.98 3.5zM.5 8h4V23h-4V8zM8.5 8h3.8v2.05h.05c.53-1 1.83-2.05 3.77-2.05C20.5 8 21.5 10.4 21.5 13.6V23h-4v-8.3c0-2-.04-4.6-2.8-4.6-2.8 0-3.2 2.2-3.2 4.45V23h-4V8z" />
    </svg>
  );
}

export function SocialLinks({
  className = '',
  showNames = false,
}: {
  className?: string;
  showNames?: boolean;
}) {
  const t = useTranslations('public.pages.contact');

  return (
    <div className={className}>
      {ORGANIZATIONS.map((org) => {
        const name = t(org.nameKey);
        return (
          <div key={org.nameKey} className="flex items-center gap-2">
            {showNames && <span className="me-1 text-sm text-charcoal/70">{name}</span>}
            <a
              href={org.instagram}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${name} · Instagram`}
              title={`${name} · Instagram`}
              className="rounded-md p-1.5 text-charcoal/60 transition-colors hover:bg-charcoal/5 hover:text-charcoal"
            >
              <InstagramIcon />
            </a>
            <a
              href={org.linkedin}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${name} · LinkedIn`}
              title={`${name} · LinkedIn`}
              className="rounded-md p-1.5 text-charcoal/60 transition-colors hover:bg-charcoal/5 hover:text-charcoal"
            >
              <LinkedInIcon />
            </a>
          </div>
        );
      })}
    </div>
  );
}
