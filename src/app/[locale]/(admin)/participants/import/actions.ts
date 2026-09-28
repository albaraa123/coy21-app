// src/app/[locale]/(admin)/participants/import/actions.ts
'use server';

import { requireImportStaffCaller } from '@/lib/import/server-helpers';
import { writeAuditLog } from '@/lib/agenda/server-helpers';
import { MAX_UPLOAD_BYTES } from '@/lib/validation/import';
import { detectSheets, suggestPrimarySheet } from '@/lib/import/workbook-parser';
import { computeFileChecksum } from '@/lib/import/normalization';

const ALLOWED_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLSX_MAGIC_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP local-file-header signature — .xlsx is a ZIP container

export async function uploadImportFile(formData: FormData) {
  const { userId, service } = await requireImportStaffCaller();

  const file = formData.get('file');
  if (!(file instanceof File)) throw new Error('No file provided');
  if (file.size === 0) throw new Error('File is empty');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`File exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`);
  if (file.type !== ALLOWED_MIME && !file.name.toLowerCase().endsWith('.xlsx')) {
    throw new Error('Only .xlsx files are supported');
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  // Never trust the client-declared MIME type alone — check the actual
  // magic bytes, since a renamed .exe or .xlsm could otherwise pass the
  // extension/MIME checks above.
  if (!buffer.subarray(0, 4).equals(XLSX_MAGIC_BYTES)) {
    throw new Error('File does not appear to be a valid .xlsx workbook');
  }

  const checksum = computeFileChecksum(buffer);

  // Same-file re-upload detection (design spec step 4): surface prior
  // imports of this exact file before staging anything new.
  const { data: priorBatches } = await service
    .from('import_batches')
    .select('id, status, uploaded_at')
    .eq('file_checksum', checksum)
    .order('uploaded_at', { ascending: false })
    .limit(1);
  const priorBatch = priorBatches?.[0] ?? null;

  let sheets;
  try {
    sheets = await detectSheets(buffer);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'Failed to parse the uploaded workbook');
  }
  if (sheets.length === 0) throw new Error('No non-empty sheets found in this workbook');
  const suggestedSheet = suggestPrimarySheet(sheets);

  const storagePath = `${userId}/${Date.now()}-${crypto.randomUUID()}.xlsx`;
  const { error: uploadError } = await service.storage.from('import-uploads').upload(storagePath, buffer, {
    contentType: ALLOWED_MIME,
    upsert: false,
  });
  if (uploadError) throw new Error(`Failed to store uploaded file: ${uploadError.message}`);

  const { data: batch, error: batchError } = await service
    .from('import_batches')
    .insert({
      uploaded_by: userId,
      original_filename: file.name,
      file_checksum: checksum,
      storage_path: storagePath,
      sheet_name: suggestedSheet,
      status: 'analyzing',
    })
    .select('id')
    .single();
  if (batchError || !batch) {
    // The Storage upload above already succeeded — without this cleanup the
    // object would be orphaned (no batch row ever references it, and
    // nothing sweeps the bucket for orphans).
    await service.storage.from('import-uploads').remove([storagePath]);
    throw new Error(`Failed to create import batch: ${batchError?.message}`);
  }

  await writeAuditLog(service, {
    entityType: 'import_batch',
    entityId: batch.id,
    action: 'upload',
    actorId: userId,
    metadata: { originalFilename: file.name, fileChecksum: checksum },
  });

  return {
    batchId: batch.id,
    sheets: sheets.map((s) => s.name),
    suggestedSheet,
    priorBatch: priorBatch ? { id: priorBatch.id, status: priorBatch.status, uploadedAt: priorBatch.uploaded_at } : null,
  };
}

export async function getBatchStatus(batchId: string) {
  const { service } = await requireImportStaffCaller();
  const { data, error } = await service.from('import_batches').select('*').eq('id', batchId).single();
  if (error || !data) throw new Error('Batch not found');
  return data;
}
