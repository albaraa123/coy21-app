// src/components/scanner/session-switcher.tsx
//
// Phase 9.1 — multi-session support for the scanner operator. The backend
// already fully supports a scanner_device account being assigned to
// multiple sessions at once (loadScannerAssignmentContext,
// scanner-assignment-management.ts's "approved multi-assignment policy"),
// and every actual scan submission independently re-verifies scope
// server-side (verifyScannerScope, called fresh on every
// scanQrAttemptConfirm call) — so switching which session this component
// currently targets can NEVER bypass authorization: the server would
// simply reject a scan against a session the device isn't assigned to,
// exactly as it already does today for the single-session case.
//
// This component is the only thing that changes: it owns "which session
// is currently selected" as local client state (deliberately NOT
// persisted — reset to the first ready session on every page load/reopen,
// per the explicit decision this matches: an operator's session choice
// applies to the current working session only, and a device may change
// hands between operators between conference sessions).
//
// ScannerClient itself is unchanged — it already takes sessionId as a
// plain prop and never derives session identity itself. Remounting it via
// `key={sessionId}` on switch is intentional: it resets ScannerClient's
// entire internal state machine and camera lifecycle cleanly (no
// in-flight scan/result state bleeds across a session switch), matching
// the same behavior a full page reload would have produced before this
// change.
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ScannerClient } from './scanner-client';
import { formatSessionTime } from './format-session-time';
import type { ScannerSessionContext } from '@/lib/attendance/scanner-assignment-context';

export function SessionSwitcher({ sessions, locale }: { sessions: ScannerSessionContext[]; locale: string }) {
  const t = useTranslations('scanner');
  // No persistence (localStorage/sessionStorage) by design — always
  // starts from the first ready session on mount, same as the prior
  // single-session behavior. See this file's own header comment for why.
  const [selectedSessionId, setSelectedSessionId] = useState(sessions[0].sessionId);

  const selected = sessions.find((s) => s.sessionId === selectedSessionId) ?? sessions[0];

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-charcoal/10 bg-white p-4 text-center shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <h1 className="text-base font-semibold text-charcoal dark:text-gray-100">
          {locale === 'ar' ? selected.titleAr : selected.titleEn}
        </h1>
        <dl className="mt-2 flex flex-col gap-1 text-sm text-charcoal/70 dark:text-gray-400">
          <div>
            <dt className="inline font-medium">{t('roomLabel')}: </dt>
            <dd className="inline">{locale === 'ar' ? selected.roomNameAr : selected.roomNameEn}</dd>
          </div>
          <div>
            <dt className="inline font-medium">{t('sessionTimeLabel')}: </dt>
            <dd className="inline">{formatSessionTime(selected, locale)}</dd>
          </div>
        </dl>
      </div>

      {sessions.length > 1 && (
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('sessionSwitcher.label')}
          <select
            value={selectedSessionId}
            onChange={(e) => setSelectedSessionId(e.target.value)}
            className="rounded-md border border-charcoal/20 bg-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {(locale === 'ar' ? s.titleAr : s.titleEn)} — {locale === 'ar' ? s.roomNameAr : s.roomNameEn} ({formatSessionTime(s, locale)})
              </option>
            ))}
          </select>
        </label>
      )}

      {/* key={selectedSessionId} forces a full remount of ScannerClient on
          switch — see this file's own header comment for why that's the
          correct behavior here, not an incidental side effect. */}
      <ScannerClient key={selected.sessionId} sessionId={selected.sessionId} />
    </div>
  );
}
