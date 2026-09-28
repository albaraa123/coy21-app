// src/app/[locale]/(admin)/dashboard/page.tsx
//
// Task 11: the real admin dashboard — first item in the admin sidebar
// (adminDashboardItem, src/lib/nav/admin-nav-config.ts), previously only a
// gated-but-empty route under (admin)/layout.tsx (Task 6). Calls every
// function from src/lib/dashboard/admin-dashboard-queries.ts (Task 10) and
// renders one card per query, matched to that query's actual CardResult
// state.
//
// AUTHORIZATION LAYERING: (admin)/layout.tsx already gates entry into the
// whole (admin) URL space (redirect-unauthenticated / unauthorized /
// authorized — see decideAdminAccess). This page additionally re-derives
// its own `{ userId, service }` caller and passes it to every query
// function, each of which independently re-verifies staff-ness internally
// (verifyStaffCaller in admin-dashboard-queries.ts) — defense in depth, not
// a redundant check to skip. A `{ kind: 'unauthorized' }` CardResult should
// never actually occur for a caller who legitimately reached this page
// through the layout gate, but if it ever does (e.g. a bug elsewhere, or a
// role changing mid-session), this page renders UnauthorizedState for that
// SPECIFIC card rather than silently hiding it or showing a friendly empty
// state that would imply "there's just nothing here" instead of "we
// couldn't verify you're allowed to see this."
//
// DENSITY: this is the deliberately DENSE admin view — a compact grid of
// small metric/list cards, many numbers, minimal whitespace. Contrast with
// my-dashboard/page.tsx's deliberately sparse, calm participant layout.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { UnauthorizedState } from '@/components/states/unauthorized-state';
import {
  getRecentImportBatches,
  getImportsRequiringAttention,
  getAcceptedParticipantCount,
  getPendingInvitationsSummary,
  getUpcomingPublishedSessions,
  getAllocationRunStatus,
  getSchedulePublicationSummary,
  getSessionBookingsSummary,
  getTravelLegCount,
  type DashboardStaffCaller,
} from '@/lib/dashboard/admin-dashboard-queries';
import type { CardResult } from '@/lib/dashboard/dashboard-types';

// import_batches.status values that represent a card-attention-worthy
// terminal state, for badge styling only (see
// import_batches_status_valid in 20260726102000_import_staging_tables.sql).
const ATTENTION_STATUSES = new Set(['failed', 'completed_with_warnings']);

