'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { createConferenceDay, updateConferenceDay, deactivateConferenceDay, reactivateConferenceDay } from './actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

type ConferenceDay = {
  id: string;
  conference_date: string;
  label_ar: string;
  label_en: string;
  display_order: number;
  is_active: boolean;
};

type FormState = {
  conferenceDate: string;
  labelAr: string;
  labelEn: string;
  displayOrder: string;
};

const EMPTY_FORM: FormState = {
  conferenceDate: '',
  labelAr: '',
  labelEn: '',
  displayOrder: '',
};

function dayToForm(day: ConferenceDay): FormState {
  return {
    conferenceDate: day.conference_date,
    labelAr: day.label_ar,
    labelEn: day.label_en,
    displayOrder: String(day.display_order),
  };
}

export default function DayManager({ days }: { days: ConferenceDay[] }) {
  const t = useTranslations('agenda.days');
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

  function startEdit(day: ConferenceDay) {
    setError(null);
    setCreating(false);
    setEditingId(day.id);
    setForm(dayToForm(day));
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
      const displayOrder = Number(form.displayOrder);
      if (!Number.isInteger(displayOrder)) {
        throw new Error(t('displayOrderError'));
      }
      const input = {
        conferenceDate: form.conferenceDate,
        labelAr: form.labelAr,
        labelEn: form.labelEn,
        displayOrder,
      };
      if (editingId) {
        await updateConferenceDay(editingId, input);
      } else {
        await createConferenceDay(input);
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
      await deactivateConferenceDay(id);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deactivateError'));
    }
  }

  async function handleReactivate(id: string) {
    setError(null);
    try {
      await reactivateConferenceDay(id);
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

      {days.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <>
          {/* Mobile: card-per-day list. Desktop (md+): table. Both trees
              render the same `days` data and must be kept in sync — any
              column added to one must be added to the other. */}
          <div className="flex flex-col gap-2 md:hidden">
            {days.map((day) => (
              <Card key={day.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-charcoal dark:text-gray-100">{day.conference_date}</p>
                  <Badge variant={day.is_active ? 'changed' : 'neutral'}>
                    {day.is_active ? t('active') : t('inactive')}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{day.label_en}</p>
                <p className="text-sm text-charcoal/70 dark:text-gray-400">{day.label_ar}</p>
                <p className="mt-1 text-xs text-charcoal/60 dark:text-gray-400">{t('displayOrder')}: {day.display_order}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => startEdit(day)}>{t('edit')}</Button>
                  {day.is_active ? (
                    <Button size="sm" variant="destructive" onClick={() => handleDeactivate(day.id)}>{t('deactivate')}</Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => handleReactivate(day.id)}>{t('reactivate')}</Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('date')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('nameAr')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('nameEn')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('displayOrder')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                {days.map((day) => (
                  <tr key={day.id}>
                    <td className="px-4 py-2 text-charcoal dark:text-gray-100">{day.conference_date}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{day.label_ar}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{day.label_en}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{day.display_order}</td>
                    <td className="px-4 py-2">
                      <Badge variant={day.is_active ? 'changed' : 'neutral'}>
                        {day.is_active ? t('active') : t('inactive')}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => startEdit(day)}>{t('edit')}</Button>
                        {day.is_active ? (
                          <Button size="sm" variant="destructive" onClick={() => handleDeactivate(day.id)}>{t('deactivate')}</Button>
                        ) : (
                          <Button size="sm" variant="secondary" onClick={() => handleReactivate(day.id)}>{t('reactivate')}</Button>
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
            {t('date')}
            <input
              type="date"
              value={form.conferenceDate}
              onChange={(e) => setForm({ ...form, conferenceDate: e.target.value })}
              required
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('nameAr')}
            <input
              value={form.labelAr}
              onChange={(e) => setForm({ ...form, labelAr: e.target.value })}
              required
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('nameEn')}
            <input
              value={form.labelEn}
              onChange={(e) => setForm({ ...form, labelEn: e.target.value })}
              required
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('displayOrder')}
            <input
              type="number"
              step={1}
              value={form.displayOrder}
              onChange={(e) => setForm({ ...form, displayOrder: e.target.value })}
              required
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
