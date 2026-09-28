'use client';

/**
 * Final typed-confirmation gate for schedule publication (Task 15).
 *
 * This is a deliberate, separately-scoped safety feature layered ON TOP of
 * the pre-existing `canConfirm` gate in draft-review.tsx (blocker
 * resolution + low-confidence acknowledgment), not a replacement for it.
 * See draft-review.tsx's own comment above the red warning Card for why
 * publication is genuinely irreversible
 * (confirm_publication_transactional only ever moves a publication
 * active -> superseded; there is no unpublish path).
 *
 * This component does NOT call Supabase, does NOT call the
 * confirm_publication_transactional RPC, and does NOT duplicate any
 * publication logic — it only renders the confirmation UI and, once every
 * gate passes, invokes the `onConfirm` callback it's given, which
 * draft-review.tsx wires to its existing, unchanged `handleConfirm` (which
 * itself calls the existing, unchanged `confirmDraftPublication` server
 * action). The dialog owns none of that logic.
 *
 * Accessibility: modeled directly on
 * src/components/shell/mobile-drawer.tsx's established pattern for this
 * codebase (role="dialog", aria-modal, manual focus trap via Tab/Shift+Tab,
 * Escape-to-close, focus returns to the trigger button on close, body
 * scroll lock while open). The focus-trap/Escape pure-logic functions are
 * imported directly from mobile-drawer-logic.ts rather than reimplemented,
 * since the trap-computation and Escape-detection logic is generic (takes
 * plain focusable-element arrays / key strings, has no drawer-specific
 * assumptions).
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { computeFocusTrapTarget, isEscapeKey } from '@/components/shell/mobile-drawer-logic';
import { canSubmitConfirmation, createReentrancyGuard, isConfirmationTextValid, runGuardedOnce } from './publish-confirmation-logic';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector));
}

export interface PublishConfirmationDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  triggerRef: React.RefObject<HTMLElement | null>;
  /** Mirrors draft-review.tsx's `canConfirm` (blockers resolved + low-confidence ack) — the pre-existing gate, unchanged. */
  canConfirm: boolean;
  /** True while draft-review.tsx's handleConfirm is in flight (its `confirming` state) — used to disable/close-guard this dialog too. */
  submitting: boolean;
  affectedParticipantCount: number;
  draftReference: string;
}

export function PublishConfirmationDialog(props: PublishConfirmationDialogProps) {
  // Renders nothing at all (not even hooks/state) while closed, so that
  // the very act of opening the dialog is a fresh mount — this is the
  // React-recommended way to reset all of a subtree's local state on
  // reopen (https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes,
  // "unconditionally return null when the condition is false"), and it
  // avoids ever calling setState synchronously inside a useEffect body
  // (flagged by this repo's react-hooks/set-state-in-effect lint rule) to
  // clear a previously-typed confirmation phrase. Splitting into this
  // outer wrapper + an inner `OpenPublishConfirmationDialog` (only
  // instantiated while open) is what makes that unconditional-mount
  // guarantee possible while keeping every hook below it unconditional,
  // as the Rules of Hooks require.
  if (!props.open) return null;
  return <OpenPublishConfirmationDialog {...props} />;
}