export default async function AdminDashboardPage() {
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
  const caller: DashboardStaffCaller = { userId: user.id, service };

  const [
    recentImports,
    importsRequiringAttention,
    acceptedCount,
    pendingInvitations,
    upcomingSessions,
    allocationRunStatus,
    schedulePublication,
    sessionBookings,
    travelLegCount,
  ] = await Promise.all([
    getRecentImportBatches(caller),
    getImportsRequiringAttention(caller),
    getAcceptedParticipantCount(caller),
    getPendingInvitationsSummary(caller),
    getUpcomingPublishedSessions(caller),
    getAllocationRunStatus(caller),
    getSchedulePublicationSummary(caller),
    getSessionBookingsSummary(caller),
    getTravelLegCount(caller),
  ]);

  const t = await getTranslations({ locale, namespace: 'adminDashboard' });
  const tStates = await getTranslations({ locale, namespace: 'states' });
  const tShell = await getTranslations({ locale, namespace: 'shell' });
  const unauthorizedDestination = { href: '/my-dashboard', label: tShell('unauthorized.toParticipantDashboard') };

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-4 text-lg font-semibold text-charcoal dark:text-gray-100 md:mb-6">{t('title')}</h1>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:gap-4 lg:grid-cols-3">
        <DashboardCard title={t('acceptedParticipants.title')} href="/participants" linkLabel={t('acceptedParticipants.linkLabel')}>
          <CardBody result={acceptedCount} states={tStates} unauthorizedDestination={unauthorizedDestination}>
            {(value) => (
              <p className="text-2xl font-semibold text-charcoal dark:text-gray-100">{value}</p>
            )}
          </CardBody>
        </DashboardCard>

        <DashboardCard title={t('importsRequiringAttention.title')} href="/participants/imports" linkLabel={t('importsRequiringAttention.linkLabel')}>
          <CardBody result={importsRequiringAttention} states={tStates} unauthorizedDestination={unauthorizedDestination}>
            {(value) => (
              <p className="text-2xl font-semibold text-charcoal dark:text-gray-100">{value}</p>
            )}
          </CardBody>
        </DashboardCard>

        <DashboardCard title={t('pendingInvitations.title')} href="/participants/imports" linkLabel={t('pendingInvitations.linkLabel')}>
          <CardBody result={pendingInvitations} states={tStates} unauthorizedDestination={unauthorizedDestination}>
            {(value) => (
              <dl className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <dt className="text-xs text-charcoal/60 dark:text-gray-400">{t('pendingInvitations.notSent')}</dt>
                  <dd className="text-lg font-semibold text-charcoal dark:text-gray-100">{value.notSent}</dd>
                </div>
                <div>
                  <dt className="text-xs text-charcoal/60 dark:text-gray-400">{t('pendingInvitations.sent')}</dt>
                  <dd className="text-lg font-semibold text-charcoal dark:text-gray-100">{value.sent}</dd>
                </div>
                <div>
                  <dt className="text-xs text-charcoal/60 dark:text-gray-400">{t('pendingInvitations.failed')}</dt>
                  <dd className="text-lg font-semibold text-charcoal dark:text-gray-100">{value.failed}</dd>
                </div>
              </dl>
            )}
          </CardBody>
        </DashboardCard>

        <DashboardCard title={t('allocationRun.title')} href="/allocation/runs" linkLabel={t('allocationRun.linkLabel')}>
          <CardBody result={allocationRunStatus} states={tStates} unauthorizedDestination={unauthorizedDestination} emptyLabel={t('allocationRun.empty')}>
            {(value) => (
              <div className="flex items-center gap-2">
                <Badge variant={value.status === 'failed' ? 'cancelled' : 'elective'}>{value.status}</Badge>
                <span className="text-xs text-charcoal/60 dark:text-gray-400">
                  {new Date(value.runAt).toLocaleString(locale)}
                </span>
              </div>
            )}
          </CardBody>
        </DashboardCard>

        <DashboardCard title={t('schedulePublication.title')} href="/allocation/schedules" linkLabel={t('schedulePublication.linkLabel')}>
          <CardBody result={schedulePublication} states={tStates} unauthorizedDestination={unauthorizedDestination}>
            {(value) => (
              <dl className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <dt className="text-xs text-charcoal/60 dark:text-gray-400">{t('schedulePublication.staged')}</dt>
                  <dd className="text-lg font-semibold text-charcoal dark:text-gray-100">{value.staged}</dd>
                </div>
                <div>
                  <dt className="text-xs text-charcoal/60 dark:text-gray-400">{t('schedulePublication.needsResolution')}</dt>
                  <dd className="text-lg font-semibold text-charcoal dark:text-gray-100">{value.needsResolution}</dd>
                </div>
                <div>
                  <dt className="text-xs text-charcoal/60 dark:text-gray-400">{t('schedulePublication.active')}</dt>
                  <dd className="text-lg font-semibold text-charcoal dark:text-gray-100">{value.active}</dd>
                </div>
              </dl>
            )}
          </CardBody>
        </DashboardCard>

        <DashboardCard title="Session Bookings" href="/agenda/sessions" linkLabel="View sessions">
          <CardBody result={sessionBookings} states={tStates} unauthorizedDestination={unauthorizedDestination}>
            {(value) => (
              <dl className="grid grid-cols-2 gap-2 text-center">
                <div>
                  <dt className="text-xs text-charcoal/60 dark:text-gray-400">Active</dt>
                  <dd className="text-lg font-semibold text-charcoal dark:text-gray-100">{value.active}</dd>
                </div>
                <div>
                  <dt className="text-xs text-charcoal/60 dark:text-gray-400">Cancelled</dt>
                  <dd className="text-lg font-semibold text-charcoal dark:text-gray-100">{value.cancelled}</dd>
                </div>
              </dl>
            )}
          </CardBody>
        </DashboardCard>

        <DashboardCard title="Travel Legs Submitted" href="/participants/arrivals" linkLabel="View arrivals">
          <CardBody result={travelLegCount} states={tStates} unauthorizedDestination={unauthorizedDestination}>
            {(value) => (
              <p className="text-2xl font-semibold text-charcoal dark:text-gray-100">{value}</p>
            )}
          </CardBody>
        </DashboardCard>

        <DashboardCard title={t('upcomingSessions.title')} href="/agenda/sessions" linkLabel={t('upcomingSessions.linkLabel')}>
          <CardBody result={upcomingSessions} states={tStates} unauthorizedDestination={unauthorizedDestination} emptyLabel={t('upcomingSessions.empty')}>
            {(value) =>
              value.length === 0 ? (
                <p className="text-sm text-charcoal/60 dark:text-gray-400">{t('upcomingSessions.empty')}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {value.slice(0, 5).map((session) => {
                    const title = (locale === 'ar' ? session.titleAr : session.titleEn) ?? session.titleAr ?? session.titleEn;
                    const room = (locale === 'ar' ? session.roomNameAr : session.roomNameEn) ?? session.roomNameAr ?? session.roomNameEn;
                    return (
                      <li key={session.scheduleItemId} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate text-charcoal dark:text-gray-100">{title ?? t('upcomingSessions.untitled')}</span>
                        <span className="shrink-0 text-xs text-charcoal/60 dark:text-gray-400">
                          {session.startTime ? new Date(session.startTime).toLocaleString(locale) : ''}
                          {room ? ` · ${room}` : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )
            }
          </CardBody>
        </DashboardCard>

        <DashboardCard title={t('recentImports.title')} href="/participants/imports" linkLabel={t('recentImports.linkLabel')} className="sm:col-span-2 lg:col-span-3">
          <CardBody result={recentImports} states={tStates} unauthorizedDestination={unauthorizedDestination} emptyLabel={t('recentImports.empty')}>
            {(value) =>
              value.length === 0 ? (
                <p className="text-sm text-charcoal/60 dark:text-gray-400">{t('recentImports.empty')}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {value.map((batch) => (
                    <li key={batch.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-charcoal dark:text-gray-100">{batch.filename}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge variant={ATTENTION_STATUSES.has(batch.status) ? 'cancelled' : 'elective'}>{batch.status}</Badge>
                        <span className="text-xs text-charcoal/60 dark:text-gray-400">
                          {new Date(batch.uploadedAt).toLocaleDateString(locale)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          </CardBody>
        </DashboardCard>
      </div>
    </div>
  );
}

function DashboardCard({
  title,
  href,
  linkLabel,
  className = '',
  children,
}: {
  title: string;
  href: string;
  linkLabel: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">{title}</h2>
      </div>
      <div className="mb-3">{children}</div>
      <Link href={href} className="text-xs font-medium text-turquoise hover:underline">
        {linkLabel}
      </Link>
    </Card>
  );
}

/**
 * Renders the correct UI for a CardResult's actual state. `unauthorized`
 * and `error` are NEVER collapsed into a friendly-looking empty state —
 * each renders its own distinct, honest component (UnauthorizedState /
 * ErrorState), per this task's own authorization/privacy requirement.
 */
function CardBody<T>({
  result,
  states,
  unauthorizedDestination,
  emptyLabel,
  children,
}: {
  result: CardResult<T>;
  states: Awaited<ReturnType<typeof getTranslations>>;
  unauthorizedDestination: { href: string; label: string };
  emptyLabel?: string;
  children: (value: T) => React.ReactNode;
}) {
  if (result.kind === 'data') {
    return <>{children(result.value)}</>;
  }
  if (result.kind === 'empty') {
    return <EmptyState title={emptyLabel ?? states('empty.genericTitle')} />;
  }
  if (result.kind === 'unauthorized') {
    return <UnauthorizedState destination={unauthorizedDestination} />;
  }
  return <ErrorState title={states('error.title')} description={result.message} />;
}
