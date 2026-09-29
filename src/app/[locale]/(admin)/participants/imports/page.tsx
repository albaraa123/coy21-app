// src/app/[locale]/(admin)/participants/imports/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import ImportList from './import-list';
import { isStaffRole } from '@/lib/auth/is-staff-role';

// History/list page for import_batches — the plural "imports" route, distinct
// from the singular "import" wizard flow (Tasks 12-15). Same bare
// auth-gate pattern as every other admin page in this feature: redirect an
// unauthenticated visitor to log-in, 404 (not a permission error page) for an
// authenticated non-staff profile, matching Task 12's page.tsx precedent.
export default async function ImportHistoryPage() {
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

  const { data: batches } = await service
    .from('import_batches')
    .select(
      'id, status, downstream_status, original_filename, sheet_name, row_count, valid_count, warning_count, error_count, duplicate_count, inserted_count, updated_count, skipped_count, uploaded_at, confirmed_at, completed_at'
    )
    .order('uploaded_at', { ascending: false });

  const t = await getTranslations({ locale, namespace: 'imports.history' });

  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
      <div>
        <div className="flex flex-wrap gap-3">
          <Link href="/participants" className="text-sm font-medium text-turquoise hover:underline">
            {t('backLabel')}
          </Link>
          <Link href="/participants/import" className="text-sm font-medium text-turquoise hover:underline">
            {t('startNewLabel')}
          </Link>
        </div>
        <h1 className="mt-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      </div>
      <ImportList batches={batches ?? []} />
    </div>
  );
}
