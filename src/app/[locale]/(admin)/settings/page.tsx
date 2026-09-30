// src/app/[locale]/(admin)/settings/page.tsx
//
// Query/auth pattern mirrors agenda/tracks/page.tsx and staff/page.tsx:
// createClient() for the session, createServiceRoleClient() for the
// profiles.role read keyed on the session user's id. Uses isStaffRole
// (not a super_admin-only check) so a plain `staff` account can still
// open this page and see a read-only view of the current sandbox
// configuration — only the editable controls inside SettingsForm are
// gated to super_admin. This matches this codebase's "RLS/Server Actions
// are the real boundary, the UI just reflects it" convention (see
// require-super-admin.ts and settings/actions.ts, which independently
// re-enforce super_admin on every mutating call regardless of what this
// page renders).
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import SettingsForm from './settings-form';

export default async function SettingsPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !isStaffRole(profile.role)) {
    notFound();
  }

  const { data: emailSettings } = await service
    .from('email_settings')
    .select('sandbox_enabled, sandbox_recipient_email')
    .eq('id', true)
    .single();

  const t = await getTranslations({ locale, namespace: 'settings' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-1 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      <p className="mb-6 text-sm text-charcoal/60 dark:text-gray-400">{t('description')}</p>
      <SettingsForm
        sandboxEnabled={emailSettings?.sandbox_enabled ?? true}
        sandboxRecipientEmail={emailSettings?.sandbox_recipient_email ?? null}
        isSuperAdmin={profile.role === 'super_admin'}
      />
    </div>
  );
}
