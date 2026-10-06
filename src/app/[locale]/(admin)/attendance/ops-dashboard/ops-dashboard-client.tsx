'use client';

// src/app/[locale]/(admin)/attendance/ops-dashboard/ops-dashboard-client.tsx
//
// Sub-project 5a — see
// docs/superpowers/specs/2026-10-05-ops-dashboard-design.md for the full
// design and docs/superpowers/plans/2026-10-05-ops-dashboard.md ("Task
// 2") for this task's scope.
//
// Task 2 (this file, as first written): render the initial snapshot
// passed from the server component as a static view. Deliberately NO
// Realtime subscription and NO polling here yet -- that's Task 3's job,
// added as a later, separately reviewable change to this same file.
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import type { Database } from '@/types/database';

// row.rejection_breakdown is carried through from the RPC but intentionally
// unused here -- this view only needs the aggregate rejection_count_30m.
// It's reserved for a future per-reason breakdown (e.g. a tooltip listing
// invalid_qr/duplicate/etc. counts), not a gap in this task.
export type OpsDashboardRow = Database['public']['Functions']['ops_dashboard_snapshot']['Returns'][number];

// "Elevated" rejection rate threshold for the alerts summary. Simple,
// visible, not configurable per the plan's Task 2 instructions.
const ELEVATED_REJECTION_THRESHOLD = 5;

function formatScanTime(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-US', { timeZone: 'Europe/Istanbul' });
}

function occupancyBarColor(occupancyPct: number): string {
  if (occupancyPct >= 100) return 'bg-red-600 dark:bg-red-500';
  if (occupancyPct >= 90) return 'bg-amber-500 dark:bg-amber-400';
  return 'bg-emerald-600 dark:bg-emerald-500';
}

