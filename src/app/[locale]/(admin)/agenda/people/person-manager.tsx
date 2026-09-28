'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { createPerson, updatePerson, deactivatePerson, reactivatePerson } from './actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

type Person = {
  id: string;
  full_name_ar: string;
  full_name_en: string;
  title_ar: string | null;
  title_en: string | null;
  organization_ar: string | null;
  organization_en: string | null;
  bio_ar: string | null;
  bio_en: string | null;
  photo_path: string | null;
  email: string | null;
  phone: string | null;
  linked_profile_id: string | null;
  is_active: boolean;
  is_public: boolean;
};

type ProfileOption = { id: string; full_name: string };

type FormState = {
  fullNameAr: string;
  fullNameEn: string;
  titleAr: string;
  titleEn: string;
  organizationAr: string;
  organizationEn: string;
  bioAr: string;
  bioEn: string;
  photoPath: string;
  email: string;
  phone: string;
  linkedProfileId: string;
  isPublic: boolean;
};

const EMPTY_FORM: FormState = {
  fullNameAr: '',
  fullNameEn: '',
  titleAr: '',
  titleEn: '',
  organizationAr: '',
  organizationEn: '',
  bioAr: '',
  bioEn: '',
  photoPath: '',
  email: '',
  phone: '',
  linkedProfileId: '',
  isPublic: false,
};

function personToForm(person: Person): FormState {
  return {
    fullNameAr: person.full_name_ar,
    fullNameEn: person.full_name_en,
    titleAr: person.title_ar ?? '',
    titleEn: person.title_en ?? '',
    organizationAr: person.organization_ar ?? '',
    organizationEn: person.organization_en ?? '',
    bioAr: person.bio_ar ?? '',
    bioEn: person.bio_en ?? '',
    photoPath: person.photo_path ?? '',
    email: person.email ?? '',
    phone: person.phone ?? '',
    linkedProfileId: person.linked_profile_id ?? '',
    isPublic: person.is_public,
  };
}

const inputClass =
  'rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

