'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  saveEmergencyContact,
  deleteEmergencyContact,
  saveAccommodation,
  type ContactInput,
  type AccommodationInput,
} from './actions';

// ---------------------------------------------------------------------------
// Emergency Contacts
// ---------------------------------------------------------------------------

type Contact = {
  id: string;
  name: string;
  relationship: string;
  phone: string;
  email: string | null;
};

export function EmergencyContactsForm({
  applicationId,
  initial,
}: {
  applicationId: string;
  initial: Contact[];
}) {
  const [contacts, setContacts] = useState<Contact[]>(initial);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<ContactInput>({ name: '', relationship: '', phone: '', email: '' });
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();
  const [isDeleting, startDelete] = useTransition();

  function openNew() {
    setForm({ name: '', relationship: '', phone: '', email: '' });
    setEditing('new');
    setError(null);
  }

  function openEdit(c: Contact) {
    setForm({ name: c.name, relationship: c.relationship, phone: c.phone, email: c.email ?? '' });
    setEditing(c.id);
    setError(null);
  }

  function handleSave() {
    if (!form.name.trim() || !form.relationship.trim() || !form.phone.trim()) {
      setError('Name, relationship, and phone are required.');
      return;
    }
    startSave(async () => {
      const contactId = editing === 'new' ? null : editing;
      const res = await saveEmergencyContact(contactId, applicationId, form);
      if (res.error) { setError(res.error); return; }
      if (editing === 'new' && res.id) {
        setContacts((prev) => [...prev, { id: res.id!, ...form, email: form.email || null }]);
      } else {
        setContacts((prev) => prev.map((c) => c.id === editing ? { ...c, ...form, email: form.email || null } : c));
      }
      setEditing(null);
    });
  }

  function handleDelete(id: string) {
    if (!confirm('Remove this emergency contact?')) return;
    startDelete(async () => {
      const res = await deleteEmergencyContact(id, applicationId);
      if (res.error) { setError(res.error); return; }
      setContacts((prev) => prev.filter((c) => c.id !== id));
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {contacts.map((c) => (
        <div key={c.id} className="rounded-lg border border-charcoal/10 dark:border-white/10 p-4">
          {editing === c.id ? (
            <ContactEditFields form={form} setForm={setForm} error={error} onSave={handleSave} onCancel={() => setEditing(null)} saving={isSaving} />
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium text-charcoal dark:text-gray-100">{c.name}</p>
                <p className="text-xs text-charcoal/60 dark:text-gray-400">{c.relationship} · {c.phone}</p>
                {c.email && <p className="text-xs text-charcoal/50 dark:text-gray-500">{c.email}</p>}
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => openEdit(c)} className="text-xs text-turquoise hover:underline">Edit</button>
                <button onClick={() => handleDelete(c.id)} disabled={isDeleting} className="text-xs text-red-500 hover:underline">Remove</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {editing === 'new' ? (
        <div className="rounded-lg border border-dashed border-charcoal/20 dark:border-white/20 p-4">
          <ContactEditFields form={form} setForm={setForm} error={error} onSave={handleSave} onCancel={() => setEditing(null)} saving={isSaving} />
        </div>
      ) : (
        <Button onClick={openNew} variant="secondary" size="sm" className="self-start">
          + Add contact
        </Button>
      )}
    </div>
  );
}

function ContactEditFields({
  form, setForm, error, onSave, onCancel, saving,
}: {
  form: ContactInput;
  setForm: (f: ContactInput) => void;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Full name" />
        <Field label="Relationship *" value={form.relationship} onChange={(v) => setForm({ ...form, relationship: v })} placeholder="e.g. Parent, Sibling" />
        <Field label="Phone *" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="+1234567890" type="tel" />
        <Field label="Email" value={form.email ?? ''} onChange={(v) => setForm({ ...form, email: v })} placeholder="optional" type="email" />
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={onSave} disabled={saving} size="sm">{saving ? 'Saving…' : 'Save'}</Button>
        <Button onClick={onCancel} variant="ghost" size="sm">Cancel</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accommodation
// ---------------------------------------------------------------------------

type Accommodation = {
  hotel_name: string | null;
  location_note: string | null;
  room_number: string | null;
};

export function AccommodationForm({
  applicationId,
  initial,
}: {
  applicationId: string;
  initial: Accommodation | null;
}) {
  const [form, setForm] = useState<AccommodationInput>({
    hotel_name: initial?.hotel_name ?? '',
    location_note: initial?.location_note ?? '',
    room_number: initial?.room_number ?? '',
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();

  function handleSave() {
    setSaved(false);
    setError(null);
    startSave(async () => {
      const res = await saveAccommodation(applicationId, form);
      if (res.error) { setError(res.error); return; }
      setSaved(true);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Hotel / Accommodation name" value={form.hotel_name} onChange={(v) => setForm({ ...form, hotel_name: v })} placeholder="e.g. Akra Hotel" />
        <Field label="Room number" value={form.room_number} onChange={(v) => setForm({ ...form, room_number: v })} placeholder="e.g. 412" />
        <div className="sm:col-span-2">
          <Field label="Location note" value={form.location_note} onChange={(v) => setForm({ ...form, location_note: v })} placeholder="e.g. Near the conference centre" />
        </div>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {saved && <p className="text-xs text-green-600 dark:text-green-400">Saved.</p>}
      <Button onClick={handleSave} disabled={isSaving} size="sm" className="self-start">
        {isSaving ? 'Saving…' : 'Save accommodation'}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared field component
// ---------------------------------------------------------------------------

function Field({
  label, value, onChange, placeholder, type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-charcoal/70 dark:text-gray-400">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-charcoal/20 bg-transparent px-3 py-2 text-sm text-charcoal outline-none focus:border-turquoise focus:ring-1 focus:ring-turquoise dark:border-white/20 dark:text-gray-100"
      />
    </div>
  );
}
