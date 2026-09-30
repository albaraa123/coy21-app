import type { NavGroup, NavItem } from './nav-types';

export const adminDashboardItem: NavItem = {
  labelKey: 'nav.dashboard',
  href: '/dashboard',
  iconKey: 'dashboard',
};

export const adminNavGroups: NavGroup[] = [
  {
    labelKey: 'nav.groups.participants',
    items: [
      { labelKey: 'nav.participants.applications', href: '/applications',          iconKey: 'applications' },
      { labelKey: 'nav.participants.accounts',     href: '/participants/accounts', iconKey: 'accounts' },
      { labelKey: 'nav.participants.import',       href: '/participants/import',   iconKey: 'import' },
      { labelKey: 'nav.participants.care',         href: '/participants/care',     iconKey: 'care' },
      { labelKey: 'nav.participants.travel',       href: '/participants/travel',   iconKey: 'travel' },
      { labelKey: 'nav.participants.arrivals',     href: '/participants/arrivals', iconKey: 'arrivals' },
      { labelKey: 'nav.participants.funding',      href: '/participants/funding',  iconKey: 'funding' },
    ],
  },
  {
    labelKey: 'nav.groups.agenda',
    items: [
      { labelKey: 'nav.agenda.sessions', href: '/agenda/sessions', iconKey: 'agenda' },
      { labelKey: 'nav.agenda.days',     href: '/agenda/days',     iconKey: 'schedule' },
      { labelKey: 'nav.agenda.rooms',    href: '/agenda/rooms',    iconKey: 'map' },
      { labelKey: 'nav.agenda.tracks',   href: '/agenda/tracks',   iconKey: 'allocation' },
      { labelKey: 'nav.agenda.people',   href: '/agenda/people',   iconKey: 'participants' },
    ],
  },
  {
    labelKey: 'nav.groups.allocation',
    items: [
      { labelKey: 'nav.allocation.runs',    href: '/allocation/runs',       iconKey: 'allocation' },
      { labelKey: 'nav.schedules.overview', href: '/allocation/schedules',  iconKey: 'schedule' },
    ],
  },
  {
    labelKey: 'nav.groups.attendance',
    items: [
      { labelKey: 'nav.attendance.scanners',   href: '/attendance/scanners',   iconKey: 'attendance' },
      { labelKey: 'nav.attendance.admissions', href: '/attendance/admissions', iconKey: 'applications' },
      { labelKey: 'nav.attendance.demand',     href: '/attendance/demand',     iconKey: 'demand' },
    ],
  },
  {
    labelKey: 'nav.groups.reporting',
    items: [
      { labelKey: 'nav.reports',        href: '/reports',        iconKey: 'reports' },
      { labelKey: 'nav.communications', href: '/communications', iconKey: 'communications' },
    ],
  },
  {
    labelKey: 'nav.groups.staff',
    items: [
      { labelKey: 'nav.staff.list',        href: '/staff',             iconKey: 'profile' },
      { labelKey: 'nav.staff.assignments', href: '/staff/assignments', iconKey: 'schedule' },
    ],
  },
  {
    labelKey: 'nav.groups.settings',
    items: [
      { labelKey: 'nav.settings.email', href: '/settings', iconKey: 'settings' },
    ],
  },
];
