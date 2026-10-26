'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { createClient as createBrowserSupabaseClient } from '@/lib/supabase/client';
import PhoneInput from 'react-phone-number-input';
import 'react-phone-number-input/style.css';
import {
  saveEmergencyContact,
  deleteEmergencyContact,
  saveAccommodation,
  saveIdentity,
  type ContactInput,
  type AccommodationInput,
} from './actions';

// ---------------------------------------------------------------------------
// Identity (Name / Email / Phone / Photo)
// ---------------------------------------------------------------------------

type Identity = {
  full_name: string;
  email: string;
  phone: string | null;
  avatar_path: string | null;
};

// Mirrors the avatars bucket's own allowed_mime_types/file_size_limit
// (20261025000100_avatars_bucket.sql) for a fast client-side pre-check.
const AVATAR_ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export function IdentityForm({ initial, initialAvatarUrl }: { initial: Identity; initialAvatarUrl?: string }) {
  const [form, setForm] = useState({
    fullName: initial.full_name,
    email: initial.email,
    phone: initial.phone ?? '',
  });
  const [avatarPath, setAvatarPath] = useState<string | null>(initial.avatar_path);
  // Preview shown in the form itself. Starts as the server-signed URL for
  // an already-saved photo; replaced with an instant local object URL the
  // moment a new file is picked (before the upload even finishes), so the
  // user sees what they're about to save without waiting on a round trip.
  // Object URLs are revoked on unmount/replacement to avoid leaking memory.
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(initialAvatarUrl);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Client-side pre-check mirrors the avatars bucket's own
    // allowed_mime_types/file_size_limit (20261025000100_avatars_bucket.sql)
    // so a bad file gets a clear message here instead of a raw Storage
    // error after a wasted upload attempt. The bucket config remains the
    // real enforcement boundary -- this is just a faster, friendlier
    // first check.
    if (!AVATAR_ALLOWED_MIME_TYPES.includes(file.type)) {
      setError('Please choose a PNG, JPEG, or WebP image.');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setError('Image must be 5 MB or smaller.');
      return;
    }
    // Instant local preview, before any network round trip -- revoke the
    // previous object URL first so selecting several files in a row
    // doesn't leak one blob URL per selection.
    setPreviewUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setUploading(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setError('Not authenticated'); return; }
      // Fixed filename (no variable extension) -- uploading a new photo
      // always overwrites the same object via upsert:true, instead of
      // leaving the previous upload's file orphaned in the bucket when
      // the file extension changes between saves.
      const path = `${user.id}/avatar`;
      const { error: uploadError } = await supabase.storage.from('avatars').upload(path, file, { upsert: true });
      if (uploadError) { setError(uploadError.message); return; }
      setAvatarPath(path);
    } finally {
      setUploading(false);
    }
  }

  function handleSave() {
    setSaved(false);
    setError(null);
    if (!form.fullName.trim() || !form.email.trim() || !form.phone.trim() || !avatarPath) {
      setError('Name, email, phone, and a profile picture are required.');
      return;
    }
    startSave(async () => {
      const res = await saveIdentity({ ...form, avatarPath });
      if (res.error) { setError(res.error); return; }
      setSaved(true);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name *" value={form.fullName} onChange={(v) => setForm({ ...form, fullName: v })} />
        <Field label="Email *" value={form.email} onChange={(v) => setForm({ ...form, email: v })} type="email" />
        <PhoneField label="Phone *" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-charcoal/70 dark:text-gray-400">Profile Picture *</label>
          <div className="flex items-center gap-3">
            {previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- transient blob:/signed URL, not a static asset next/image can cache
              <img src={previewUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
            )}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleAvatarChange}
              disabled={uploading}
              className="text-sm text-charcoal/70 dark:text-gray-400 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-turquoise file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-turquoise/85 file:disabled:opacity-50"
            />
          </div>
          {avatarPath && <p className="text-xs text-green-600 dark:text-green-400">Photo on file.</p>}
        </div>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {saved && <p className="text-xs text-green-600 dark:text-green-400">Saved.</p>}
      <Button onClick={handleSave} disabled={isSaving || uploading} size="sm" className="self-start">
        {isSaving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}

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
        <PhoneField label="Phone *" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
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
    if (!form.hotel_name.trim() || !form.location_note.trim()) {
      setError('Hotel name and location note are required.');
      return;
    }
    startSave(async () => {
      const res = await saveAccommodation(applicationId, form);
      if (res.error) { setError(res.error); return; }
      setSaved(true);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Hotel / Accommodation name *" value={form.hotel_name} onChange={(v) => setForm({ ...form, hotel_name: v })} placeholder="e.g. Akra Hotel" />
        <Field label="Room number" value={form.room_number} onChange={(v) => setForm({ ...form, room_number: v })} placeholder="e.g. 412" />
        <div className="sm:col-span-2">
          <Field label="Location note *" value={form.location_note} onChange={(v) => setForm({ ...form, location_note: v })} placeholder="e.g. Near the conference centre" />
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

// Phone input with a searchable country/dial-code dropdown (flags +
// names), via react-phone-number-input. Stores the full E.164 value
// (e.g. "+96877148883") in the same plain string field every other
// phone input in this file already uses -- no schema/type change
// needed anywhere a phone number is read. The library's own default
// select/input markup is overridden with classNames matching this
// file's existing Field styling (border-charcoal/20, focus:border-
// turquoise, rounded-md) so it doesn't look like a foreign component.
function PhoneField({
  label, value, onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-charcoal/70 dark:text-gray-400">{label}</label>
      <PhoneInput
        international
        countryCallingCodeEditable={false}
        defaultCountry="TR"
        value={value}
        onChange={(v) => onChange(v ?? '')}
        className="coy21-phone-input flex w-full items-center gap-2 rounded-md border border-charcoal/20 bg-transparent px-3 py-2 text-sm text-charcoal focus-within:border-turquoise focus-within:ring-1 focus-within:ring-turquoise dark:border-white/20 dark:text-gray-100"
        numberInputProps={{ className: 'flex-1 bg-transparent outline-none' }}
      />
    </div>
  );
}