export default function PersonManager({
  people,
  profileOptions,
}: {
  people: Person[];
  profileOptions: ProfileOption[];
}) {
  const t = useTranslations('agenda.people');
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function startCreate() {
    setError(null);
    setEditingId(null);
    setCreating(true);
    setForm(EMPTY_FORM);
  }

  function startEdit(person: Person) {
    setError(null);
    setCreating(false);
    setEditingId(person.id);
    setForm(personToForm(person));
  }

  function cancel() {
    setError(null);
    setCreating(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const input = {
        fullNameAr: form.fullNameAr,
        fullNameEn: form.fullNameEn,
        titleAr: form.titleAr.trim() ? form.titleAr : null,
        titleEn: form.titleEn.trim() ? form.titleEn : null,
        organizationAr: form.organizationAr.trim() ? form.organizationAr : null,
        organizationEn: form.organizationEn.trim() ? form.organizationEn : null,
        bioAr: form.bioAr.trim() ? form.bioAr : null,
        bioEn: form.bioEn.trim() ? form.bioEn : null,
        photoPath: form.photoPath.trim() ? form.photoPath : null,
        email: form.email.trim() ? form.email : null,
        phone: form.phone.trim() ? form.phone : null,
        linkedProfileId: form.linkedProfileId ? form.linkedProfileId : null,
        isPublic: form.isPublic,
      };
      if (editingId) {
        await updatePerson(editingId, input);
      } else {
        await createPerson(input);
      }
      cancel();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeactivate(id: string) {
    setError(null);
    try {
      await deactivatePerson(id);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deactivateError'));
    }
  }

  async function handleReactivate(id: string) {
    setError(null);
    try {
      await reactivatePerson(id);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reactivateError'));
    }
  }

  const showForm = creating || editingId !== null;

  return (
    <div>
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {people.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <>
          {/* Mobile: card-per-person list. Desktop (md+): table. Both trees
              render the same `people` data and must be kept in sync — any
              column added to one must be added to the other. */}
          <div className="flex flex-col gap-2 md:hidden">
            {people.map((person) => (
              <Card key={person.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-charcoal dark:text-gray-100">{person.full_name_en}</p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={person.is_active ? 'changed' : 'neutral'}>
                      {person.is_active ? t('active') : t('inactive')}
                    </Badge>
                    {person.is_public && <Badge variant="pending">{t('publicOnSpeakersPage')}</Badge>}
                  </div>
                </div>
                <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{person.full_name_ar}</p>
                <div className="mt-2 flex flex-col gap-1 text-xs text-charcoal/60 dark:text-gray-400">
                  {person.title_en && <span>{person.title_en}</span>}
                  {person.organization_en && <span>{person.organization_en}</span>}
                  {person.email && <span>{person.email}</span>}
                  <span>
                    {t('linkedAccount')}:{' '}
                    {person.linked_profile_id
                      ? profileOptions.find((p) => p.id === person.linked_profile_id)?.full_name ?? person.linked_profile_id
                      : t('linkedAccountNone')}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => startEdit(person)}>{t('edit')}</Button>
                  {person.is_active ? (
                    <Button size="sm" variant="destructive" onClick={() => handleDeactivate(person.id)}>{t('deactivate')}</Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => handleReactivate(person.id)}>{t('reactivate')}</Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('nameAr')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('nameEn')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('titleEn')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('organizationEn')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('email')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('linkedAccount')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('publicOnSpeakersPage')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                {people.map((person) => (
                  <tr key={person.id}>
                    <td className="px-4 py-2 text-charcoal dark:text-gray-100">{person.full_name_ar}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{person.full_name_en}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{person.title_en ?? '—'}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{person.organization_en ?? '—'}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{person.email ?? '—'}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                      {person.linked_profile_id
                        ? profileOptions.find((p) => p.id === person.linked_profile_id)?.full_name ?? person.linked_profile_id
                        : t('linkedAccountNone')}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={person.is_active ? 'changed' : 'neutral'}>
                        {person.is_active ? t('active') : t('inactive')}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">
                      {person.is_public && <Badge variant="pending">{t('yes')}</Badge>}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => startEdit(person)}>{t('edit')}</Button>
                        {person.is_active ? (
                          <Button size="sm" variant="destructive" onClick={() => handleDeactivate(person.id)}>{t('deactivate')}</Button>
                        ) : (
                          <Button size="sm" variant="secondary" onClick={() => handleReactivate(person.id)}>{t('reactivate')}</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!showForm && (
        <div className="mt-4">
          <Button onClick={startCreate}>{t('addNew')}</Button>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3 rounded-lg border border-charcoal/10 bg-warm-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">
            {editingId ? t('formTitleEdit') : t('formTitleCreate')}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
              {t('nameAr')}
              <input
                value={form.fullNameAr}
                onChange={(e) => setForm({ ...form, fullNameAr: e.target.value })}
                required
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
              {t('nameEn')}
              <input
                value={form.fullNameEn}
                onChange={(e) => setForm({ ...form, fullNameEn: e.target.value })}
                required
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
              {t('titleAr')}
              <input
                value={form.titleAr}
                onChange={(e) => setForm({ ...form, titleAr: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
              {t('titleEn')}
              <input
                value={form.titleEn}
                onChange={(e) => setForm({ ...form, titleEn: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
              {t('organizationAr')}
              <input
                value={form.organizationAr}
                onChange={(e) => setForm({ ...form, organizationAr: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
              {t('organizationEn')}
              <input
                value={form.organizationEn}
                onChange={(e) => setForm({ ...form, organizationEn: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('bioAr')}
            <textarea
              value={form.bioAr}
              onChange={(e) => setForm({ ...form, bioAr: e.target.value })}
              rows={3}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('bioEn')}
            <textarea
              value={form.bioEn}
              onChange={(e) => setForm({ ...form, bioEn: e.target.value })}
              rows={3}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('photoPath')}
            <input
              value={form.photoPath}
              onChange={(e) => setForm({ ...form, photoPath: e.target.value })}
              className={inputClass}
            />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
              {t('email')}
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
              {t('phone')}
              <input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('linkedAccount')}
            <select
              value={form.linkedProfileId}
              onChange={(e) => setForm({ ...form, linkedProfileId: e.target.value })}
              className={inputClass}
            >
              <option value="">{t('linkedAccountNone')}</option>
              {profileOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.full_name}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-charcoal dark:text-gray-100">
            <input
              type="checkbox"
              checked={form.isPublic}
              onChange={(e) => setForm({ ...form, isPublic: e.target.checked })}
            />
            {t('publicOnSpeakersPage')}
          </label>
          <p className="text-xs text-charcoal/60 dark:text-gray-400">{t('publicOnSpeakersPageHint')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="submit" disabled={submitting}>{editingId ? t('save') : t('create')}</Button>
            <Button type="button" variant="secondary" onClick={cancel}>{t('cancel')}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
