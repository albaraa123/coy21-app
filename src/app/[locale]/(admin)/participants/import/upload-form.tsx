'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { LoadingState } from '@/components/states/loading-state';
import { uploadImportFile } from './actions';

export default function UploadForm() {
  const t = useTranslations('participants.import.upload');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File) {
    setError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const result = await uploadImportFile(formData);
      if (result.priorBatch) {
        const proceed = window.confirm(
          t('duplicateFileConfirm', {
            date: new Date(result.priorBatch.uploadedAt).toLocaleString(),
            status: result.priorBatch.status,
          })
        );
        if (!proceed) {
          setUploading(false);
          return;
        }
      }
      router.push(`/participants/import/${result.batchId}/map`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('genericError'));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      <div
        className={`rounded-lg border-2 border-dashed bg-warm-white p-8 text-center transition-colors dark:bg-gray-900 ${
          dragOver ? 'border-turquoise bg-turquoise/5' : 'border-charcoal/20 dark:border-gray-700'
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) void handleFile(file);
        }}
      >
        <p className="mb-3 text-sm text-charcoal/70 dark:text-gray-400">{t('dropInstruction')}</p>
        <input
          type="file"
          accept=".xlsx"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
          className="mx-auto block text-sm text-charcoal file:me-3 file:rounded-md file:border-0 file:bg-turquoise file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white file:hover:bg-turquoise/85 dark:text-gray-300"
        />
      </div>
      {uploading && (
        <div className="flex items-center gap-2 text-sm text-charcoal/70 dark:text-gray-400">
          <LoadingState variant="inline" />
          <span>{t('uploading')}</span>
        </div>
      )}
    </div>
  );
}