function OccupancyBar({ occupancyPct }: { occupancyPct: number }) {
  const clampedWidth = Math.min(Math.max(occupancyPct, 0), 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(occupancyPct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2 w-full overflow-hidden rounded-full bg-charcoal/10 dark:bg-gray-800"
    >
      <div
        className={`h-full rounded-full ${occupancyBarColor(occupancyPct)}`}
        style={{ width: `${clampedWidth}%` }}
      />
    </div>
  );
}

export default function OpsDashboardClient({ initialRows }: { initialRows: OpsDashboardRow[] }) {
  // Task 2: static render only. Task 3 replaces this plain destructure
  // with Realtime-subscription + polling-driven state (see that task's
  // required request-id guard against out-of-order responses).
  const rows = initialRows;

  const t = useTranslations('opsDashboard');
  const locale = useLocale();

  const alertRows = rows.filter(
    (row) =>
      row.is_full ||
      row.is_near_full ||
      row.stale_scanner_count > 0 ||
      row.rejection_count_30m >= ELEVATED_REJECTION_THRESHOLD
  );

  const getTitle = (row: OpsDashboardRow) => (locale === 'ar' ? row.title_ar : row.title_en);
  const getRoomName = (row: OpsDashboardRow) => (locale === 'ar' ? row.room_name_ar : row.room_name_en);

  const describeAlertReasons = (row: OpsDashboardRow): string[] => {
    const reasons: string[] = [];
    if (row.is_full) reasons.push(t('alerts.reasonFull'));
    else if (row.is_near_full) reasons.push(t('alerts.reasonNearFull'));
    if (row.stale_scanner_count > 0) {
      reasons.push(t('alerts.reasonStaleScanners', { count: row.stale_scanner_count }));
    }
    if (row.rejection_count_30m >= ELEVATED_REJECTION_THRESHOLD) {
      reasons.push(t('alerts.reasonElevatedRejections', { count: row.rejection_count_30m }));
    }
    return reasons;
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Alerts summary: every session needing attention right now --
          full/near-full, stale scanners, or an elevated rejection rate
          over the trailing 30-minute window. */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('alerts.title')}</h2>
        {alertRows.length === 0 ? (
          <p className="rounded-lg border border-charcoal/10 bg-warm-white p-3 text-sm text-charcoal/70 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
            {t('alerts.none')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {alertRows.map((row) => (
              <li
                key={row.session_id}
                className="flex flex-col gap-1 rounded-lg border border-gold/40 bg-gold/10 p-3 text-sm dark:border-amber-700/50 dark:bg-amber-900/20"
              >
                <span className="font-medium text-charcoal dark:text-gray-100">{getTitle(row)}</span>
                <span className="text-charcoal/70 dark:text-gray-400">{describeAlertReasons(row).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Per-session grid. Mobile: card-per-session list. Desktop (md+):
          table. Both trees render the same `rows` data and must be kept
          in sync -- any field added to one must be added to the other,
          mirroring demand/page.tsx's dual-layout convention. */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('sessions.title')}</h2>
        {rows.length === 0 ? (
          <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
        ) : (
          <>
            <div className="flex flex-col gap-2 md:hidden">
              {rows.map((row) => {
                const lastScan = formatScanTime(row.last_scan_at);
                return (
                  <div
                    key={row.session_id}
                    className="rounded-lg border border-charcoal/10 bg-warm-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900"
                  >
                    <p className="text-sm font-medium text-charcoal dark:text-gray-100">{getTitle(row)}</p>
                    <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{getRoomName(row)}</p>
                    <div className="mt-2">
                      <OccupancyBar occupancyPct={row.occupancy_pct} />
                      <p className="mt-1 text-xs text-charcoal/70 dark:text-gray-400">
                        {t('sessions.occupancy', {
                          occupied: row.occupied_count,
                          capacity: row.capacity,
                          pct: row.occupancy_pct,
                        })}
                      </p>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {row.is_full && <Badge variant="mandatory">{t('sessions.full')}</Badge>}
                      {!row.is_full && row.is_near_full && <Badge variant="pending">{t('sessions.nearFull')}</Badge>}
                      {row.stale_scanner_count > 0 && (
                        <Badge variant="neutral">{t('sessions.staleScanners', { count: row.stale_scanner_count })}</Badge>
                      )}
                      <span className="text-xs text-charcoal/60 dark:text-gray-400">
                        {t('sessions.rejections', { count: row.rejection_count_30m })}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-charcoal/50 dark:text-gray-500">
                      {t('sessions.scannerCount', { count: row.scanner_count })}
                      {lastScan ? ` · ${t('sessions.lastScanAt', { time: lastScan })}` : ''}
                    </p>
                  </div>
                );
              })}
            </div>
            <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('sessions.session')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('sessions.room')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('sessions.occupancyColumn')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('sessions.status')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('sessions.scanners')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('sessions.rejectionsColumn')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                  {rows.map((row) => {
                    const lastScan = formatScanTime(row.last_scan_at);
                    return (
                      <tr key={row.session_id}>
                        <td className="px-4 py-2 text-charcoal dark:text-gray-100">{getTitle(row)}</td>
                        <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{getRoomName(row)}</td>
                        <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                          <div className="min-w-[140px]">
                            <OccupancyBar occupancyPct={row.occupancy_pct} />
                            <p className="mt-1 text-xs">
                              {t('sessions.occupancy', {
                                occupied: row.occupied_count,
                                capacity: row.capacity,
                                pct: row.occupancy_pct,
                              })}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex flex-wrap items-center gap-1">
                            {row.is_full && <Badge variant="mandatory">{t('sessions.full')}</Badge>}
                            {!row.is_full && row.is_near_full && <Badge variant="pending">{t('sessions.nearFull')}</Badge>}
                            {row.stale_scanner_count > 0 && (
                              <Badge variant="neutral">{t('sessions.staleScanners', { count: row.stale_scanner_count })}</Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                          <span>{t('sessions.scannerCount', { count: row.scanner_count })}</span>
                          {lastScan && (
                            <p className="text-xs text-charcoal/50 dark:text-gray-500">
                              {t('sessions.lastScanAt', { time: lastScan })}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                          {t('sessions.rejections', { count: row.rejection_count_30m })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