function OpenPublishConfirmationDialog({
  onClose,
  onConfirm,
  triggerRef,
  canConfirm,
  submitting,
  affectedParticipantCount,
  draftReference,
}: PublishConfirmationDialogProps) {
  const t = useTranslations('allocation.schedulePublication.review.confirm.dialog');
  const requiredPhrase = t('requiredPhrase');
  // Always starts empty on mount — this component only exists while the
  // dialog is open (see PublishConfirmationDialog above), so there is no
  // stale value to reset: every open is a fresh mount.
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Synchronous re-entrancy guard, independent of React's render cycle —
  // see handleConfirmClick below for why this can't be replaced by the
  // `submitting` prop alone. Held in a ref so the guard object's identity
  // (and its mutable `.current`) survives re-renders without itself
  // triggering one; `createReentrancyGuard`/`runGuardedOnce` live in
  // publish-confirmation-logic.ts so the actual race-closing behavior is
  // unit-testable independent of React.
  const submitGuardRef = useRef(createReentrancyGuard());

  // Body scroll lock for as long as this component is mounted (i.e. while
  // open), cleaned up on unmount (i.e. on close).
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Escape-to-close (only when not submitting, so an in-flight publish
  // can't be dismissed out from under itself) + manual focus trap +
  // initial focus into the dialog on mount.
  useEffect(() => {
    const focusTarget = inputRef.current ?? panelRef.current;
    focusTarget?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (isEscapeKey(event.key)) {
        if (submitting) return;
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'Tab' && panelRef.current) {
        const focusable = getFocusableElements(panelRef.current);
        const target = computeFocusTrapTarget(focusable, document.activeElement, event.shiftKey);
        if (target) {
          event.preventDefault();
          (target as HTMLElement).focus();
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, submitting]);

  // Focus returns to the trigger button on unmount (i.e. on close), for
  // every close path (Cancel, Escape, backdrop click, or a successful
  // confirm that closes the dialog from draft-review.tsx).
  useEffect(() => {
    const trigger = triggerRef.current;
    return () => {
      trigger?.focus();
    };
  }, [triggerRef]);

  const canSubmit = canSubmitConfirmation({ canConfirm, typedConfirmation, requiredPhrase, submitting });

  function handleCancel() {
    if (submitting) return;
    onClose();
  }

  // `submitting` is a PROP driven by draft-review.tsx's setConfirming(true)
  // — that state update doesn't commit a re-rendered `disabled` attribute
  // to the real DOM until React's next render, so a fast double-click on
  // the Confirm button can invoke this handler twice before the button
  // ever appears disabled on screen. runGuardedOnce/submitGuardRef check
  // and set a plain mutable flag synchronously (no render involved), so
  // the SECOND overlapping call is a no-op regardless of render timing —
  // see publish-confirmation-logic.ts for the guard itself and its direct
  // unit tests.
  async function handleConfirmClick() {
    if (!canSubmit) return;
    await runGuardedOnce(submitGuardRef.current, onConfirm);
  }

  // Inline match/mismatch feedback on the typed-confirmation input: only
  // shown once the admin has typed something (an empty field isn't a
  // "mismatch" yet, just unstarted), so the disabled Confirm button isn't
  // the only signal explaining why it's disabled.
  const hasTyped = typedConfirmation.length > 0;
  const isMatch = isConfirmationTextValid(typedConfirmation, requiredPhrase);
  const inputStateClasses = !hasTyped
    ? 'border-charcoal/30 dark:border-gray-600'
    : isMatch
      ? 'border-green-700 dark:border-green-400'
      : 'border-red-700 dark:border-red-400';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-charcoal/70" aria-hidden="true" onClick={handleCancel} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-confirmation-title"
        aria-describedby="publish-confirmation-warning"
        tabIndex={-1}
        className="relative w-full max-w-lg outline-none"
      >
        <Card className="border-4 border-red-700 bg-red-50 shadow-2xl ring-4 ring-red-700/20 dark:border-red-400 dark:bg-red-950/60 dark:ring-red-400/20">
          <div className="flex items-start gap-3">
            <svg
              viewBox="0 0 24 24"
              className="mt-0.5 h-7 w-7 flex-shrink-0 text-red-700 dark:text-red-300"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
            <h2 id="publish-confirmation-title" className="text-lg font-extrabold uppercase tracking-wide text-red-700 dark:text-red-300">
              {t('title')}
            </h2>
          </div>
          <p id="publish-confirmation-warning" className="mt-2 text-sm text-red-700/90 dark:text-red-300/90">
            {t('irreversibleWarning')}
          </p>

          <dl className="mt-4 grid grid-cols-1 gap-2 rounded-md border border-red-700/30 bg-warm-white/60 p-3 text-sm dark:border-red-400/30 dark:bg-gray-900/60">
            <div className="flex justify-between gap-2">
              <dt className="text-charcoal/70 dark:text-gray-400">{t('affectedParticipants')}</dt>
              <dd className="font-medium text-charcoal dark:text-gray-100">{affectedParticipantCount}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-charcoal/70 dark:text-gray-400">{t('draftReference')}</dt>
              <dd className="font-medium text-charcoal dark:text-gray-100">{draftReference}</dd>
            </div>
          </dl>

          <p className="mt-3 text-sm text-red-700/90 dark:text-red-300/90">{t('supersedeWarning')}</p>
          <p className="mt-1 text-sm font-semibold text-red-700 dark:text-red-300">{t('noUndo')}</p>

          <label htmlFor="publish-confirmation-input" className="mt-4 block text-sm font-medium text-charcoal dark:text-gray-100">
            {t('typePrompt', { phrase: requiredPhrase })}
          </label>
          <input
            ref={inputRef}
            id="publish-confirmation-input"
            type="text"
            value={typedConfirmation}
            onChange={(e) => setTypedConfirmation(e.target.value)}
            disabled={submitting}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={hasTyped && !isMatch}
            className={`mt-1 w-full rounded-md border-2 bg-warm-white px-3 py-2 text-sm text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:bg-gray-900 dark:text-gray-100 ${inputStateClasses}`}
          />
          {hasTyped && (
            <p
              role="status"
              className={`mt-1 text-xs font-medium ${isMatch ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}
            >
              {isMatch ? t('matchConfirmed') : t('matchPending')}
            </p>
          )}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={handleCancel} disabled={submitting}>
              {t('cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={handleConfirmClick} disabled={!canSubmit}>
              {submitting ? t('submitting') : t('confirm')}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
