// src/app/[locale]/(participant)/(shell)/layout.tsx
//
// This is Task 6's "(participant)/layout.tsx" — the authorization-gated
// AppShell wrapper for participant routes — but placed one level deeper
// than a literal reading of the task brief, at (participant)/(shell)/,
// rather than directly at (participant)/layout.tsx. This placement is
// the load-bearing part of Step 3's shell-exception design; see the doc
// comment on the SIBLING (participant)/(bare)/layout.tsx for the full
// architectural explanation of why. Short version: Next.js layouts nest
// by FILESYSTEM position regardless of route groups (parenthesized
// segments are stripped from the URL but not from the layout tree — see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions
// /route-groups.md's "opting specific route segments into sharing a
// layout, while keeping others out" use case, which is exactly this). A
// layout.tsx placed directly at (participant)/ would wrap EVERY child
// segment including (bare)/claim and (bare)/register, which is precisely
// what Step 3 forbids. Nesting the AppShell-rendering layout one level
// down, in a (shell) route group that only my-application/ and
// schedule/ live inside, is what actually excludes (bare) from it. URLs
// are unaffected either way: (shell) and (bare) are both non-rendering
// path segments, so /my-application, /schedule, /claim, /register all
// keep their exact existing paths in both locales.
//
// Auth gate: unauthenticated -> redirect to /log-in. Any authenticated
// user reaching here is treated as the participant case — see (bare)/
// layout.tsx's doc comment for the Step 2 investigation (no page in this
// route group has ever checked profiles.role; each gates on whether the
// user owns an `applications` row instead). This layout does not
// duplicate that applications-row check — that remains each page's own
// job (my-application/page.tsx, schedule/page.tsx) — this layer only
// decides chrome (AppShell) vs. nothing, for the authenticated/
// unauthenticated split.
//
// Role -> human label mapping happens HERE (see role-label.ts), never
// passed raw into AppShell/Topbar/UserMenu — same boundary as
// (admin)/layout.tsx.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/shell/app-shell';
import { NotificationBell } from '@/components/shell/notification-bell';
import { participantNavItems } from '@/lib/nav/participant-nav-config';
import { buildNavTranslations } from '@/lib/nav/build-nav-translations';
import { roleLabelKey } from '@/lib/shell/role-label';
import type { NavGroup } from '@/lib/nav/nav-types';

// participantNavItems is a flat NavItem[] (Task 4); AppShell/SidebarNav
// expect NavGroup[]. Wrapping it in a single group with an empty
// labelKey is the documented signal (see app-shell.tsx's doc comment,
// which points at sidebar-nav.tsx) for "flat list, no group UI".
const participantNavGroups: NavGroup[] = [{ labelKey: '', items: participantNavItems }];

// The 3 primary-placement NavItems (Task 1's placement field) that the
// bottom tab bar renders directly; the rest ("more"-placement, plus
// primary items too, since the drawer still lists everything) remain
// reachable via the drawer MobileDrawer/BottomTabBarClientWrapper's
// "More" trigger already opens — see app-shell.tsx's doc comment.
const primaryTabItems = participantNavItems.filter((item) => item.placement === 'primary');

export default async function ParticipantShellLayout({ children }: { children: React.ReactNode }) {
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
  const { data: profile } = await service
    .from('profiles')
    .select('role, full_name, must_change_password')
    .eq('id', user.id)
    .maybeSingle();

  // Sub-project 6, Task 7: the caller's own application_id, for the
  // notification bell's personal Realtime channel
  // (notifications-${applicationId}) and its get_my_notifications() feed.
  // Same client/pattern as the profiles query above (service-role,
  // maybeSingle -- null is a legitimate, non-error outcome handled by
  // NotificationBell's own defensive applicationId: string | null prop).
  const { data: application } = await service
    .from('applications')
    .select('id')
    .eq('applicant_id', user.id)
    .maybeSingle();

  // Phase C (design doc section 14.9): server-side first-login password-
  // change gate. Every route under (shell)/ — my-dashboard, my-application,
  // schedule — is reached only through THIS layout, so a single check here
  // blocks all of them at once; a genuinely new-but-unpassword-changed
  // participant is redirected before any page-specific data ever loads.
  // (bare)/ (claim, register, change-password itself) is a sibling route
  // group Next.js does not nest under this layout, so it stays reachable
  // regardless of this flag — no special-casing needed.
  if (profile?.must_change_password) {
    redirect({ href: '/change-password', locale });
    return;
  }

  const t = await getTranslations({ locale, namespace: 'shell' });
  const tNav = await getTranslations({ locale, namespace: 'nav' });
  // Resolve every real nav labelKey to plain, translated text HERE,
  // server-side — see (admin)/layout.tsx's identical comment and
  // app-shell.tsx's doc comment for why only the resulting plain object
  // (never `tNav` itself) may cross into AppShell's Client Component
  // children.
  const navTranslations = buildNavTranslations(participantNavGroups, tNav);
  const key = roleLabelKey(profile?.role);
  const userDisplay = {
    name: profile?.full_name || user.email || '',
    roleLabel: key ? t(key) : t('roles.participant'),
  };

  return (
    <AppShell
      navGroups={participantNavGroups}
      storageKey="rcoy-participant-nav-v1"
      userDisplay={userDisplay}
      locale={locale}
      logoutLabel={t('logoutLabel')}
      drawerAriaLabel={t('drawerAriaLabel')}
      triggerAriaLabel={t('triggerAriaLabel')}
      navTranslations={navTranslations}
      bottomTabItems={primaryTabItems}
      moreLabel={t('moreLabel')}
      notificationBell={<NotificationBell applicationId={application?.id ?? null} />}
    >
      {children}
    </AppShell>
  );
}
