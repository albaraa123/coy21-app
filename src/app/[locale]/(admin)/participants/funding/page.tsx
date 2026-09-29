// src/app/[locale]/(admin)/participants/funding/page.tsx
//
// "Participant Status" — funding_type and attendance_confirmation.
//
// HISTORY: before the 2026-09-29 staff role consolidation (see
// docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md),
// funding_type had full access for program_attendance_manager /
// travel_operations_staff / super_admin only, while
// attendance_confirmation additionally gave participant_care_staff
// READ-ONLY access. That consolidation merged all of those roles into a
// single 'staff' role, so canReadAttendanceConfirmation and
// isFundingTypeStaffRole (src/lib/validation/funding-type.ts) now both
// resolve to the same check — hasFullAccess below is effectively always
// true for any caller who passes the page-level gate. The two checks are
// kept as separate calls for readability (matching the console
// component's existing prop shape), not because they still enforce
// different access levels.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { canReadAttendanceConfirmation, isFundingTypeStaffRole } from '@/lib/validation/funding-type';
import { notFound } from 'next/navigation';
import FundingConsole from './funding-console';

export default async function FundingPage() {
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
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !canReadAttendanceConfirmation(profile.role)) {
    notFound();
  }

  const hasFullAccess = isFundingTypeStaffRole(profile.role);

  const t = await getTranslations({ locale, namespace: 'funding' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      <p className="mb-4 text-sm text-charcoal/70 dark:text-gray-400 md:mb-6">{t('description')}</p>
      <FundingConsole hasFullAccess={hasFullAccess} />
    </div>
  );
}
