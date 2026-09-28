// src/app/[locale]/(admin)/participants/import/[batchId]/map/actions.ts
'use server';

import { requireImportStaffCaller } from '@/lib/import/server-helpers';
import { writeAuditLog } from '@/lib/agenda/server-helpers';
import { confirmMappingSchema, MAPPING_CONFIDENCE_THRESHOLD } from '@/lib/validation/import';
import { extractHeaderRow } from '@/lib/import/workbook-parser';
import { suggestMapping, computeHeaderSignature } from '@/lib/import/mapping-suggestion';
import { isKnownTravelFieldKey, isKnownHealthFieldKey } from '@/lib/import/known-application-columns';
import type { createServiceRoleClient } from '@/lib/supabase/server';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

// Shared by getMappingSuggestions and confirmMapping so the latter can
// re-derive headers server-side (never trust client-supplied header text for
// what gets persisted) without re-authenticating a second time via
// requireImportStaffCaller() inside the same request. Calling one 'use
// server' action from another works fine in Next.js (the 'use server'
// boundary only matters for client->server calls), but doing so here would
// mean re-running the full auth/role lookup and re-downloading/re-parsing
// the workbook twice per confirmMapping call for no benefit — extracting the
// header-fetch logic avoids that duplication.
async function fetchHeadersAndSuggestions(service: ServiceClient, batchId: string) {
  const { data: batch, error } = await service.from('import_batches').select('storage_path, sheet_name').eq('id', batchId).single();
  if (error || !batch || !batch.sheet_name) throw new Error('Batch or sheet not found');

  const { data: fileData, error: downloadError } = await service.storage.from('import-uploads').download(batch.storage_path);
  if (downloadError || !fileData) throw new Error(`Failed to load stored file: ${downloadError?.message}`);
  const buffer = Buffer.from(await fileData.arrayBuffer());

  const headers = await extractHeaderRow(buffer, batch.sheet_name);
  const signature = computeHeaderSignature(headers);

  const { data: matchingTemplate } = await service
    .from('import_mapping_templates')
    .select('id, name, mappings')
    .eq('header_signature', signature)
    .order('last_used_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const suggestions = headers.map((header, index) => {
    const suggestion = suggestMapping(header);
    const suggestedKind: 'core_field' | 'known_answer' | 'travel_field' | 'health_field' | 'generic_answer' =
      suggestion?.kind ?? 'generic_answer';
    return {
      sourceColumnIndex: index,
      sourceColumnHeader: header,
      suggestedKind,
      suggestedKey: suggestion?.key ?? null,
      confidence: suggestion?.confidence ?? 0,
      requiresReview: !suggestion || suggestion.confidence < MAPPING_CONFIDENCE_THRESHOLD || suggestion.isCriticalIdentity,
    };
  });

  return { headers, headerSignature: signature, suggestions, matchingTemplate: matchingTemplate ?? null };
}

export async function getMappingSuggestions(batchId: string) {
  const { service } = await requireImportStaffCaller();
  return fetchHeadersAndSuggestions(service, batchId);
}

export async function confirmMapping(input: unknown) {
  const { userId, service } = await requireImportStaffCaller();
  const parsed = confirmMappingSchema.parse(input);

  const { data: batch, error: batchError } = await service.from('import_batches').select('status').eq('id', parsed.batchId).single();
  if (batchError || !batch) throw new Error('Batch not found');
  if (batch.status !== 'analyzing' && batch.status !== 'awaiting_mapping') {
    throw new Error(`Batch is in status "${batch.status}" and cannot be mapped`);
  }

  // Re-derive headers and suggestion confidence server-side rather than
  // trusting client-supplied values for what gets persisted into
  // import_column_mappings — the client only ever sends targetKind/targetKey/
  // isManualOverride (see columnMappingInputSchema), never header text or
  // confidence.
  const { headers, suggestions } = await fetchHeadersAndSuggestions(service, parsed.batchId);
  const confidenceByColumn = new Map(suggestions.map((s) => [s.sourceColumnIndex, s.confidence]));

  // Phase B (design doc section 13.9): a column mapped to the sensitive
  // travel_field/health_field kinds must target a known column on
  // application_travel_info/application_health_info — rejected here, before
  // ever reaching apply_import_row_transactional, rather than silently
  // falling through to a runtime SQL error (or worse, a column that happens
  // to coincidentally exist but was never intended to receive sensitive
  // import data).
  for (const m of parsed.mappings) {
    if (m.targetKind === 'travel_field' && (!m.targetKey || !isKnownTravelFieldKey(m.targetKey))) {
      throw new Error(`Column ${m.sourceColumnIndex} is mapped as a travel field but "${m.targetKey}" is not a known travel field`);
    }
    if (m.targetKind === 'health_field' && (!m.targetKey || !isKnownHealthFieldKey(m.targetKey))) {
      throw new Error(`Column ${m.sourceColumnIndex} is mapped as a health field but "${m.targetKey}" is not a known health field`);
    }
  }

  const rows = parsed.mappings.map((m) => ({
    import_batch_id: parsed.batchId,
    source_column_index: m.sourceColumnIndex,
    source_column_header: headers[m.sourceColumnIndex] ?? '',
    target_kind: m.targetKind,
    target_key: m.targetKey,
    is_manual_override: m.isManualOverride,
    confidence: confidenceByColumn.get(m.sourceColumnIndex) ?? null,
  }));

  const { error: insertError } = await service.from('import_column_mappings').insert(rows);
  if (insertError) throw new Error(`Failed to save mappings: ${insertError.message}`);

  if (parsed.saveAsTemplateName) {
    const signature = computeHeaderSignature(headers);
    await service.from('import_mapping_templates').insert({
      name: parsed.saveAsTemplateName,
      header_signature: signature,
      original_headers: headers,
      mappings: parsed.mappings,
      created_by: userId,
    });
  }

  await service
    .from('import_batches')
    .update({ status: 'validating', unique_identifier_column_index: parsed.uniqueIdentifierColumnIndex })
    .eq('id', parsed.batchId);
  await writeAuditLog(service, { entityType: 'import_batch', entityId: parsed.batchId, action: 'confirm_mapping', actorId: userId });

  return { success: true };
}
