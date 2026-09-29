import type { NavItem } from './nav-types';

export const participantNavItems: NavItem[] = [
  { labelKey: 'nav.participant.dashboard',   href: '/my-dashboard',   iconKey: 'dashboard',   placement: 'primary' },
  { labelKey: 'nav.participant.agenda',      href: '/my-agenda',      iconKey: 'schedule',    placement: 'primary' },
  { labelKey: 'nav.participant.myQr',        href: '/my-qr',          iconKey: 'qr',          placement: 'primary' },
  { labelKey: 'nav.participant.schedule',    href: '/schedule',        iconKey: 'allocation',  placement: 'more' },
  { labelKey: 'nav.participant.application', href: '/my-application', iconKey: 'applications', placement: 'more' },
  { labelKey: 'nav.participant.travel',      href: '/my-travel',      iconKey: 'travel',       placement: 'more' },
  { labelKey: 'nav.participant.venueMap',    href: '/venue-map',      iconKey: 'map',          placement: 'more' },
  { labelKey: 'nav.participant.localInfo',   href: '/local-info',     iconKey: 'info',         placement: 'more' },
  { labelKey: 'nav.participant.profile',     href: '/my-profile',     iconKey: 'profile',      placement: 'more' },
];
