// src/app/[locale]/(admin)/participants/import/[batchId]/confirm/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isParticipantsCommunicationsStaffRole } from '@/lib/validation/participants-communications';
import ImportProgress from './import-progress';

export default async function ConfirmImportPage({ params }: { params: Promise<{ batchId: string }> }) {
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
    .select(
      'id, status, original_filename, sheet_name, row_count, valid_count, warning_count, error_count, duplicate_count, next_chunk_offset, inserted_count, updated_count, skipped_count, auto_process_downstream, auto_process_cluster_k, downstream_status'
    )
    .eq('id', batchId)
    .single();
  if (!batch) notFound();

  const t = await getTranslations({ locale, namespace: 'participants.import.confirm' });

  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
      <div>
        <Link href={`/participants/import/${batchId}/preview`} className="text-sm font-medium text-turquoise hover:underline">
          {t('backLabel')}
        </Link>
        <h1 className="mt-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
          {t('fileInfo', { filename: batch.original_filename, sheet: batch.sheet_name ?? '' })}
        </p>
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
          {t('summary', {
            rowCount: batch.row_count ?? 0,
            valid: batch.valid_count,
            warning: batch.warning_count,
            error: batch.error_count,
            duplicate: batch.duplicate_count,
          })}
        </p>
      </div>
      {/* The import writes are triggered only by the explicit confirm action
          inside this client component — never automatically on page load.
          A batch already in 'importing' (a mid-import page reload) resumes
          rather than starting a second import. */}
      <ImportProgress batchId={batchId} initialBatch={batch} />
    </div>
  );
}
