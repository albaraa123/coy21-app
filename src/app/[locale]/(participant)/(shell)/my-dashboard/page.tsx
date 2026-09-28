// src/app/[locale]/(participant)/(shell)/my-dashboard/page.tsx
// (real path is (participant)/(shell)/my-dashboard/ — NOT a literal
// (participant)/my-dashboard/. (shell) is the sibling route group holding
// every page that gets the full AppShell, as opposed to (bare) for
// claim/register — see (participant)/(shell)/layout.tsx's and
// (participant)/(bare)/layout.tsx's doc comments for the full
// architectural explanation. This file's own directory placement mirrors
// my-application/page.tsx and schedule/page.tsx exactly, both of which
// already live under (shell)/.)
//
// Task 11: the real participant dashboard — previously only a
// gated-but-empty route (no page.tsx existed under (shell)/my-dashboard at
// all before this task). Calls the 3 functions from
// src/lib/dashboard/participant-dashboard-queries.ts (Task 10):
// getMyApplicationStatus, getMyClaimState, getMySchedulePublicationState.
//
// DENSITY: deliberately SPARSE — a welcome heading, a short claim/account
// notice (only shown pre-claim), an application-status card, and a
// schedule-publication notice, each with generous whitespace. This is a
// real structural contrast with the admin dashboard's dense metric grid,
// not the same layout with less data plugged in.
//
// PRIVACY: the welcome label reads the caller's OWN profiles.full_name via
// (shell)/layout.tsx's already-fetched pattern (this page performs its own
// minimal profile read for the same reason every other page in this repo
// re-fetches rather than trusting a layout-passed prop) — never a raw DB
// row forwarded further than the sanitized name string itself.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/states/error-state';
import { UnauthorizedState } from '@/components/states/unauthorized-state';
import {
  getMyApplicationStatus,
  getMyClaimState,
  getMySchedulePublicationState,
  type DashboardParticipantCaller,
} from '@/lib/dashboard/participant-dashboard-queries';

export default async function MyDashboardPage() {
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
  const caller: DashboardParticipantCaller = { userId: user.id, service };

  const { data: profile } = await service.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  // Safe display name: the caller's own profile row, read here and reduced
  // to a single sanitized string before anything else touches it — never
  // passed further as a raw row (mirrors AppShell's userDisplay boundary,
  // see app-shell.tsx's doc comment on the same rule).
  const displayName = profile?.full_name || user.email || '';

  const [applicationStatus, claimState, schedulePublication] = await Promise.all([
    getMyApplicationStatus(caller),
    getMyClaimState(caller, supabase),
    getMySchedulePublicationState(caller),
  ]);

  const t = await getTranslations({ locale, namespace: 'participantDashboard' });
  const tStatus = await getTranslations({ locale, namespace: 'status' });
  const tStates = await getTranslations({ locale, namespace: 'states' });
  const tShell = await getTranslations({ locale, namespace: 'shell' });
  const unauthorizedDestination = { href: '/dashboard', label: tShell('unauthorized.toAdminDashboard') };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 md:p-10">
      <div>
        <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">{t('welcome', { name: displayName })}</h1>
      </div>

      {/* Claim / account-linked notice — only shown pre-claim. Once
          getMyClaimState indicates claimed: true, no invitation-oriented
          copy is shown anywhere on this page. */}
      {claimState.kind === 'data' && !claimState.value.claimed && (
        <Card className="border-gold/40 bg-gold/5">
          <p className="text-sm font-medium text-charcoal dark:text-gray-100">{t('claim.pendingTitle')}</p>
          <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('claim.pendingDescription')}</p>
        </Card>
      )}
      {claimState.kind === 'unauthorized' && <UnauthorizedState destination={unauthorizedDestination} />}
      {claimState.kind === 'error' && <ErrorState title={tStates('error.title')} description={claimState.message} />}

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('application.title')}</h2>
        {applicationStatus.kind === 'data' && (
          <div className="flex items-center gap-2">
            <Badge variant={applicationStatus.value.status === 'accepted' ? 'changed' : 'neutral'}>
              {tStatus(applicationStatus.value.status)}
            </Badge>
          </div>
        )}
        {applicationStatus.kind === 'empty' && (
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('application.empty')}</p>
        )}
        {applicationStatus.kind === 'unauthorized' && <UnauthorizedState destination={unauthorizedDestination} />}
        {applicationStatus.kind === 'error' && (
          <ErrorState title={tStates('error.title')} description={applicationStatus.message} />
        )}
        <div className="mt-3">
          <Link href="/my-application" className="text-sm font-medium text-turquoise hover:underline">
            {t('application.linkLabel')}
          </Link>
        </div>
      </Card>

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('schedule.title')}</h2>
        {schedulePublication.kind === 'data' && (
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('schedule.published')}</p>
        )}
        {schedulePublication.kind === 'empty' && (
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('schedule.notPublished')}</p>
        )}
        {schedulePublication.kind === 'unauthorized' && <UnauthorizedState destination={unauthorizedDestination} />}
        {schedulePublication.kind === 'error' && (
          <ErrorState title={tStates('error.title')} description={schedulePublication.message} />
        )}
        <div className="mt-3">
          <Link href="/schedule" className="text-sm font-medium text-turquoise hover:underline">
            {t('schedule.linkLabel')}
          </Link>
        </div>
      </Card>
    </div>
  );
}
