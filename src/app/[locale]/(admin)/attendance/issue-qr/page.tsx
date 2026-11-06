// src/app/[locale]/(admin)/attendance/issue-qr/page.tsx
//
// Admin page: pre-issue the conference QR for every accepted participant
// who does not have one yet. Same inline auth + role gate shape as
// attendance/walk-in/page.tsx; the issuing action itself additionally
// requires super_admin.
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import IssueQrClient from './issue-qr-client';

export default async function IssueQrPage() {
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

  const { data: apps } = await service.from('applications').select('id').eq('status', 'accepted');
  const { data: active } = await service.from('qr_credentials').select('application_id').eq('status', 'active');
  const have = new Set((active ?? []).map((q) => q.application_id));
  const missing = (apps ?? []).filter((a) => !have.has(a.id)).length;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">Pre-issue conference QR codes</h1>
      <p className="text-sm text-charcoal/70 dark:text-gray-300">
        Creates the registration / attendance QR for every accepted participant who does not have one yet, so they find it ready in My QR. It does not
        change anyone who already has a QR.
      </p>
      <IssueQrClient initialMissing={missing} />
    </div>
  );
}
