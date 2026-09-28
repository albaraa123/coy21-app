// src/app/[locale]/(admin)/participants/import/[batchId]/rollback/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isParticipantsCommunicationsStaffRole } from '@/lib/validation/participants-communications';
import RollbackTrigger from './rollback-trigger';

// Minimal standalone rollback trigger, per Task 16 Step 3's explicit
// fallback: "if Task 18 isn't done yet, add a minimal standalone rollback
// trigger here and wire it into Task 18's UI when that task runs." Task 18
// (the batch history/detail page) will link to this route and can absorb
// this UI into its own layout later — this page is deliberately bare,
// matching the rest of this feature's admin pages.
export default async function RollbackImportPage({ params }: { params: Promise<{ batchId: string }> }) {
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
    .select('id, status, original_filename, sheet_name, row_count, inserted_count, updated_count')
    .eq('id', batchId)
    .single();
  if (!batch) notFound();

  const t = await getTranslations({ locale, namespace: 'participants.import.rollback' });

  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
      <div>
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
          {t('fileInfo', { filename: batch.original_filename, sheet: batch.sheet_name ?? '' })}
        </p>
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
          {t('statusLine', { status: batch.status, inserted: batch.inserted_count, updated: batch.updated_count })}
        </p>
      </div>
      {batch.status === 'rolled_back' ? (
        <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('alreadyRolledBack')}</p>
      ) : (
        <RollbackTrigger batchId={batchId} />
      )}
    </div>
  );
}
