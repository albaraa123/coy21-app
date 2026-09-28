// src/app/[locale]/(admin)/participants/import/[batchId]/preview/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isParticipantsCommunicationsStaffRole } from '@/lib/validation/participants-communications';
import PreviewTable from './preview-table';

export default async function PreviewImportPage({ params }: { params: Promise<{ batchId: string }> }) {
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
  if (!profile || !(isAgendaStaffRole(profile.role) || isParticipantsCommunicationsStaffRole(profile.role))) {
    notFound();
  }

  const { data: batch } = await service
    .from('import_batches')
    .select('id, status, original_filename, sheet_name, valid_count, warning_count, error_count, duplicate_count, row_count')
    .eq('id', batchId)
    .single();
  if (!batch) notFound();

  const t = await getTranslations({ locale, namespace: 'participants.import.preview' });

  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
      <div>
        <Link href="/participants/import" className="text-sm font-medium text-turquoise hover:underline">
          {t('backLabel')}
        </Link>
        <h1 className="mt-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
          {t('fileInfo', { filename: batch.original_filename, sheet: batch.sheet_name ?? '' })}
        </p>
      </div>
      <PreviewTable batchId={batchId} initialBatch={batch} />
    </div>
  );
}
