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
// all before this task). Calls the functions from
// src/lib/dashboard/participant-dashboard-queries.ts (Task 10):
// getMyApplicationStatus, getMyClaimState, getMySchedulePublicationState,
// getMyTravelCompleteness (Task 7), plus getMyQrState
// (src/lib/attendance/participant-qr.ts).
//
// Task 8: the card SET and ORDER are now status-aware, computed by the
// pure computeDashboardCardOrder() function in ./card-priority.ts (kept
// deliberately free of React/Supabase for isolated testability — see that
// file's own doc comment for the 3 representative states it implements).
// This file is responsible only for gathering inputs, calling that
// function, and rendering each returned DashboardCardId as its
// corresponding <Card> block, in the order returned.
//
// DENSITY: deliberately SPARSE — a welcome heading, a short claim/account
// notice (only shown pre-claim), and the status-aware priority cards, each
// with generous whitespace. This is a real structural contrast with the
// admin dashboard's dense metric grid, not the same layout with less data
// plugged in.
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
  getMyTravelCompleteness,
  type DashboardParticipantCaller,
} from '@/lib/dashboard/participant-dashboard-queries';
import { getMyQrState } from '@/lib/attendance/participant-qr';
import { computeDashboardCardOrder, type DashboardCardInputs } from './card-priority';

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

  const [applicationStatus, claimState, schedulePublication, travelCompleteness, qrState] = await Promise.all([
    getMyApplicationStatus(caller),
    getMyClaimState(caller, supabase),
    getMySchedulePublicationState(caller),
    getMyTravelCompleteness(caller),
    getMyQrState(caller),
  ]);

  const t = await getTranslations({ locale, namespace: 'participantDashboard' });
  const tStatus = await getTranslations({ locale, namespace: 'status' });
  const tStates = await getTranslations({ locale, namespace: 'states' });
  const tShell = await getTranslations({ locale, namespace: 'shell' });
  const unauthorizedDestination = { href: '/dashboard', label: tShell('unauthorized.toAdminDashboard') };

  // computeDashboardCardOrder requires a concrete status; fall back to
  // 'submitted' (the safest "not yet accepted" default) when the query
  // returned 'empty' or 'error' — those cases are still surfaced to the
  // user via the applicationStatus card's own kind-based branches below,
  // this fallback only affects which cards are shown/ordered, not what's
  // displayed inside them.
  const cardInputs: DashboardCardInputs = {
    applicationStatus: applicationStatus.kind === 'data' ? (applicationStatus.value.status as DashboardCardInputs['applicationStatus']) : 'submitted',
    travelSubmitted: travelCompleteness.kind === 'data' && travelCompleteness.value.submitted,
    qrAvailable: qrState.kind === 'QR_AVAILABLE',
  };
  const cardOrder = computeDashboardCardOrder(cardInputs);

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

      {/* Status-aware priority cards — set AND order both come from
          computeDashboardCardOrder() (card-priority.ts). Iterating
          cardOrder (not a fixed conditional layout) is what makes this
          genuinely status-driven rather than a static arrangement. */}
      {cardOrder.map((cardId) => {
        switch (cardId) {
          case 'applicationStatus':
            return (
              <Card key={cardId}>
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
            );

          case 'completeTravelInfo':
            return (
              <Card key={cardId} className="border-turquoise/40 bg-turquoise/5">
                <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('completeTravelInfo.title')}</h2>
                <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('completeTravelInfo.description')}</p>
                <div className="mt-3">
                  <Link href="/my-travel" className="text-sm font-medium text-turquoise hover:underline">
                    {t('completeTravelInfo.linkLabel')}
                  </Link>
                </div>
              </Card>
            );

          case 'myQr':
            return (
              <Card key={cardId}>
                <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('myQr.title')}</h2>
                <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('myQr.description')}</p>
                <div className="mt-3">
                  <Link href="/my-qr" className="text-sm font-medium text-turquoise hover:underline">
                    {t('myQr.linkLabel')}
                  </Link>
                </div>
              </Card>
            );

          case 'myProgram':
            return (
              <Card key={cardId}>
                <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('myProgram.title')}</h2>
                {schedulePublication.kind === 'data' && (
                  <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('myProgram.published')}</p>
                )}
                {schedulePublication.kind === 'empty' && (
                  <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('myProgram.notPublished')}</p>
                )}
                {schedulePublication.kind === 'unauthorized' && <UnauthorizedState destination={unauthorizedDestination} />}
                {schedulePublication.kind === 'error' && (
                  <ErrorState title={tStates('error.title')} description={schedulePublication.message} />
                )}
                <div className="mt-3">
                  <Link href="/my-agenda" className="text-sm font-medium text-turquoise hover:underline">
                    {t('myProgram.linkLabel')}
                  </Link>
                </div>
              </Card>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}
