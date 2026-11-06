'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { issueMissingQrBatchAction } from './actions';

export default function IssueQrClient({ initialMissing }: { initialMissing: number }) {
  const [remaining, setRemaining] = useState(initialMissing);
  const [issued, setIssued] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      for (let i = 0; i < 60; i++) {
        const r = await issueMissingQrBatchAction();
        setIssued((n) => n + r.issued);
        setRemaining(r.remaining);
        if (r.remaining === 0) break;
        if (r.issued === 0) {
          setMessage(r.error ?? 'No progress was made.');
          break;
        }
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-charcoal dark:text-gray-100">
        Accepted participants without a conference QR yet: <strong>{remaining}</strong>
        {issued > 0 ? <> — issued in this run: <strong>{issued}</strong></> : null}
      </p>
      <Button onClick={run} disabled={busy || remaining === 0}>
        {busy ? 'Issuing…' : remaining === 0 ? 'Everyone has a QR' : `Issue QR for all ${remaining}`}
      </Button>
      {message ? <p className="text-sm text-red-700">{message}</p> : null}
    </div>
  );
}
