'use client';

// Client component for uploading a participant's own document
// (currently: flight ticket). Uploads directly to Supabase Storage
// via the anon-key client — Storage RLS enforces ownership using the
// caller's JWT, so no server action is needed here.

import { useState, useRef } from 'react';
import { createBrowserClient } from '@supabase/ssr';

const BUCKET = 'participant-documents';

type Props = {
  userId: string;
  docKey: string;
  label: string;
};

export function DocumentUpload({ userId, docKey, label }: Props) {
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatus('uploading');
    setErrorMsg(null);

    // Path: {userId}/{docKey}/{filename} — RLS checks foldername[1] = userId
    const path = `${userId}/${docKey}/${file.name}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { upsert: true });

    if (error) {
      setStatus('error');
      setErrorMsg(error.message);
    } else {
      setStatus('done');
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <label className="cursor-pointer rounded-md bg-charcoal/5 px-3 py-1.5 text-xs font-medium text-charcoal hover:bg-charcoal/10 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/15">
        {status === 'uploading' ? 'Uploading…' : status === 'done' ? 'Replace' : `Upload ${label}`}
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept=".pdf,.jpg,.jpeg,.png"
          disabled={status === 'uploading'}
          onChange={handleChange}
        />
      </label>
      {status === 'done' && (
        <span className="text-xs text-green-600 dark:text-green-400">Uploaded</span>
      )}
      {status === 'error' && errorMsg && (
        <span className="max-w-[180px] text-right text-xs text-red-600 dark:text-red-400">{errorMsg}</span>
      )}
    </div>
  );
}
