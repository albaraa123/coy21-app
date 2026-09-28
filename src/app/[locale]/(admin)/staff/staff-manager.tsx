'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/routing';
import { createStaffAccount, updateStaffRole, deleteStaffAccount } from './actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type StaffProfile = {
  id: string;
  full_name: string;
  email: string;
  role: string;
  created_at: string;
};

const STAFF_ROLES = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'registration_admission_manager', label: 'Registration & Admission' },
  { value: 'agenda_allocation_manager', label: 'Agenda & Allocation' },
  { value: 'communications_attendance_manager', label: 'Communications & Attendance' },
  { value: 'travel_operations_staff', label: 'Travel Operations' },
  { value: 'participant_care_staff', label: 'Participant Care' },
  { value: 'participants_communications_manager', label: 'Participants Communications' },
  { value: 'program_attendance_manager', label: 'Program Attendance' },
] as const;

const ROLE_LABELS: Record<string, string> = Object.fromEntries(STAFF_ROLES.map((r) => [r.value, r.label]));

const EMPTY_FORM = { fullName: '', email: '', role: 'registration_admission_manager' as string, password: '' };

export default function StaffManager({ staff }: { staff: StaffProfile[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  function startCreate() {
    setError(null);
    setCreating(true);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function cancel() {
    setError(null);
    setCreating(false);
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

  const inputClass = 'rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none w-full';
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
                <th scope="col" className="px-4 py-3 text-start font-semibold">Name</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Email</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Role</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-charcoal/10">
              {staff.map((member) => (
                <tr key={member.id}>
                  <td className="px-4 py-3 font-medium text-charcoal">{member.full_name || '—'}</td>
                  <td className="px-4 py-3 text-charcoal/70">{member.email}</td>
                  <td className="px-4 py-3">
                    {editingId === member.id ? (
                      <form onSubmit={handleRoleChange} className="flex items-center gap-2">
                        <select
                          value={editRole}
                          onChange={(e) => setEditRole(e.target.value)}
                          className="rounded-md border border-charcoal/20 bg-warm-white px-2 py-1 text-xs text-charcoal focus:border-turquoise focus:outline-none"
                        >
                          {STAFF_ROLES.map((r) => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
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

      {/* Add staff button */}
      {!creating && (
        <div>
          <Button onClick={startCreate}>Add Staff Member</Button>
        </div>
      )}

      {/* Create form */}
      {creating && (
        <form onSubmit={handleCreate} className="flex flex-col gap-4 rounded-lg border border-charcoal/10 bg-warm-white p-5">
          <h2 className="text-sm font-semibold text-charcoal">New Staff Account</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className={labelClass}>
              Full Name
              <input
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                required
                placeholder="Jane Smith"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Email
              <input
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
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className={inputClass}
              >
                {STAFF_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              Temporary Password
              <input
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
