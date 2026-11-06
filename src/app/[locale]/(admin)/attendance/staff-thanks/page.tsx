// src/app/[locale]/(admin)/attendance/staff-thanks/page.tsx
//
// One-off admin page: send the thank-you email to the COY21 team. Same inline
// auth + role gate as attendance/walk-in/page.tsx; the actions additionally
// require super_admin.
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import StaffThanksClient from './staff-thanks-client';
import { THANKS_SUBJECT, THANKS_PARAGRAPHS } from './thanks-content';

export default async function StaffThanksPage() {
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
  if (!profile || !isStaffRole(profile.role)) {
    notFound();
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">Thank-you email to the team</h1>
      <StaffThanksClient subject={THANKS_SUBJECT} paragraphs={THANKS_PARAGRAPHS} />
    </div>
  );
}
