'use client';

// src/app/[locale]/(admin)/staff/bulk-import-form.tsx
//
// UI for bulkCreateStaffAccounts (bulk-import-actions.ts). A separate
// component (not folded into staff-manager.tsx) since it owns a distinct
// piece of state (the uploaded File, the per-row results table) with no
// overlap with the single-account create/edit form already there.
import { useState } from 'react';
import { useRouter } from '@/i18n/routing';
import {
  bulkCreateStaffAccounts,
  sendWelcomeEmailsForBatch,
  type BulkImportRowResult,
  type WelcomeEmailSendResult,
} from './bulk-import-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

const STAFF_ROLES = [
  { value: 'scanner_device', label: 'Scanner Device' },
  { value: 'staff', label: 'Staff' },
  { value: 'super_admin', label: 'Super Admin' },
] as const;

export default function BulkImportForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [role, setRole] = useState<string>('scanner_device');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ results: BulkImportRowResult[]; createdCount: number; failedCount: number } | null>(null);
  const [sendingEmails, setSendingEmails] = useState(false);
  const [emailResults, setEmailResults] = useState<{ results: WelcomeEmailSendResult[]; sentCount: number; failedCount: number } | null>(
    null
  );
  const [emailError, setEmailError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError('Choose an .xlsx file first');
      return;
    }
    setError(null);
    setResults(null);
    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.set('file', file);
      formData.set('role', role);
      formData.set('password', password);
      const outcome = await bulkCreateStaffAccounts(formData);
      setResults(outcome);
      if (outcome.createdCount > 0) router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk import failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSendWelcomeEmails() {
    if (!results) return;
    const createdRows = results.results
      .filter((r): r is Extract<BulkImportRowResult, { status: 'created' }> => r.status === 'created')
      .map((r) => ({ fullName: r.fullName, email: r.email }));
    if (createdRows.length === 0) return;

    setEmailError(null);
    setSendingEmails(true);
    try {
      const outcome = await sendWelcomeEmailsForBatch(createdRows, role as 'staff' | 'super_admin' | 'scanner_device', password);
      setEmailResults(outcome);
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : 'Failed to send welcome emails');
    } finally {
      setSendingEmails(false);
    }
  }

  const inputClass =
    'rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal transition-colors duration-150 focus:border-turquoise focus:outline-none w-full';
  const labelClass = 'flex flex-col gap-1 text-sm font-medium text-charcoal';

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-charcoal/10 bg-warm-white p-5">
      <h2 className="text-sm font-semibold text-charcoal">Bulk Import Accounts</h2>
      <p className="text-xs text-charcoal/60">
        Upload the volunteer tracker (.xlsx, &quot;Staff Accounts&quot; sheet, Full Name + Email columns). One account is created per
        filled-in row, all with the same role and password set below.
      </p>

      {!results && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <label className={labelClass}>
              File
              <input
                type="file"
                accept=".xlsx"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Role for all accounts
              <Select value={role} onChange={(e) => setRole(e.target.value)} className={inputClass}>
                {STAFF_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className={labelClass}>
              Shared Password
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                placeholder="Min. 8 characters"
                className={inputClass}
              />
            </label>
          </div>

          {error && (
            <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Importing…' : 'Import Accounts'}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {results && (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-charcoal">
            {results.createdCount} account{results.createdCount === 1 ? '' : 's'} created
            {results.failedCount > 0 && `, ${results.failedCount} row${results.failedCount === 1 ? '' : 's'} failed`}.
          </p>
          <div className="max-h-80 overflow-y-auto rounded-md border border-charcoal/10">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-charcoal/10 bg-white text-charcoal/60">
                  <th scope="col" className="px-3 py-2 text-start font-semibold">Row</th>
                  <th scope="col" className="px-3 py-2 text-start font-semibold">Name</th>
                  <th scope="col" className="px-3 py-2 text-start font-semibold">Email</th>
                  <th scope="col" className="px-3 py-2 text-start font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal/10">
                {results.results.map((r) => (
                  <tr key={r.row}>
                    <td className="px-3 py-2 text-charcoal/60">{r.row}</td>
                    <td className="px-3 py-2 text-charcoal">{r.fullName || '—'}</td>
                    <td className="px-3 py-2 text-charcoal/70">{r.email || '—'}</td>
                    <td className="px-3 py-2">
                      {r.status === 'created' ? (
                        <span className="text-green-700">Created</span>
                      ) : (
                        <span className="text-red-700" title={r.error}>
                          Failed: {r.error}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {results.createdCount > 0 && (role === 'staff' || role === 'super_admin') && !emailResults && (
            <div className="flex flex-col gap-2 rounded-md border border-charcoal/10 bg-white p-3">
              <p className="text-xs text-charcoal/70">
                Send each newly-created account a welcome email with their login details and the same password set above.
              </p>
              {emailError && (
                <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {emailError}
                </p>
              )}
              <div>
                <Button type="button" onClick={handleSendWelcomeEmails} disabled={sendingEmails}>
                  {sendingEmails ? 'Sending…' : `Send Welcome Emails (${results.createdCount})`}
                </Button>
              </div>
            </div>
          )}

          {emailResults && (
            <div className="flex flex-col gap-2 rounded-md border border-charcoal/10 bg-white p-3">
              <p className="text-sm font-medium text-charcoal">
                {emailResults.sentCount} email{emailResults.sentCount === 1 ? '' : 's'} sent
                {emailResults.failedCount > 0 && `, ${emailResults.failedCount} failed`}.
              </p>
              <div className="max-h-60 overflow-y-auto rounded-md border border-charcoal/10">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-charcoal/10 bg-white text-charcoal/60">
                      <th scope="col" className="px-3 py-2 text-start font-semibold">Email</th>
                      <th scope="col" className="px-3 py-2 text-start font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-charcoal/10">
                    {emailResults.results.map((r) => (
                      <tr key={r.email}>
                        <td className="px-3 py-2 text-charcoal/70">{r.email}</td>
                        <td className="px-3 py-2">
                          {r.status === 'sent' ? (
                            <span className="text-green-700">Sent</span>
                          ) : (
                            <span className="text-red-700" title={r.error}>
                              Failed: {r.error}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
