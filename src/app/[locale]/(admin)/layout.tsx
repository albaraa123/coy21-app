// src/app/[locale]/(admin)/layout.tsx
//
// Authorization-gated shell for every admin route. This is an ADDITIONAL
// defense-in-depth layer, not a replacement for each page's own auth
// check — every page under (admin)/ (participants/page.tsx,
// applications/page.tsx, etc.) already independently re-fetches the
// user and profile.role and calls notFound() on failure, and that
// remains fully in place and authoritative. This layout adds a second,
// earlier check purely to decide what CHROME to render around the page:
// the full AppShell for staff, or UnauthorizedState for anyone else who
// reaches an admin URL. It intentionally does NOT use notFound() the way
// pages do — the approved plan calls for a role-appropriate
// UnauthorizedState with a real "go here instead" destination, since a
// participant landing on an admin URL is a routing mistake, not a
// not-found situation.
//
// Query pattern (createClient() + createServiceRoleClient() for the
// profiles.role read) mirrors participants/page.tsx and
// applications/page.tsx exactly — see those files.
//
// The role -> human label mapping happens HERE, in this server
// component, via role-label.ts + this module's own `t` call — the raw
// user_role enum value is never passed to AppShell/Topbar/UserMenu (see
// app-shell.tsx's and user-menu.tsx's doc comments on that boundary).
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/shell/app-shell';
import { UnauthorizedState } from '@/components/states/unauthorized-state';
import { adminNavGroups } from '@/lib/nav/admin-nav-config';
import { filterAdminNavGroups } from '@/lib/nav/admin-nav-visibility';
import { buildNavTranslations } from '@/lib/nav/build-nav-translations';
import { decideAdminAccess } from '@/lib/shell/admin-access';
import { roleLabelKey } from '@/lib/shell/role-label';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role, full_name').eq('id', user.id).maybeSingle();

  const decision = decideAdminAccess(user.id, profile?.role);
  const t = await getTranslations({ locale, namespace: 'shell' });
  const tNav = await getTranslations({ locale, namespace: 'nav' });
  // Hide sidebar links the signed-in role cannot actually open (each still
  // has its own independent page-level check — see admin-nav-visibility.ts).
  const visibleNavGroups = filterAdminNavGroups(adminNavGroups, profile?.role);
  // Resolve every real nav labelKey to plain, translated text HERE,
  // server-side — buildNavTranslations calls the live `tNav` function once
  // per key and returns a plain Record<string, string>. Only that plain
  // object (never `tNav` itself) may cross into AppShell's Client
  // Component children (SidebarNav/MobileDrawer) — see app-shell.tsx's
  // doc comment on the RSC boundary this fixes.
  const navTranslations = buildNavTranslations(visibleNavGroups, tNav);

  if (decision.kind === 'redirect-unauthenticated') {
    // Unreachable given the guard above (user.id is always set here), but
    // kept so decideAdminAccess's full return type is handled explicitly
    // rather than assumed away.
    redirect({ href: '/log-in', locale });
    return;
  }

  if (decision.kind === 'unauthorized') {
    return (
      <UnauthorizedState
        destination={{ href: decision.destinationHref, label: t('unauthorized.toParticipantDashboard') }}
      />
    );
  }

  const key = roleLabelKey(profile?.role);
  const userDisplay = {
    name: profile?.full_name || user.email || '',
    roleLabel: key ? t(key) : t('roles.participant'),
  };

  return (
    <AppShell
      navGroups={visibleNavGroups}
      storageKey="rcoy-admin-nav-v1"
      userDisplay={userDisplay}
      locale={locale}
      logoutLabel={t('logoutLabel')}
      drawerAriaLabel={t('drawerAriaLabel')}
      triggerAriaLabel={t('triggerAriaLabel')}
      navTranslations={navTranslations}
    >
      {children}
    </AppShell>
  );
}
