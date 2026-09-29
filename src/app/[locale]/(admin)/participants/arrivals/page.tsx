// src/app/[locale]/(admin)/participants/arrivals/page.tsx
//
// COY21 Phase 4: Arrivals Dashboard for the Logistics team.
// Shows all travel_legs sorted by arrival_datetime so reception can be
// planned. Accessible to travel_operations_staff and super_admin.

import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { notFound } from 'next/navigation';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function ArrivalsPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !isStaffRole(profile.role)) notFound();

  // All travel legs with participant name + attendee code, sorted by arrival time
  const { data: legs } = await service
    .from('travel_legs')
    .select(`
      id,
      leg_type,
      flight_number,
      departure_airport,
      arrival_airport,
      departure_datetime,
      arrival_datetime,
      notes,
      applications (
        application_number,
        full_name,
        imported_email
      )
    `)
    .order('arrival_datetime', { ascending: true, nullsFirst: false });

  const fmt = (dt: string | null) =>
    dt
      ? new Intl.DateTimeFormat('en-US', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Asia/Istanbul',
        }).format(new Date(dt))
      : '—';

  const LEG_LABELS: Record<string, string> = {
    outbound: 'Outbound',
    return: 'Return',
    connecting: 'Connecting',
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6 md:p-10">
      <div>
        <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">Arrivals</h1>
        <p className="mt-1 text-sm text-charcoal/60 dark:text-gray-400">
          Flight legs submitted by participants, sorted by arrival time (Antalya timezone).
        </p>
      </div>

      {(!legs || legs.length === 0) ? (
        <Card className="py-12 text-center text-sm text-charcoal/50 dark:text-gray-400">
          No flight data submitted yet.
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-charcoal/10 dark:border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-charcoal/10 bg-charcoal/5 dark:border-white/10 dark:bg-white/5">
                <th className="px-4 py-3 text-left font-medium text-charcoal/70 dark:text-gray-400">Participant</th>
                <th className="px-4 py-3 text-left font-medium text-charcoal/70 dark:text-gray-400">Code</th>
                <th className="px-4 py-3 text-left font-medium text-charcoal/70 dark:text-gray-400">Type</th>
                <th className="px-4 py-3 text-left font-medium text-charcoal/70 dark:text-gray-400">Flight</th>
                <th className="px-4 py-3 text-left font-medium text-charcoal/70 dark:text-gray-400">Route</th>
                <th className="px-4 py-3 text-left font-medium text-charcoal/70 dark:text-gray-400">Arrival</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-charcoal/5 dark:divide-white/5">
              {legs.map((leg) => {
                const app = Array.isArray(leg.applications) ? leg.applications[0] : leg.applications;
                const name = app?.full_name || app?.imported_email || '—';
                return (
                  <tr key={leg.id} className="hover:bg-charcoal/5 dark:hover:bg-white/5">
                    <td className="px-4 py-3 text-charcoal dark:text-gray-100">{name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-charcoal/60 dark:text-gray-400">
                      {app?.application_number ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-charcoal/70 dark:text-gray-400">
                      {LEG_LABELS[leg.leg_type] ?? leg.leg_type}
                    </td>
                    <td className="px-4 py-3 font-mono text-charcoal dark:text-gray-100">
                      {leg.flight_number ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-charcoal/70 dark:text-gray-400">
                      {leg.departure_airport ?? '?'} → {leg.arrival_airport ?? '?'}
                    </td>
                    <td className="px-4 py-3 text-charcoal dark:text-gray-100">
                      {fmt(leg.arrival_datetime)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
