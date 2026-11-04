'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/routing';
import {
  createStaffAccount,
  updateStaffRole,
  deleteStaffAccount,
  sendExistingStaffWelcomeEmails,
  type ExistingStaffWelcomeEmailResult,
} from './actions';
import BulkImportForm from './bulk-import-form';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

type StaffProfile = {
  id: string;
  full_name: string;
  email: string;
  role: string;
  created_at: string;
};

const STAFF_ROLES = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'staff', label: 'Staff' },
  { value: 'scanner_device', label: 'Scanner Device' },
] as const;

const ROLE_LABELS: Record<string, string> = Object.fromEntries(STAFF_ROLES.map((r) => [r.value, r.label]));

const EMPTY_FORM = { fullName: '', email: '', role: 'staff' as string, password: '' };

export default function StaffManager({ staff }: { staff: StaffProfile[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sendingEmails, setSendingEmails] = useState(false);
  const [welcomeEmailPassword, setWelcomeEmailPassword] = useState('');
  const [emailResults, setEmailResults] = useState<{
    results: ExistingStaffWelcomeEmailResult[];
    sentCount: number;
    failedCount: number;
  } | null>(null);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.size === staff.length ? new Set() : new Set(staff.map((m) => m.id))));
  }

  async function handleSendWelcomeEmails() {
    if (selectedIds.size === 0) return;
    setError(null);
    setEmailResults(null);
    setSendingEmails(true);
    try {
      const outcome = await sendExistingStaffWelcomeEmails({
        staffIds: Array.from(selectedIds),
        temporaryPassword: welcomeEmailPassword,
      });
      setEmailResults(outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send welcome emails');
    } finally {
      setSendingEmails(false);
    }
  }

  function startCreate() {
    setError(null);
    setCreating(true);
    setBulkImporting(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function startBulkImport() {
    setError(null);
    setBulkImporting(true);
    setCreating(false);
    setEditingId(null);
  }

  function cancel() {
    setError(null);
    setCreating(false);
    setBulkImporting(false);
    setEditingId(null);
    setConfirmDelete(null);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createStaffAccount(form as Parameters<typeof createStaffAccount>[0]);
      cancel();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setSubmitting(false);
    }
  }

  function startEditRole(member: StaffProfile) {
    setError(null);
    setCreating(false);
    setEditingId(member.id);
    setEditRole(member.role);
  }

  async function handleRoleChange(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setError(null);
    setSubmitting(true);
    try {
      await updateStaffRole({ staffId: editingId, role: editRole as Parameters<typeof updateStaffRole>[0]['role'] });
      cancel();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    setSubmitting(true);
    try {
      await deleteStaffAccount(id);
      cancel();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete account');
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass = 'rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal transition-colors duration-150 focus:border-turquoise focus:outline-none w-full';
  const labelClass = 'flex flex-col gap-1 text-sm font-medium text-charcoal';

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {/* Staff table */}
      <div className="overflow-x-auto rounded-lg border border-charcoal/10">
        {staff.length === 0 ? (
          <p className="p-6 text-center text-sm text-charcoal/60">No staff accounts yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60">
                <th scope="col" className="px-4 py-3 text-start font-semibold">
                  <input
                    type="checkbox"
                    checked={staff.length > 0 && selectedIds.size === staff.length}
                    onChange={toggleSelectAll}
                    aria-label="Select all staff accounts"
                  />
                </th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Name</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Email</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Role</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-charcoal/10">
              {staff.map((member) => (
                <tr key={member.id}>
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(member.id)}
                      onChange={() => toggleSelected(member.id)}
                      aria-label={`Select ${member.full_name || member.email}`}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-charcoal">{member.full_name || '—'}</td>
                  <td className="px-4 py-3 text-charcoal/70">{member.email}</td>
                  <td className="px-4 py-3">
                    {editingId === member.id ? (
                      <form onSubmit={handleRoleChange} className="flex items-center gap-2">
                        <Select
                          value={editRole}
                          onChange={(e) => setEditRole(e.target.value)}
                          className="rounded-md border border-charcoal/20 bg-warm-white px-2 py-1 text-xs text-charcoal focus:border-turquoise focus:outline-none"
                        >
                          {STAFF_ROLES.map((r) => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </Select>
                        <Button type="submit" size="sm" disabled={submitting}>Save</Button>
                        <Button type="button" size="sm" variant="secondary" onClick={cancel}>Cancel</Button>
                      </form>
                    ) : (
                      <Badge variant="neutral">{ROLE_LABELS[member.role] ?? member.role}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {editingId !== member.id && (
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="secondary" onClick={() => startEditRole(member)}>Change Role</Button>
                        {confirmDelete === member.id ? (
                          <>
                            <Button size="sm" variant="destructive" disabled={submitting} onClick={() => handleDelete(member.id)}>
                              Confirm Delete
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                          </>
                        ) : (
                          <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(member.id)}>Delete</Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Bulk welcome email for selected existing accounts */}
      {selectedIds.size > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-charcoal/10 bg-warm-white p-5">
          <h2 className="text-sm font-semibold text-charcoal">
            Send Welcome Emails to {selectedIds.size} selected account{selectedIds.size === 1 ? '' : 's'}
          </h2>
          <p className="text-xs text-charcoal/60">
            Enter the password these accounts already use to log in — this is only to include it in the email, it does not
            change anything.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className={labelClass}>
              Password
              <Input
                type="password"
                value={welcomeEmailPassword}
                onChange={(e) => setWelcomeEmailPassword(e.target.value)}
                minLength={8}
                placeholder="Min. 8 characters"
                className={inputClass}
              />
            </label>
            <Button
              type="button"
              onClick={handleSendWelcomeEmails}
              disabled={sendingEmails || welcomeEmailPassword.length < 8}
            >
              {sendingEmails ? 'Sending…' : `Send Welcome Emails (${selectedIds.size})`}
            </Button>
          </div>

          {emailResults && (
            <div className="flex flex-col gap-2">
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
                      <tr key={r.id}>
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
        </div>
      )}

      {/* Add staff button */}
      {!creating && !bulkImporting && (
        <div className="flex gap-2">
          <Button onClick={startCreate}>Add Staff Member</Button>
          <Button variant="secondary" onClick={startBulkImport}>Bulk Import from Excel</Button>
        </div>
      )}

      {bulkImporting && <BulkImportForm onClose={cancel} />}

      {/* Create form */}
      {creating && (
        <form onSubmit={handleCreate} className="flex flex-col gap-4 rounded-lg border border-charcoal/10 bg-warm-white p-5">
          <h2 className="text-sm font-semibold text-charcoal">New Staff Account</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className={labelClass}>
              Full Name
              <Input
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                required
                placeholder="Jane Smith"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Email
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                placeholder="jane@example.com"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Role
              <Select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className={inputClass}
              >
                {STAFF_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </Select>
            </label>
            <label className={labelClass}>
              Temporary Password
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
                minLength={8}
                placeholder="Min. 8 characters"
                className={inputClass}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>Create Account</Button>
            <Button type="button" variant="secondary" onClick={cancel}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}
