// src/app/[locale]/(admin)/participants/imports/[batchId]/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import BatchDetail from './batch-detail';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function ImportBatchDetailPage({ params }: { params: Promise<{ batchId: string }> }) {
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

  const { data: batch } = await service
    .from('import_batches')
    .select(
      'id, status, downstream_status, original_filename, sheet_name, storage_path, row_count, valid_count, warning_count, error_count, duplicate_count, inserted_count, updated_count, skipped_count, next_chunk_offset, auto_process_downstream, auto_process_cluster_k, failure_reason, uploaded_at, confirmed_at, completed_at, uploaded_by'
    )
    .eq('id', batchId)
    .single();
  if (!batch) notFound();

  // Two independent audit_logs query shapes, both described explicitly in
  // the plan: batch-level rows (entity_type = 'import_batch', entity_id =
  // batchId — e.g. 'validate', 'complete_import', 'rollback_import_requested',
  // 'downstream_processing_completed'), and per-row apply rows written by the
  // apply_import_row_transactional RPC (entity_type = 'application', keyed by
  // the destination application id, with metadata->>'batchId' tying each row
  // back to this batch since entity_id there is the APPLICATION id, not the
  // batch id). Fetched here (not inside the client component) since this is
  // a one-time read with no interactivity — same rationale as ImportList.
  const [{ data: batchAuditLogs }, { data: applicationAuditLogs }] = await Promise.all([
    service
      .from('audit_logs')
      .select('id, action, actor_id, metadata, created_at')
      .eq('entity_type', 'import_batch')
      .eq('entity_id', batchId)
      .order('created_at', { ascending: false }),
    service
      .from('audit_logs')
      .select('id, action, actor_id, entity_id, metadata, created_at')
      .eq('entity_type', 'application')
      .eq('metadata->>batchId', batchId)
      .order('created_at', { ascending: false }),
  ]);

  const t = await getTranslations({ locale, namespace: 'imports.detail' });

  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
      <div>
        {/* Relative to this page's own URL
            (/{locale}/participants/imports/{batchId}, no trailing slash), ".."
            resolves to /{locale}/participants/imports — the import-history
            list. Kept as a plain relative link (matching import-list.tsx's
            own documented relative-href convention on this same feature)
            rather than an absolute Link href, so it stays correct without
            re-deriving the locale prefix. */}
        <a href=".." className="text-sm font-medium text-turquoise hover:underline">
          {t('backLabel')}
        </a>
        <h1 className="mt-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      </div>
      <BatchDetail batch={batch} batchAuditLogs={batchAuditLogs ?? []} applicationAuditLogs={applicationAuditLogs ?? []} />
    </div>
  );
}
