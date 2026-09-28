import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TimeMarker } from './time-marker';
import { StatusBanner } from './status-banner';
import type { AlternativeSession } from '@/lib/program-attendance/session-alternatives';

export type AdmissionPolicy = 'open' | 'priority_then_open' | 'restricted' | 'plenary' | 'cross_cutting';

export interface ScheduleItemForCard {
  id: string;
  sessionTitleAr: string | null;
  sessionTitleEn: string | null;
  roomNameAr: string | null;
  roomNameEn: string | null;
  startTime: string | null;
  endTime: string | null;
  isMandatory: boolean;
  // Live-read from sessions.admission_policy (see schedule/page.tsx) — null
  // for a gap item (no session_id) or, in principle, an unrecognized policy
  // value; the badge falls back to the legacy mandatory/elective label in
  // that case so a gap in the new data never leaves the card unlabeled.
  admissionPolicy: string | null;
  // The participant's own actual attendance state for this session, if
  // any — shown ALONGSIDE the recommended-session card, never replacing
  // it (see docs/superpowers/specs/2026-07-31-flexible-admission-qr-
  // attendance-design.md's Participant Experience & Dashboard section).
  attendance: { status: string; entryType: string; admittedAt: string } | null;
  // Phase 9.3 — suitable alternative sessions in the same time slot, read
  // only (see src/lib/program-attendance/session-alternatives.ts). Always
  // an empty array for a gap item or a non-active item — see
  // schedule/page.tsx's own fetch scoping.
  alternatives: AlternativeSession[];
  speakers: { fullNameAr: string; fullNameEn: string; role: string }[];
  itemStatus: 'active' | 'stale' | 'changed' | 'cancelled' | 'pending_review';
  gapReason: string | null;
}

const SEAT_STATUS_BADGE_VARIANT: Record<AlternativeSession['seatStatus'], 'mandatory' | 'elective' | 'pending' | 'neutral'> = {
  available: 'elective',
  almost_full: 'pending',
  full: 'mandatory',
};

const ADMISSION_POLICY_BADGE_VARIANT: Record<AdmissionPolicy, 'mandatory' | 'elective' | 'pending' | 'neutral'> = {
  plenary: 'mandatory',
  restricted: 'pending',
  priority_then_open: 'elective',
  open: 'elective',
  cross_cutting: 'elective',
};

function isKnownAdmissionPolicy(value: string | null): value is AdmissionPolicy {
  return value === 'open' || value === 'priority_then_open' || value === 'restricted' || value === 'plenary' || value === 'cross_cutting';
}

export async function SessionCard({ item, locale }: { item: ScheduleItemForCard; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'schedule.sessionCard' });
  const title = locale === 'ar' ? item.sessionTitleAr : item.sessionTitleEn;
  const roomName = locale === 'ar' ? item.roomNameAr : item.roomNameEn;
  const isGap = item.sessionTitleEn === null && item.gapReason !== null;

  // Plain-language admission-policy label replaces the legacy Mandatory/
  // Elective badge (spec: never say "assigned" or "mandatory" for a
  // recommended session). Falls back to the old isMandatory-derived label
  // only when admission_policy couldn't be resolved (gap item, or a
  // session whose id didn't come back from the live sessions lookup) —
  // never silently blank.
  const admissionPolicy = isKnownAdmissionPolicy(item.admissionPolicy) ? item.admissionPolicy : null;
  const policyLabelKey = admissionPolicy ? `admissionPolicy.${admissionPolicy}` : item.isMandatory ? 'admissionPolicy.fallbackMandatory' : 'admissionPolicy.fallbackElective';
  const policyBadgeVariant = admissionPolicy ? ADMISSION_POLICY_BADGE_VARIANT[admissionPolicy] : item.isMandatory ? 'mandatory' : 'elective';

  return (
    <Card className="flex flex-col gap-2">
      {item.startTime && item.endTime && <TimeMarker startTime={item.startTime} endTime={item.endTime} locale={locale} />}
      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {isGap ? t('noMandatorySession') : title}
        </h3>
        {!isGap && <Badge variant={policyBadgeVariant}>{t(policyLabelKey)}</Badge>}
      </div>
      {roomName && <p className="text-sm text-gray-600 dark:text-gray-400">{roomName}</p>}
      {item.speakers.length > 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {item.speakers.map((s) => (locale === 'ar' ? s.fullNameAr : s.fullNameEn)).join(', ')}
        </p>
      )}
      {item.attendance?.status === 'admitted' && (
        <p role="status" className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
          {t('attendanceConfirmed')}
        </p>
      )}
      {item.itemStatus !== 'active' && <StatusBanner status={item.itemStatus as 'stale' | 'changed' | 'cancelled' | 'pending_review'} locale={locale} />}

      {/* Secondary, clearly-labeled list under the recommended session —
          never equal-weight competing options, per the design spec's
          Participant Experience section. Read-only: no action/link takes
          the participant anywhere from here; this is informational only. */}
      {item.alternatives.length > 0 && (
        <div className="mt-2 border-t border-gray-200 pt-2 dark:border-gray-700">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('alternatives.heading')}</h4>
          <ul className="mt-2 flex flex-col gap-2">
            {item.alternatives.map((alt) => {
              const altTitle = locale === 'ar' ? alt.titleAr : alt.titleEn;
              const altRoom = locale === 'ar' ? alt.roomNameAr : alt.roomNameEn;
              return (
                <li key={alt.sessionId} className="rounded-md border border-gray-200 p-2 dark:border-gray-700">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{altTitle}</p>
                    <Badge variant={SEAT_STATUS_BADGE_VARIANT[alt.seatStatus]}>{t(`alternatives.seatStatus.${alt.seatStatus}`)}</Badge>
                  </div>
                  {altRoom && <p className="text-xs text-gray-600 dark:text-gray-400">{altRoom}</p>}
                  <TimeMarker startTime={alt.startTime} endTime={alt.endTime} locale={locale} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}
