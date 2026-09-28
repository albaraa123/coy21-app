// src/app/[locale]/(admin)/participants/funding/page.tsx
//
// "Participant Status" — funding_type (full access: program_attendance_
// manager / travel_operations_staff / super_admin) and
// attendance_confirmation (full access to read+write; participant_care_staff
// gets read-only). Page-level gate uses canReadAttendanceConfirmation (the
// broader of the two checks) so care staff can open the page at all; the
// console component itself hides funding_type and every write control for
// a caller who only satisfies the read-only check, resolved via
// isFundingTypeStaffRole passed down as a prop.
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
