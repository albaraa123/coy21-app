// src/app/[locale]/(admin)/participants/import/[batchId]/map/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import MappingTable from './mapping-table';
import { getMappingSuggestions } from './actions';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function MapColumnsPage({ params }: { params: Promise<{ batchId: string }> }) {
  const locale = await getLocale();
  const { batchId } = await params;
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

  const { data: batch } = await service.from('import_batches').select('id, status, original_filename, sheet_name').eq('id', batchId).single();
  if (!batch) notFound();

  const t = await getTranslations({ locale, namespace: 'participants.import.map' });

  let suggestions;
  try {
    suggestions = await getMappingSuggestions(batchId);
  } catch (err) {
    return (
      <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {err instanceof Error ? err.message : t('loadError')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
      <div>
        <Link href={`/participants/import`} className="text-sm font-medium text-turquoise hover:underline">
          {t('backLabel')}
        </Link>
        <h1 className="mt-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
          {t('fileInfo', { filename: batch.original_filename, sheet: batch.sheet_name ?? '' })}
        </p>
      </div>
      <MappingTable batchId={batchId} initialData={suggestions} />
    </div>
  );
}
