'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/routing';
import { createAssignment, deleteAssignment } from './actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type StaffProfile = { id: string; full_name: string; email: string; role: string };
type Room = { id: string; code: string; name_en: string };
type Assignment = {
  id: string;
  staff_id: string;
  assignment_type: string;
  label: string;
  notes: string | null;
  starts_at: string | null;
  ends_at: string | null;
  room_id: string | null;
};

const ASSIGNMENT_TYPES = [
  { value: 'scanning_gate', label: 'Scanning Gate' },
  { value: 'session_monitor', label: 'Session Monitor' },
  { value: 'participant_care', label: 'Participant Care' },
  { value: 'data_monitoring', label: 'Data Monitoring' },
  { value: 'general', label: 'General Task' },
] as const;

const TYPE_LABELS: Record<string, string> = Object.fromEntries(ASSIGNMENT_TYPES.map((t) => [t.value, t.label]));

const EMPTY_FORM = {
  staffId: '',
  assignmentType: 'general' as string,
  label: '',
  notes: '',
  roomId: '',
  startsAt: '',
  endsAt: '',
};

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

export default function AssignmentManager({ staff, assignments, rooms }: { staff: StaffProfile[]; assignments: Assignment[]; rooms: Room[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const staffById = Object.fromEntries(staff.map((s) => [s.id, s]));
  const roomById = Object.fromEntries(rooms.map((r) => [r.id, r]));

  function cancel() {
    setError(null);
    setCreating(false);
    setConfirmDelete(null);
    setForm(EMPTY_FORM);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createAssignment({
        staffId: form.staffId,
        assignmentType: form.assignmentType as Parameters<typeof createAssignment>[0]['assignmentType'],
        label: form.label,
        notes: form.notes || undefined,
        roomId: form.roomId || null,
        startsAt: form.startsAt || null,
        endsAt: form.endsAt || null,
      });
      cancel();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create assignment');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    setSubmitting(true);
    try {
      await deleteAssignment(id);
      setConfirmDelete(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete assignment');
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

      {/* Assignments table */}
      <div className="overflow-x-auto rounded-lg border border-charcoal/10">
        {assignments.length === 0 ? (
          <p className="p-6 text-center text-sm text-charcoal/60">No assignments yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60">
                <th scope="col" className="px-4 py-3 text-start font-semibold">Staff</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Type</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Label</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Room</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Starts</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Ends</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-charcoal/10">
              {assignments.map((a) => {
                const member = staffById[a.staff_id];
                const room = a.room_id ? roomById[a.room_id] : null;
                return (
                  <tr key={a.id}>
                    <td className="px-4 py-3 font-medium text-charcoal">{member?.full_name ?? '—'}</td>
                    <td className="px-4 py-3">
                      <Badge variant="neutral">{TYPE_LABELS[a.assignment_type] ?? a.assignment_type}</Badge>
                    </td>
                    <td className="px-4 py-3 text-charcoal/80">{a.label}</td>
                    <td className="px-4 py-3 text-charcoal/60">{room ? `${room.code} — ${room.name_en}` : '—'}</td>
                    <td className="px-4 py-3 text-charcoal/60">{formatDate(a.starts_at)}</td>
                    <td className="px-4 py-3 text-charcoal/60">{formatDate(a.ends_at)}</td>
                    <td className="px-4 py-3">
                      {confirmDelete === a.id ? (
                        <div className="flex gap-2">
                          <Button size="sm" variant="destructive" disabled={submitting} onClick={() => handleDelete(a.id)}>Confirm</Button>
                          <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(a.id)}>Remove</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add assignment button */}
      {!creating && (
        <div>
          <Button onClick={() => { setError(null); setCreating(true); }}>Add Assignment</Button>
        </div>
      )}

      {/* Create form */}
      {creating && (
        <form onSubmit={handleCreate} className="flex flex-col gap-4 rounded-lg border border-charcoal/10 bg-warm-white p-5">
          <h2 className="text-sm font-semibold text-charcoal">New Assignment</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className={labelClass}>
              Staff Member
              <select
                value={form.staffId}
                onChange={(e) => setForm({ ...form, staffId: e.target.value })}
                required
                className={inputClass}
              >
                <option value="">— select staff —</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>{s.full_name || s.email}</option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              Assignment Type
              <select
                value={form.assignmentType}
                onChange={(e) => setForm({ ...form, assignmentType: e.target.value })}
                className={inputClass}
              >
                {ASSIGNMENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              Label
              <input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                required
                placeholder="e.g. Gate A — East Entrance"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Room (optional)
              <select
                value={form.roomId}
                onChange={(e) => setForm({ ...form, roomId: e.target.value })}
                className={inputClass}
              >
                <option value="">— no specific room —</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>{r.code} — {r.name_en}</option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              Starts At (optional)
              <input
                type="datetime-local"
                value={form.startsAt}
                onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Ends At (optional)
              <input
                type="datetime-local"
                value={form.endsAt}
                onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className={`${labelClass} md:col-span-2`}>
              Notes (optional)
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
                className={inputClass}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>Create Assignment</Button>
            <Button type="button" variant="secondary" onClick={cancel}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}
