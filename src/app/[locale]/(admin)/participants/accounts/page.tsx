// src/app/[locale]/(admin)/participants/accounts/page.tsx
//
// Phase C (design doc section 14.6): admin account-management page.
// Gated on isAdmissionStaffRole OR isParticipantsCommunicationsStaffRole —
// registration_admission_manager, participants_communications_manager, and
// super_admin may manage participant accounts. Deliberately narrower than
// the sibling /participants/* pages, which additionally allow
// agenda_allocation_manager.
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import AccountsTable, { type AccountRow } from './accounts-table';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function ParticipantAccountsPage() {
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

  // Only accepted, imported (never self-registered), unclaimed-or-linked-by-
  // this-flow applications are relevant here — applications with an
  // imported_email at all are the population this feature can act on.
  // provisioning rows are left-joined so an application never touched by
  // this feature yet still appears with a 'no_account' implicit state.
  const { data: applications } = await service
    .from('applications')
    .select(
      'id, full_name, imported_email, import_batch_id, import_batches(original_filename), participant_account_provisioning(account_status, email_status, must_change_password, normalized_email, last_login_email_sent_at, login_email_send_count, last_error_message, auth_user_id)'
    )
    .not('imported_email', 'is', null)
    .order('created_at', { ascending: false })
    .limit(500);

  const { data: batches } = await service
    .from('import_batches')
    .select('id, original_filename')
    .order('uploaded_at', { ascending: false });

  const rows: AccountRow[] = (applications ?? []).map((app) => {
    const provisioning = Array.isArray(app.participant_account_provisioning)
      ? app.participant_account_provisioning[0]
      : app.participant_account_provisioning;
    return {
      applicationId: app.id,
      fullName: app.full_name ?? '',
      username: provisioning?.normalized_email ?? app.imported_email ?? '',
      importBatchId: app.import_batch_id,
      importBatchName: app.import_batches?.original_filename ?? null,
      accountStatus: provisioning?.account_status ?? 'no_account',
      emailStatus: provisioning?.email_status ?? 'not_sent',
      mustChangePassword: provisioning?.must_change_password ?? false,
      lastLoginEmailSentAt: provisioning?.last_login_email_sent_at ?? null,
      loginEmailSendCount: provisioning?.login_email_send_count ?? 0,
      lastErrorMessage: provisioning?.last_error_message ?? null,
    };
  });

  const t = await getTranslations({ locale, namespace: 'participants.accounts' });

  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
      <div>
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('subtitle')}</p>
      </div>
      <AccountsTable rows={rows} batches={(batches ?? []).map((b) => ({ id: b.id, name: b.original_filename }))} />
    </div>
  );
}
