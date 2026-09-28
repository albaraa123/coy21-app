'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { createTrack, updateTrack, deactivateTrack, reactivateTrack } from './actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

type Track = {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  color: string | null;
  is_active: boolean;
};

type FormState = {
  code: string;
  nameAr: string;
  nameEn: string;
  color: string;
};

const EMPTY_FORM: FormState = { code: '', nameAr: '', nameEn: '', color: '' };

function trackToForm(track: Track): FormState {
  return {
    code: track.code,
    nameAr: track.name_ar,
    nameEn: track.name_en,
    color: track.color ?? '',
  };
}

// Purely visual helper — renders the existing `color` string as a small
// swatch next to its hex text. Not new data or logic, just a presentation
// of the value that's already being displayed as text.
function ColorSwatch({ color }: { color: string | null }) {
  if (!color) return <span>—</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="inline-block h-3 w-3 shrink-0 rounded-full border border-charcoal/20 dark:border-gray-600"
        style={{ backgroundColor: color }}
      />
      {color}
    </span>
  );
}

export default function TrackManager({ tracks }: { tracks: Track[] }) {
  const t = useTranslations('agenda.tracks');
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

  function startEdit(track: Track) {
    setError(null);
    setCreating(false);
    setEditingId(track.id);
    setForm(trackToForm(track));
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
        code: form.code,
        nameAr: form.nameAr,
        nameEn: form.nameEn,
        color: form.color.trim() ? form.color : null,
      };
      if (editingId) {
        await updateTrack(editingId, input);
      } else {
        await createTrack(input);
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
      await deactivateTrack(id);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deactivateError'));
    }
  }

  async function handleReactivate(id: string) {
    setError(null);
    try {
      await reactivateTrack(id);
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

      {tracks.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <>
          {/* Mobile: card-per-track list. Desktop (md+): table. Both trees
              render the same `tracks` data and must be kept in sync — any
              column added to one must be added to the other. */}
          <div className="flex flex-col gap-2 md:hidden">
            {tracks.map((track) => (
              <Card key={track.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-charcoal dark:text-gray-100">{track.code}</p>
                  <Badge variant={track.is_active ? 'changed' : 'neutral'}>
                    {track.is_active ? t('active') : t('inactive')}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{track.name_en}</p>
                <p className="text-sm text-charcoal/70 dark:text-gray-400">{track.name_ar}</p>
                <p className="mt-2 text-xs text-charcoal/60 dark:text-gray-400">
                  {t('color')}: <ColorSwatch color={track.color} />
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => startEdit(track)}>{t('edit')}</Button>
                  {track.is_active ? (
                    <Button size="sm" variant="destructive" onClick={() => handleDeactivate(track.id)}>{t('deactivate')}</Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => handleReactivate(track.id)}>{t('reactivate')}</Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('code')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('nameAr')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('nameEn')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('color')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                {tracks.map((track) => (
                  <tr key={track.id}>
                    <td className="px-4 py-2 text-charcoal dark:text-gray-100">{track.code}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{track.name_ar}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{track.name_en}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400"><ColorSwatch color={track.color} /></td>
                    <td className="px-4 py-2">
                      <Badge variant={track.is_active ? 'changed' : 'neutral'}>
                        {track.is_active ? t('active') : t('inactive')}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => startEdit(track)}>{t('edit')}</Button>
                        {track.is_active ? (
                          <Button size="sm" variant="destructive" onClick={() => handleDeactivate(track.id)}>{t('deactivate')}</Button>
                        ) : (
                          <Button size="sm" variant="secondary" onClick={() => handleReactivate(track.id)}>{t('reactivate')}</Button>
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
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('code')}
            <input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              required
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('nameAr')}
            <input
              value={form.nameAr}
              onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
              required
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('nameEn')}
            <input
              value={form.nameEn}
              onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
              required
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('color')}
            <input
              value={form.color}
              onChange={(e) => setForm({ ...form, color: e.target.value })}
              placeholder={t('colorPlaceholder')}
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="submit" disabled={submitting}>{editingId ? t('save') : t('create')}</Button>
            <Button type="button" variant="secondary" onClick={cancel}>{t('cancel')}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
