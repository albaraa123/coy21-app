'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { updateSession } from './actions';
import { SESSION_LANGUAGES, SESSION_DIFFICULTIES } from '@/lib/validation/agenda';
import type { Database } from '@/types/database';
import { Button } from '@/components/ui/button';
import { isoToConferenceLocalInputValue, conferenceLocalInputValueToIso } from '@/lib/datetime/conference-time';

type Session = Database['public']['Tables']['sessions']['Row'];

type RefOption = { id: string; [key: string]: unknown };

type FormState = {
  sessionCode: string;
  titleAr: string;
  titleEn: string;
  descriptionAr: string;
  descriptionEn: string;
  conferenceDayId: string;
  startTime: string; // datetime-local value, conference (Europe/Istanbul) wall-clock
  endTime: string; // datetime-local value, conference (Europe/Istanbul) wall-clock
  trackId: string;
  sessionTypeId: string;
  roomId: string;
  language: string;
  difficultyLevel: string;
  capacity: string;
  minCapacity: string;
  isMandatory: boolean;
  isPublic: boolean;
  includeInAllocation: boolean;
  allocationPriority: string;
  enableQrCheckin: boolean;
  checkinOpensAt: string; // datetime-local value, conference (Europe/Istanbul) wall-clock, may be ''
  checkinClosesAt: string; // datetime-local value, conference (Europe/Istanbul) wall-clock, may be ''
  internalNotes: string;
};

function sessionToFormState(session: Session): FormState {
  return {
    sessionCode: session.session_code,
    titleAr: session.title_ar,
    titleEn: session.title_en,
    descriptionAr: session.description_ar ?? '',
    descriptionEn: session.description_en ?? '',
    conferenceDayId: session.conference_day_id,
    startTime: isoToConferenceLocalInputValue(session.start_time),
    endTime: isoToConferenceLocalInputValue(session.end_time),
    trackId: session.track_id,
    sessionTypeId: session.session_type_id,
    roomId: session.room_id,
    language: session.language,
    difficultyLevel: session.difficulty_level,
    capacity: String(session.capacity),
    minCapacity: String(session.min_capacity),
    isMandatory: session.is_mandatory,
    isPublic: session.is_public,
    includeInAllocation: session.include_in_allocation,
    allocationPriority: String(session.allocation_priority),
    enableQrCheckin: session.enable_qr_checkin,
    checkinOpensAt: session.checkin_opens_at ? isoToConferenceLocalInputValue(session.checkin_opens_at) : '',
    checkinClosesAt: session.checkin_closes_at ? isoToConferenceLocalInputValue(session.checkin_closes_at) : '',
    internalNotes: session.internal_notes ?? '',
  };
}

const FIELD_CLASS =
  'rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';
const LABEL_CLASS = 'flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100';
const CHECKBOX_LABEL_CLASS = 'flex items-center gap-2 text-sm text-charcoal dark:text-gray-100';
const CHECKBOX_CLASS = 'h-4 w-4 rounded border-charcoal/30 text-turquoise focus:ring-turquoise dark:border-gray-600';

