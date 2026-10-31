'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

// Generalized from the original participants-only export (now the
// default props) so the same component serves any staff CSV download --
// e.g. the attendance log export (reports/page.tsx) -- without
// duplicating the fetch/blob/error-handling logic per export.
export function CsvExportButton({
  endpoint = '/api/admin/reports/participants-csv',
  filenamePrefix = 'coy21-participants',
  label = 'Export Participants CSV',
  loadingLabel = 'Exporting…',
}: {
  endpoint?: string;
  filenamePrefix?: string;
  label?: string;
  loadingLabel?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Export ready');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={handleExport} disabled={loading} size="sm">
        {loading ? loadingLabel : label}
      </Button>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
