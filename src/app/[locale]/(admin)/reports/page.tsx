// src/app/[locale]/(admin)/reports/page.tsx
//
// COY21 Phase 6 — Reporting page.
// Aggregates key operational metrics for super_admin and
// participants_communications_manager. No sensitive PII columns exposed.
// All numbers derived server-side via service role; no client-side data fetch.

import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { CsvExportButton } from './csv-export-button';
import { isParticipantsCommunicationsStaffRole } from '@/lib/validation/participants-communications';

// ---------------------------------------------------------------------------
// Query helpers — all run as service role so RLS doesn't filter results.
// ---------------------------------------------------------------------------

type ParticipantTypeRow = { participant_type: string | null; count: number };
type ConfirmationRow = { status: string; count: number };

async function getReportData(service: ReturnType<typeof createServiceRoleClient>) {
  const [
    byTypeResult,
    byStatusResult,
    totalBookingsResult,
    activeBookingsResult,
    travelLegsResult,
    distinctTravellersResult,
  ] = await Promise.all([
    service
      .from('applications')
      .select('participant_type, count:id.count()')
      .eq('status', 'accepted')
      .returns<ParticipantTypeRow[]>(),

    service
      .from('applications')
      .select('status, count:id.count()')
      .returns<ConfirmationRow[]>(),

    service.from('session_bookings').select('*', { count: 'exact', head: true }),

    service.from('session_bookings').select('*', { count: 'exact', head: true }).eq('status', 'active'),

    service.from('travel_legs').select('*', { count: 'exact', head: true }),

    service.rpc('count_distinct_travellers'),
  ]);

  return {
    byType: (byTypeResult.data ?? []) as ParticipantTypeRow[],
    byStatus: (byStatusResult.data ?? []) as ConfirmationRow[],
    totalBookings: totalBookingsResult.count ?? 0,
    activeBookings: activeBookingsResult.count ?? 0,
    travelLegs: travelLegsResult.count ?? 0,
    distinctTravellers: (distinctTravellersResult.data ?? 0) as number,
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ReportsPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  // Role gate — use service role client so RLS doesn't block if profiles
  // table policy is tightened in future (consistent with all other admin pages)
  const service = createServiceRoleClient();
  const { data: profile } = await service
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!isParticipantsCommunicationsStaffRole(profile?.role)) {
    redirect({ href: '/dashboard', locale });
    return;
  }

  const report = await getReportData(service);

  const totalAccepted = report.byType.reduce((sum, r) => sum + Number(r.count), 0);
  const totalApplications = report.byStatus.reduce((sum, r) => sum + Number(r.count), 0);
  const acceptedCount = report.byStatus.find((r) => r.status === 'accepted');
  const confirmedCount = report.byStatus.find((r) => r.status === 'confirmed');

  const bookingRate =
    totalAccepted > 0
      ? Math.round((report.activeBookings / totalAccepted) * 100)
      : 0;

  const travelRate =
    totalAccepted > 0
      ? Math.round((report.distinctTravellers / totalAccepted) * 100)
      : 0;

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">Reports</h1>
          <p className="mt-0.5 text-sm text-charcoal/60 dark:text-gray-400">
            COY21 operational snapshot — updated in real time.
          </p>
        </div>
        <CsvExportButton />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section 1: Applications & Confirmation                              */}
      {/* ------------------------------------------------------------------ */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-charcoal/50 dark:text-gray-500">
          Applications &amp; Confirmation
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard label="Total Applications" value={totalApplications} />
          <MetricCard label="Accepted" value={Number(acceptedCount?.count ?? 0)} />
          <MetricCard label="Confirmed" value={Number(confirmedCount?.count ?? 0)} />
          <MetricCard
            label="Confirmation Rate"
            value={`${totalAccepted > 0 ? Math.round((Number(confirmedCount?.count ?? 0) / totalAccepted) * 100) : 0}%`}
          />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Section 2: Participants by Type                                     */}
      {/* ------------------------------------------------------------------ */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-charcoal/50 dark:text-gray-500">
          Accepted Participants by Type
        </h2>
        <Card className="py-3">
          {report.byType.length === 0 ? (
            <p className="text-sm text-charcoal/50 dark:text-gray-500">No accepted participants yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-charcoal/10 dark:border-white/10">
                  <th className="pb-2 text-left font-medium text-charcoal/60 dark:text-gray-400">Type</th>
                  <th className="pb-2 text-right font-medium text-charcoal/60 dark:text-gray-400">Count</th>
                  <th className="pb-2 text-right font-medium text-charcoal/60 dark:text-gray-400">Share</th>
                </tr>
              </thead>
              <tbody>
                {report.byType
                  .sort((a, b) => Number(b.count) - Number(a.count))
                  .map((row) => {
                    const pct = totalAccepted > 0 ? Math.round((Number(row.count) / totalAccepted) * 100) : 0;
                    return (
                      <tr key={row.participant_type ?? 'unknown'} className="border-b border-charcoal/5 dark:border-white/5 last:border-0">
                        <td className="py-2 font-mono text-xs uppercase text-charcoal dark:text-gray-200">
                          {row.participant_type ?? 'unset'}
                        </td>
                        <td className="py-2 text-right tabular-nums text-charcoal dark:text-gray-100">
                          {Number(row.count).toLocaleString()}
                        </td>
                        <td className="py-2 text-right tabular-nums text-charcoal/60 dark:text-gray-400">
                          {pct}%
                        </td>
                      </tr>
                    );
                  })}
                <tr className="bg-charcoal/5 dark:bg-white/5">
                  <td className="py-2 font-semibold text-charcoal dark:text-gray-100">Total</td>
                  <td className="py-2 text-right font-semibold tabular-nums text-charcoal dark:text-gray-100">
                    {totalAccepted.toLocaleString()}
                  </td>
                  <td className="py-2 text-right text-charcoal/60 dark:text-gray-400">100%</td>
                </tr>
              </tbody>
            </table>
          )}
        </Card>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Section 3: Session Bookings                                         */}
      {/* ------------------------------------------------------------------ */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-charcoal/50 dark:text-gray-500">
          Session Bookings
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MetricCard label="Active Bookings" value={report.activeBookings} />
          <MetricCard label="Total (incl. cancelled)" value={report.totalBookings} />
          <MetricCard label="Booking Rate" value={`${bookingRate}%`} note="of accepted participants" />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Section 4: Travel Submissions                                       */}
      {/* ------------------------------------------------------------------ */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-charcoal/50 dark:text-gray-500">
          Travel Submissions
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MetricCard label="Travel Legs Submitted" value={report.travelLegs} />
          <MetricCard label="Participants w/ Travel" value={report.distinctTravellers} />
          <MetricCard label="Travel Submission Rate" value={`${travelRate}%`} note="of accepted participants" />
        </div>
      </section>

      <p className="text-xs text-charcoal/30 dark:text-gray-600">
        Data is live from the COY21 Supabase database. Refresh the page to update.
      </p>
    </div>
  );
}

function MetricCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note?: string;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <p className="text-xs text-charcoal/60 dark:text-gray-400">{label}</p>
      <p className="text-2xl font-semibold tabular-nums text-charcoal dark:text-gray-100">{value}</p>
      {note && <p className="text-xs text-charcoal/40 dark:text-gray-500">{note}</p>}
    </Card>
  );
}