export default function SessionEditForm({
  session,
  days,
  tracks,
  sessionTypes,
  rooms,
  currentlyBooked,
}: {
  session: Session;
  days: RefOption[];
  tracks: RefOption[];
  sessionTypes: RefOption[];
  rooms: RefOption[];
  currentlyBooked: number;
}) {
  const t = useTranslations('agenda.sessions.detail.edit');
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => sessionToFormState(session));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmitEdit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await updateSession(session.id, {
        sessionCode: form.sessionCode,
        titleAr: form.titleAr,
        titleEn: form.titleEn,
        descriptionAr: form.descriptionAr || null,
        descriptionEn: form.descriptionEn || null,
        conferenceDayId: form.conferenceDayId,
        startTime: conferenceLocalInputValueToIso(form.startTime),
        endTime: conferenceLocalInputValueToIso(form.endTime),
        trackId: form.trackId,
        sessionTypeId: form.sessionTypeId,
        roomId: form.roomId,
        language: form.language as 'ar' | 'en' | 'bilingual',
        difficultyLevel: form.difficultyLevel as 'beginner' | 'intermediate' | 'advanced' | 'all_levels',
        capacity: Number(form.capacity),
        minCapacity: Number(form.minCapacity),
        isMandatory: form.isMandatory,
        isPublic: form.isPublic,
        includeInAllocation: form.includeInAllocation,
        allocationPriority: Number(form.allocationPriority),
        enableQrCheckin: form.enableQrCheckin,
        checkinOpensAt: form.checkinOpensAt ? conferenceLocalInputValueToIso(form.checkinOpensAt) : null,
        checkinClosesAt: form.checkinClosesAt ? conferenceLocalInputValueToIso(form.checkinClosesAt) : null,
        internalNotes: form.internalNotes || null,
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('title')}</h2>
      <form onSubmit={handleSubmitEdit} className="flex flex-col gap-3 rounded-lg border border-charcoal/10 bg-warm-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <label className={LABEL_CLASS}>
          {t('sessionCode')}
          <input type="text" value={form.sessionCode} onChange={(e) => updateField('sessionCode', e.target.value)} required className={FIELD_CLASS} />
        </label>
        <label className={LABEL_CLASS}>
          {t('titleAr')}
          <input type="text" value={form.titleAr} onChange={(e) => updateField('titleAr', e.target.value)} required className={FIELD_CLASS} />
        </label>
        <label className={LABEL_CLASS}>
          {t('titleEn')}
          <input type="text" value={form.titleEn} onChange={(e) => updateField('titleEn', e.target.value)} required className={FIELD_CLASS} />
        </label>
        <label className={LABEL_CLASS}>
          {t('descriptionAr')}
          <textarea value={form.descriptionAr} onChange={(e) => updateField('descriptionAr', e.target.value)} className={FIELD_CLASS} />
        </label>
        <label className={LABEL_CLASS}>
          {t('descriptionEn')}
          <textarea value={form.descriptionEn} onChange={(e) => updateField('descriptionEn', e.target.value)} className={FIELD_CLASS} />
        </label>
        <label className={LABEL_CLASS}>
          {t('day')}
          <select value={form.conferenceDayId} onChange={(e) => updateField('conferenceDayId', e.target.value)} required className={FIELD_CLASS}>
            {days.map((d) => (
              <option key={d.id} value={d.id}>{String(d.label_en)}</option>
            ))}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          {t('startTime')}
          <input type="datetime-local" value={form.startTime} onChange={(e) => updateField('startTime', e.target.value)} required className={FIELD_CLASS} />
        </label>
        <label className={LABEL_CLASS}>
          {t('endTime')}
          <input type="datetime-local" value={form.endTime} onChange={(e) => updateField('endTime', e.target.value)} required className={FIELD_CLASS} />
        </label>
        <label className={LABEL_CLASS}>
          {t('track')}
          <select value={form.trackId} onChange={(e) => updateField('trackId', e.target.value)} required className={FIELD_CLASS}>
            {tracks.map((tr) => (
              <option key={tr.id} value={tr.id}>{String(tr.name_en)}</option>
            ))}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          {t('sessionType')}
          <select value={form.sessionTypeId} onChange={(e) => updateField('sessionTypeId', e.target.value)} required className={FIELD_CLASS}>
            {sessionTypes.map((st) => (
              <option key={st.id} value={st.id}>{String(st.name_en)}</option>
            ))}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          {t('room')}
          <select value={form.roomId} onChange={(e) => updateField('roomId', e.target.value)} required className={FIELD_CLASS}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>{String(r.name_en)}</option>
            ))}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          {t('language')}
          <select value={form.language} onChange={(e) => updateField('language', e.target.value)} className={FIELD_CLASS}>
            {SESSION_LANGUAGES.map((l) => (
              <option key={l} value={l}>{t(`languageValues.${l}`)}</option>
            ))}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          {t('difficultyLevel')}
          <select value={form.difficultyLevel} onChange={(e) => updateField('difficultyLevel', e.target.value)} className={FIELD_CLASS}>
            {SESSION_DIFFICULTIES.map((d) => (
              <option key={d} value={d}>{t(`difficultyValues.${d}`)}</option>
            ))}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          {t('capacity')}
          <input type="number" min="1" value={form.capacity} onChange={(e) => updateField('capacity', e.target.value)} required className={FIELD_CLASS} />
        </label>
        <p className="text-xs text-charcoal/60 dark:text-gray-400">
          {t('currentlyBooked', { count: currentlyBooked, capacity: form.capacity })}
        </p>
        <label className={LABEL_CLASS}>
          {t('minCapacity')}
          <input type="number" min="0" value={form.minCapacity} onChange={(e) => updateField('minCapacity', e.target.value)} required className={FIELD_CLASS} />
        </label>
        <label className={CHECKBOX_LABEL_CLASS}>
          <input type="checkbox" checked={form.isMandatory} onChange={(e) => updateField('isMandatory', e.target.checked)} className={CHECKBOX_CLASS} />
          {t('isMandatory')}
        </label>
        <label className={CHECKBOX_LABEL_CLASS}>
          <input type="checkbox" checked={form.isPublic} onChange={(e) => updateField('isPublic', e.target.checked)} className={CHECKBOX_CLASS} />
          {t('isPublic')}
        </label>
        <label className={CHECKBOX_LABEL_CLASS}>
          <input type="checkbox" checked={form.includeInAllocation} onChange={(e) => updateField('includeInAllocation', e.target.checked)} className={CHECKBOX_CLASS} />
          {t('includeInAllocation')}
        </label>
        <label className={LABEL_CLASS}>
          {t('allocationPriority')}
          <input type="number" value={form.allocationPriority} onChange={(e) => updateField('allocationPriority', e.target.value)} required className={FIELD_CLASS} />
        </label>
        <label className={CHECKBOX_LABEL_CLASS}>
          <input type="checkbox" checked={form.enableQrCheckin} onChange={(e) => updateField('enableQrCheckin', e.target.checked)} className={CHECKBOX_CLASS} />
          {t('enableQrCheckin')}
        </label>
        <label className={LABEL_CLASS}>
          {t('checkinOpensAt')}
          <input type="datetime-local" value={form.checkinOpensAt} onChange={(e) => updateField('checkinOpensAt', e.target.value)} className={FIELD_CLASS} />
        </label>
        <label className={LABEL_CLASS}>
          {t('checkinClosesAt')}
          <input type="datetime-local" value={form.checkinClosesAt} onChange={(e) => updateField('checkinClosesAt', e.target.value)} className={FIELD_CLASS} />
        </label>
        <label className={LABEL_CLASS}>
          {t('internalNotes')}
          <textarea value={form.internalNotes} onChange={(e) => updateField('internalNotes', e.target.value)} className={FIELD_CLASS} />
        </label>
        <div className="mt-2">
          <Button type="submit" disabled={submitting}>{t('save')}</Button>
        </div>
      </form>
    </div>
  );
}
