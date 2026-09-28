/**
 * Structural config for the public site: labels/hrefs/ordering only.
 * Actual copy lives in i18n (src/messages/{en,ar}.json, `public` namespace)
 * — labelKey below is a lookup key into that namespace, mirroring the
 * pattern established by src/lib/nav/nav-types.ts (NavItem.labelKey) for
 * the admin/participant nav configs, so this file stays plain,
 * serializable data with no fabricated copy baked in.
 *
 * Note on `public.cta.claimYourAccount` / `public.cta.viewAgenda` (in
 * en.json/ar.json): both are part of the design spec's approved CTA
 * language list, but neither is wired to any component in Task 8 — this
 * task only needed "Learn More" (homepage hero) and "Participant Login"
 * (header). They're intentionally pre-staged, both-locale-complete
 * placeholders for Task 9 (e.g. a claim-account CTA on the About/FAQ
 * pages, a View Agenda CTA once /conference-agenda has real content) —
 * not dead code to be pruned.
 */

export interface PublicNavLink {
  labelKey: string;
  href: string;
}

/** Primary public navigation, in display order. */
export const PUBLIC_NAV_LINKS: PublicNavLink[] = [
  { labelKey: 'home', href: '/' },
  { labelKey: 'about', href: '/about' },
  // NOTE: cannot use '/agenda' — that path is already owned by the
  // existing staff-gated (admin)/agenda route, and Next.js route groups
  // do not affect URLs (a (public)/agenda/page.tsx would collide with
  // (admin)/agenda/page.tsx at build time: "You cannot have two parallel
  // pages that resolve to the same path", confirmed via `npm run build`
  // failing with exactly that error). '/conference-agenda' is the public,
  // attendee-facing agenda; the plain '/agenda' path remains the
  // pre-existing internal admin agenda-management area, untouched by this
  // task. See public-header.tsx/public-mobile-nav.tsx — the *label* shown
  // to visitors is still just "Agenda" (public.nav.agenda); only the href
  // differs from what the original task brief assumed.
  { labelKey: 'agenda', href: '/conference-agenda' },
  { labelKey: 'speakers', href: '/speakers' },
  { labelKey: 'faq', href: '/faq' },
  { labelKey: 'partners', href: '/partners' },
  { labelKey: 'contact', href: '/contact' },
  { labelKey: 'accessibility', href: '/accessibility' },
];

/** Footer legal/utility links (in addition to a subset of the nav above). */
export const PUBLIC_FOOTER_LINKS: PublicNavLink[] = [
  { labelKey: 'privacy', href: '/privacy' },
  { labelKey: 'terms', href: '/terms' },
  { labelKey: 'accessibility', href: '/accessibility' },
  { labelKey: 'contact', href: '/contact' },
];
