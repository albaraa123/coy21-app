import type { NavItem } from './nav-types';

export const participantNavItems: NavItem[] = [
  { labelKey: 'nav.participant.dashboard',   href: '/my-dashboard',   iconKey: 'dashboard' },
  { labelKey: 'nav.participant.agenda',      href: '/my-agenda',      iconKey: 'schedule' },
  { labelKey: 'nav.participant.schedule',    href: '/schedule',        iconKey: 'allocation' },
  { labelKey: 'nav.participant.application', href: '/my-application', iconKey: 'applications' },
  { labelKey: 'nav.participant.myQr',        href: '/my-qr',          iconKey: 'qr' },
  { labelKey: 'nav.participant.travel',      href: '/my-travel',      iconKey: 'travel' },
  { labelKey: 'nav.participant.venueMap',    href: '/venue-map',      iconKey: 'map' },
  { labelKey: 'nav.participant.localInfo',   href: '/local-info',     iconKey: 'info' },
  { labelKey: 'nav.participant.profile',     href: '/my-profile',     iconKey: 'profile' },
];
