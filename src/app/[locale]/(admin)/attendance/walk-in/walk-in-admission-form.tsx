'use client';

// src/app/[locale]/(admin)/attendance/walk-in/walk-in-admission-form.tsx
//
// Task 7 — the standalone walk-in admission form: a session <select>, a
// text input for the applicant's application number or name (resolved
// to an application_id server-side by the /api/admit-walk-in Route
// Handler), and an Admit button. Deliberately no autocomplete/search-
// as-you-type UI per the design spec's "minimal standalone admin page"
// framing (scope decision 13) — admission-management-console.tsx's
// two-step search-then-select flow is the richer precedent this page
// intentionally does not replicate. Error/success presentation mirrors
// that console's own established pattern: a role="alert"/role="status"
// banner showing the action's error or success text verbatim.
//
// Sub-project 5b (offline scanning support) — Task 5: the former Server
// Action (admitWalkIn in actions.ts, now deleted) is replaced by a
// fetch()-based call to /api/admit-walk-in, since Next.js serializes
// Server Actions dispatched from the same client, which would otherwise
// make a retry queue behind a hung original request (same platform
// constraint as the scanner, see use-scan-retry.ts's header comment).
//
// This page has no camera/single-flight concerns the scanner's full
// reducer exists to solve, so its retry loop is simple local component
// state (`retrying: boolean`) plus refs for idempotencyKey/startedAt/the
// stale-response guard, per the design spec's "Architecture — Client
// Side (Walk-In Admin Page)" section — no reducer needed. The pure
// nextBackoffDelayMs/isStaleAttempt functions are imported directly from
// the scanner's use-scan-retry.ts rather than re-derived, so the two
// retry loops' backoff/staleness semantics can never silently drift
// apart.
import { useCallback, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { nextBackoffDelayMs, isStaleAttempt } from '@/components/scanner/use-scan-retry';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type Session = { id: string; title_ar: string; title_en: string; status: string; start_time: string; end_time: string };

type AdmitWalkInOutcome = { ok: true; bookingId: string } | { ok: false; retryable: boolean; message: string };

const SUBMIT_TIMEOUT_MS = 8000;
const HEALTH_CHECK_TIMEOUT_MS = 5000;
const RETRY_MESSAGE_THRESHOLD_MS = 30_000;

export default function WalkInAdmissionForm({ sessions }: { sessions: Session[] }) {
  const t = useTranslations('walkInAdmission');
  const locale = useLocale();

  const [sessionId, setSessionId] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [showPersistentRetryMessage, setShowPersistentRetryMessage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Guard + timers, not reducer state — this page has no camera/
  // single-flight concerns requiring the scanner's full reducer. Mirrors
  // use-scan-retry.ts's own `guard` object: a late response for a
  // superseded attempt (cancelled, or superseded by a newer retry) is
  // discarded via isStaleAttempt even though it may share the same
  // idempotencyKey as the current attempt.
  const guardRef = useRef({ idempotencyKey: '', attemptSeq: -1 });
  const startedAtRef = useRef(0);
  const backoffMsRef = useRef(2000);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistentMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const healthCheckControllerRef = useRef<AbortController | null>(null);
  const currentSessionIdRef = useRef('');
  const currentApplicationLookupRef = useRef({ identifier: '', sessionId: '' });

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const clearPersistentMessageTimer = useCallback(() => {
    if (persistentMessageTimerRef.current) {
      clearTimeout(persistentMessageTimerRef.current);
      persistentMessageTimerRef.current = null;
    }
  }, []);

  const submitAttempt = useCallback(
    (identifierValue: string, sessionIdValue: string, idempotencyKey: string, attemptSeq: number) => {
      guardRef.current = { idempotencyKey, attemptSeq };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

      fetch('/api/admit-walk-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: identifierValue, sessionId: sessionIdValue, idempotencyKey }),
        signal: controller.signal,
      })
        .then(async (res) => {
          clearTimeout(timeout);
          if (isStaleAttempt(guardRef.current.idempotencyKey, guardRef.current.attemptSeq, idempotencyKey, attemptSeq)) return;
          if (!res.ok) {
            enterRetrying(identifierValue, sessionIdValue, idempotencyKey);
            return;
          }
          const outcome: AdmitWalkInOutcome | null = await res.json().catch(() => null);
          // A second real suspension point (await res.json()) -- repeat
          // the staleness check immediately before any state update that
          // uses `outcome`, same reasoning as use-scan-retry.ts's own
          // submit().
          if (isStaleAttempt(guardRef.current.idempotencyKey, guardRef.current.attemptSeq, idempotencyKey, attemptSeq)) return;
          if (!outcome) {
            enterRetrying(identifierValue, sessionIdValue, idempotencyKey);
            return;
          }
          if (outcome.ok) {
            finishRetrying();
            setSubmitting(false);
            setSuccess(t('admitSuccess'));
            setIdentifier('');
          } else if (outcome.retryable) {
            enterRetrying(identifierValue, sessionIdValue, idempotencyKey);
          } else {
            finishRetrying();
            setSubmitting(false);
            setError(outcome.message);
          }
        })
        .catch(() => {
          clearTimeout(timeout);
          if (isStaleAttempt(guardRef.current.idempotencyKey, guardRef.current.attemptSeq, idempotencyKey, attemptSeq)) return;
          enterRetrying(identifierValue, sessionIdValue, idempotencyKey);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // On a transport-shaped failure: enter 'retrying', start the
  // health-check poll at a 2s interval doubling up to a 10s ceiling, and
  // show the persistent "Try Now"/"Cancel" message after 30 continuous
  // seconds. Mirrors the scanner's client retry loop (use-scan-retry.ts
  // + scanner-client.tsx) but as plain local state, not a reducer.
  function enterRetrying(identifierValue: string, sessionIdValue: string, idempotencyKey: string) {
    setRetrying((already) => {
      if (!already) {
        startedAtRef.current = Date.now();
        backoffMsRef.current = 2000;
        persistentMessageTimerRef.current = setTimeout(() => setShowPersistentRetryMessage(true), RETRY_MESSAGE_THRESHOLD_MS);
      }
      return true;
    });
    pollHealthThenRetry(identifierValue, sessionIdValue, idempotencyKey);
  }

  function finishRetrying() {
    clearPollTimer();
    clearPersistentMessageTimer();
    if (healthCheckControllerRef.current) {
      healthCheckControllerRef.current.abort();
      healthCheckControllerRef.current = null;
    }
    setRetrying(false);
    setShowPersistentRetryMessage(false);
    backoffMsRef.current = 2000;
  }

  function pollHealthThenRetry(identifierValue: string, sessionIdValue: string, idempotencyKey: string) {
    const controller = new AbortController();
    healthCheckControllerRef.current = controller;
    const attemptSeqAtPollTime = guardRef.current.attemptSeq;
    const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    fetch('/api/admission-staff-health', { signal: controller.signal, cache: 'no-store' })
      .then((res) => {
        clearTimeout(timeout);
        if (healthCheckControllerRef.current === controller) healthCheckControllerRef.current = null;
        if (isStaleAttempt(guardRef.current.idempotencyKey, guardRef.current.attemptSeq, idempotencyKey, attemptSeqAtPollTime)) return;
        if (res.status === 200) {
          backoffMsRef.current = 2000;
          const nextSeq = guardRef.current.attemptSeq + 1;
          submitAttempt(identifierValue, sessionIdValue, idempotencyKey, nextSeq);
        } else if (res.status === 401) {
          finishRetrying();
          setSubmitting(false);
          setError(t('reauthenticateError'));
        } else {
          backoffMsRef.current = nextBackoffDelayMs(backoffMsRef.current);
          pollTimerRef.current = setTimeout(
            () => pollHealthThenRetry(identifierValue, sessionIdValue, idempotencyKey),
            backoffMsRef.current
          );
        }
      })
      .catch(() => {
        clearTimeout(timeout);
        if (healthCheckControllerRef.current === controller) healthCheckControllerRef.current = null;
        if (isStaleAttempt(guardRef.current.idempotencyKey, guardRef.current.attemptSeq, idempotencyKey, attemptSeqAtPollTime)) return;
        backoffMsRef.current = nextBackoffDelayMs(backoffMsRef.current);
        pollTimerRef.current = setTimeout(
          () => pollHealthThenRetry(identifierValue, sessionIdValue, idempotencyKey),
          backoffMsRef.current
        );
      });
  }

  const handleTryNow = useCallback(() => {
    if (!retrying) return;
    const { identifier: identifierValue, sessionId: sessionIdValue } = currentApplicationLookupRef.current;
    pollHealthThenRetry(identifierValue, sessionIdValue, guardRef.current.idempotencyKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retrying]);

  const handleCancelRetry = useCallback(() => {
    guardRef.current = { idempotencyKey: guardRef.current.idempotencyKey, attemptSeq: -999 };
    finishRetrying();
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!sessionId) {
      setError(t('sessionRequiredError'));
      return;
    }
    if (identifier.trim() === '') {
      setError(t('identifierRequiredError'));
      return;
    }

    currentSessionIdRef.current = sessionId;
    currentApplicationLookupRef.current = { identifier, sessionId };
    setSubmitting(true);
    const idempotencyKey = crypto.randomUUID();
    submitAttempt(identifier, sessionId, idempotencyKey, 0);
  }

  const fieldsDisabled = submitting || retrying;

  return (
    <Card className="flex max-w-xl flex-col gap-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('session')}
          <select
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            required
            disabled={fieldsDisabled}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('selectSession')}</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {locale === 'ar' ? s.title_ar : s.title_en}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('identifierLabel')}
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={t('identifierPlaceholder')}
            disabled={fieldsDisabled}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>

        {error && (
          <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        {success && (
          <p role="status" className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-400 dark:bg-emerald-950/40 dark:text-emerald-300">
            {success}
          </p>
        )}

        {retrying && (
          <div className="flex flex-col gap-2 rounded-md border border-amber-600 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-400 dark:bg-amber-950/40 dark:text-amber-300">
            <p role="status" aria-live="polite">
              {t('retrying.message')}
            </p>
            {showPersistentRetryMessage && <p className="text-xs">{t('retrying.persistentMessage')}</p>}
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={handleTryNow}>
                {t('retrying.tryNow')}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={handleCancelRetry}>
                {t('retrying.cancel')}
              </Button>
            </div>
          </div>
        )}

        <div>
          <Button type="submit" disabled={fieldsDisabled}>
            {t('admitAction')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
