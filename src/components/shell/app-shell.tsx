/**
 * AppShell — server shell. No 'use client', no usePathname, no
 * localStorage anywhere in this file, per Task 5's brief.
 *
 * Props:
 *  - navGroups: NavGroup[] (Task 4's nav-types.ts). Callers pass either
 *    adminNavGroups directly, or participantNavItems wrapped in a single
 *    synthetic ungrouped NavGroup (labelKey: '') — see the module doc in
 *    sidebar-nav.tsx for why an empty labelKey signals "flat list, no
 *    group UI" to SidebarNav/MobileDrawer.
 *  - userDisplay: { name, roleLabel } — ALREADY SANITIZED, pre-resolved
 *    display data. This component takes it purely as a prop and performs
 *    NO additional data fetching, NO raw DB row access, and NO role-enum
 *    handling of its own. The caller (a later task's server component
 *    that knows the authenticated user) is solely responsible for
 *    sanitizing/resolving this from a raw DB row before it ever reaches
 *    AppShell. This is the authorization/privacy boundary the task brief
 *    requires.
 *  - locale: string — drives LanguageSwitcher's current-locale display
 *    and dir-sensitive styling elsewhere in the tree.
 *  - navTranslations: Record<string, string> — a PLAIN, serializable map of
 *    every navGroups `labelKey` (e.g. "nav.groups.participants") to its
 *    real, translated display text (Task 12, bug-fixed). Built by the
 *    caller server-side via src/lib/nav/build-nav-translations.ts's
 *    buildNavTranslations(), which calls next-intl's real
 *    getTranslations({ namespace: 'nav' }) function ONCE PER KEY and
 *    returns a plain object — never the live translate function itself.
 *    A raw function value can never legally cross from this Server
 *    Component into SidebarNav/MobileDrawer ('use client'); only plain
 *    data can (see the Composition note below — this is the same class of
 *    bug that renderTopbar was rewritten to avoid). This component performs
 *    no i18n resolution itself, it only forwards the plain map down to
 *    SidebarNav/MobileDrawer, which look up `navTranslations[item.labelKey]`
 *    per NavItem/NavGroup. `labelKey` itself is never replaced by
 *    translated text anywhere in the NavGroup/NavItem data (see
 *    sidebar-nav.tsx's doc comment on why it must stay a stable,
 *    locale-independent identity string).
 *  - children: the routed page content, rendered inside <main>.
 *  - bottomTabItems / moreLabel (both optional): opt-in participant-only
 *    bottom tab bar. Omitted entirely by (admin)/layout.tsx's call site,
 *    which keeps admin behavior byte-for-byte identical to before this
 *    prop pair existed. When provided (currently only by
 *    (participant)/(shell)/layout.tsx), AppShell renders
 *    BottomTabBarClientWrapper ('use client', mirrors MobileDrawerTrigger's
 *    role) as a further sibling inside MobileDrawerProvider — it reads
 *    usePathname() and reuses useMobileDrawer()'s existing setOpen(true)
 *    for the "More" tab, opening the SAME MobileDrawer instance already
 *    wired up below, rather than any new state. <main> gets extra bottom
 *    padding (pb-16 md:pb-0) whenever the tab bar is present so fixed-
 *    positioned tab bar never overlaps page content on mobile.
 *
 * Composition (rewritten to fix a real RSC boundary violation — see the
 * bug-fix commit this replaced): AppShell renders Topbar (server)
 * DIRECTLY, passing it a `<MobileDrawerTrigger />` instance (a Client
 * Component instantiated FROM a Server Component and passed down as a
 * plain ReactNode prop — this direction is legal RSC composition; only
 * passing a raw FUNCTION value as a prop into a Client Component is not,
 * which was the original bug (first with `renderTopbar`, then again with
 * `translateNav` — see navTranslations above for the second fix)).
 * MobileDrawer is rendered separately, alongside the desktop SidebarNav
 * and <main>, as MobileDrawerTrigger's sibling rather than its
 * parent/child.
 *
 * Neither Topbar nor AppShell itself needs to know anything about
 * drawer-open state. That state lives in MobileDrawerProvider
 * (mobile-drawer-context.tsx), a small client Context provider wrapping
 * this whole subtree — MobileDrawerTrigger and MobileDrawer each read/
 * write it via useMobileDrawer() independently, so no function prop ever
 * needs to cross the server/client boundary to wire them together. See
 * mobile-drawer-context.tsx's doc comment for the full reasoning.
 */

import type { NavGroup, NavItem } from '@/lib/nav/nav-types';
import { Topbar } from './topbar';
import { SidebarNav } from './sidebar-nav';
import { MobileDrawer } from './mobile-drawer';
import { MobileDrawerTrigger } from './mobile-drawer-trigger';
import { MobileDrawerProvider } from './mobile-drawer-context';
import { BottomTabBarClientWrapper } from './bottom-tab-bar-client-wrapper';

export interface AppShellProps {
  navGroups: NavGroup[];
  storageKey: string;
  userDisplay: { name: string; roleLabel: string };
  locale: string;
  pageTitle?: string;
  logoutLabel: string;
  drawerAriaLabel: string;
  triggerAriaLabel: string;
  /** Plain map of NavItem/NavGroup `labelKey` -> translated display text; forwarded to SidebarNav/MobileDrawer. */
  navTranslations: Record<string, string>;
  /** Primary-placement NavItems for the participant bottom tab bar. Omit entirely for shells (e.g. admin) that don't use one. */
  bottomTabItems?: NavItem[];
  /** Label for the "More" tab. Required when bottomTabItems is provided. */
  moreLabel?: string;
  children: React.ReactNode;
}

export function AppShell({
  navGroups,
  storageKey,
  userDisplay,
  locale,
  pageTitle,
  logoutLabel,
  drawerAriaLabel,
  triggerAriaLabel,
  navTranslations,
  bottomTabItems,
  moreLabel,
  children,
}: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <MobileDrawerProvider>
        <Topbar
          locale={locale}
          pageTitle={pageTitle}
          userDisplay={userDisplay}
          logoutLabel={logoutLabel}
          mobileDrawerTrigger={<MobileDrawerTrigger ariaLabel={triggerAriaLabel} />}
        />
        <MobileDrawer
          navGroups={navGroups}
          storageKey={storageKey}
          ariaLabel={drawerAriaLabel}
          navTranslations={navTranslations}
        />
        <div className="flex flex-1">
          <aside className="hidden shrink-0 border-e border-charcoal/10 md:block md:w-64">
            <div className="sticky top-0 max-h-screen overflow-y-auto">
              {/* Desktop sidebar reuses the same client SidebarNav — it needs
                  usePathname()/localStorage exactly like the drawer's copy. */}
              <SidebarNav navGroups={navGroups} storageKey={storageKey} navTranslations={navTranslations} />
            </div>
          </aside>
          <main className={`min-w-0 flex-1 ${bottomTabItems ? 'pb-16 md:pb-0' : ''}`}>{children}</main>
        </div>
        {bottomTabItems ? (
          <BottomTabBarClientWrapper
            primaryItems={bottomTabItems}
            navTranslations={navTranslations}
            moreLabel={moreLabel ?? ''}
          />
        ) : null}
      </MobileDrawerProvider>
    </div>
  );
}
