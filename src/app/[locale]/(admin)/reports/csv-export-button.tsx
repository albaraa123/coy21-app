'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function CsvExportButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/reports/participants-csv');
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `coy21-participants-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={handleExport} disabled={loading} size="sm">
        {loading ? 'Exporting…' : 'Export Participants CSV'}
      </Button>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
