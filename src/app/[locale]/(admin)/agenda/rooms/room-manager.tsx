'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { createRoom, updateRoom, deactivateRoom, reactivateRoom } from './actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

type Room = {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  capacity: number;
  location: string | null;
  floor: string | null;
  is_accessible: boolean;
  is_active: boolean;
};

type FormState = {
  code: string;
  nameAr: string;
  nameEn: string;
  capacity: string;
  location: string;
  floor: string;
  isAccessible: boolean;
};

const EMPTY_FORM: FormState = {
  code: '',
  nameAr: '',
  nameEn: '',
  capacity: '',
  location: '',
  floor: '',
  isAccessible: false,
};

function roomToForm(room: Room): FormState {
  return {
    code: room.code,
    nameAr: room.name_ar,
    nameEn: room.name_en,
    capacity: String(room.capacity),
    location: room.location ?? '',
    floor: room.floor ?? '',
    isAccessible: room.is_accessible,
  };
}

export default function RoomManager({ rooms }: { rooms: Room[] }) {
  const t = useTranslations('agenda.rooms');
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

  function startEdit(room: Room) {
    setError(null);
    setCreating(false);
    setEditingId(room.id);
    setForm(roomToForm(room));
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
      const capacity = Number(form.capacity);
      if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new Error(t('capacityError'));
      }
      const input = {
        code: form.code,
        nameAr: form.nameAr,
        nameEn: form.nameEn,
        capacity,
        location: form.location.trim() ? form.location : null,
        floor: form.floor.trim() ? form.floor : null,
        isAccessible: form.isAccessible,
      };
      if (editingId) {
        await updateRoom(editingId, input);
      } else {
        await createRoom(input);
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
      await deactivateRoom(id);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deactivateError'));
    }
  }

  async function handleReactivate(id: string) {
    setError(null);
    try {
      await reactivateRoom(id);
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

      {rooms.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <>
          {/* Mobile: card-per-room list. Desktop (md+): table. Both trees
              render the same `rooms` data and must be kept in sync — any
              column added to one must be added to the other. */}
          <div className="flex flex-col gap-2 md:hidden">
            {rooms.map((room) => (
              <Card key={room.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-charcoal dark:text-gray-100">{room.code}</p>
                  <Badge variant={room.is_active ? 'changed' : 'neutral'}>
                    {room.is_active ? t('active') : t('inactive')}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{room.name_en}</p>
                <p className="text-sm text-charcoal/70 dark:text-gray-400">{room.name_ar}</p>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-charcoal/60 dark:text-gray-400">
                  <span>{t('capacity')}: {room.capacity}</span>
                  <span>{t('location')}: {room.location ?? '—'}</span>
                  <span>{t('floor')}: {room.floor ?? '—'}</span>
                  <span>{t('accessible')}: {room.is_accessible ? t('yes') : t('no')}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => startEdit(room)}>{t('edit')}</Button>
                  {room.is_active ? (
                    <Button size="sm" variant="destructive" onClick={() => handleDeactivate(room.id)}>{t('deactivate')}</Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => handleReactivate(room.id)}>{t('reactivate')}</Button>
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
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('capacity')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('location')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('floor')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('accessible')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                {rooms.map((room) => (
                  <tr key={room.id}>
                    <td className="px-4 py-2 text-charcoal dark:text-gray-100">{room.code}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{room.name_ar}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{room.name_en}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{room.capacity}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{room.location ?? '—'}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{room.floor ?? '—'}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{room.is_accessible ? t('yes') : t('no')}</td>
                    <td className="px-4 py-2">
                      <Badge variant={room.is_active ? 'changed' : 'neutral'}>
                        {room.is_active ? t('active') : t('inactive')}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => startEdit(room)}>{t('edit')}</Button>
                        {room.is_active ? (
                          <Button size="sm" variant="destructive" onClick={() => handleDeactivate(room.id)}>{t('deactivate')}</Button>
                        ) : (
                          <Button size="sm" variant="secondary" onClick={() => handleReactivate(room.id)}>{t('reactivate')}</Button>
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
            {t('capacity')}
            <input
              type="number"
              min={1}
              step={1}
              value={form.capacity}
              onChange={(e) => setForm({ ...form, capacity: e.target.value })}
              required
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('location')}
            <input
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('floor')}
            <input
              value={form.floor}
              onChange={(e) => setForm({ ...form, floor: e.target.value })}
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-charcoal dark:text-gray-100">
            <input
              type="checkbox"
              checked={form.isAccessible}
              onChange={(e) => setForm({ ...form, isAccessible: e.target.checked })}
              className="h-4 w-4 rounded border-charcoal/30 text-turquoise focus:ring-turquoise dark:border-gray-600"
            />
            {t('accessible')}
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
