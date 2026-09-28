/**
 * Pure logic for the publish-confirmation dialog's typed-confirmation gate
 * (Task 15). Extracted from the dialog component so the comparison/gating
 * rules can be unit-tested directly, without needing jsdom or simulated
 * `<input>` typing — this repo has no jsdom (vitest.config.ts is
 * `environment: 'node'`) and `renderToStaticMarkup` cannot execute effects
 * or real input events, so anything involving actual user interaction is
 * extracted to plain functions here, following the same split already
 * established for MobileDrawer (see mobile-drawer-logic.ts's doc comment)
 * and reused across Tasks 5, 6, 10, 12.
 *
 * Whitespace handling: the typed value is trimmed of leading/trailing
 * whitespace before comparison, but the comparison itself is exact and
 * case-sensitive (no case-folding, no internal whitespace collapsing).
 * Rationale: a trailing space or newline is a plausible copy-paste/mobile-
 * keyboard artifact that carries no meaning and shouldn't block a
 * correctly-typed confirmation; but silently accepting "publish" for
 * "PUBLISH", or accepting a fuzzy/partial match, would defeat the point of
 * a typed confirmation gate for a genuinely irreversible action — the
 * whole value of requiring an exact phrase is that it forces deliberate,
 * attentive input, not passive button-mashing.
 */

export type ConfirmationLocale = 'en' | 'ar';

/** The phrase the admin must type, per locale. Sourced as data from i18n messages by the caller — never hardcoded at a call site. */
export function isConfirmationTextValid(typed: string, requiredPhrase: string): boolean {
  return typed.trim() === requiredPhrase;
}

/**
 * All conditions that must hold before the dialog's own final confirm
 * button may be enabled. Mirrors (does not replace) draft-review.tsx's
 * pre-existing `canConfirm` gate (blockers resolved + low-confidence
 * acknowledgment) — this function ANDs that gate with the two new
 * dialog-level conditions (exact typed match, not already submitting).
 */
export function canSubmitConfirmation(input: {
  canConfirm: boolean;
  typedConfirmation: string;
  requiredPhrase: string;
  submitting: boolean;
}): boolean {
  if (input.submitting) return false;
  if (!input.canConfirm) return false;
  return isConfirmationTextValid(input.typedConfirmation, input.requiredPhrase);
}

/**
 * A minimal mutable-boolean re-entrancy lock, structurally identical to
 * what the dialog component holds in a `useRef<boolean>`. Extracted here
 * (rather than only living inline as a ref in the component) so the
 * actual double-invocation race this guards against — two overlapping
 * calls to an async action, back to back, before the first has settled —
 * can be exercised with a REAL async double-call in a unit test, not just
 * asserted indirectly via `canSubmitConfirmation({ submitting: true })`.
 * That pure-boolean check alone cannot prove anything about a race,
 * because `submitting` is a React prop that only updates on next render —
 * this lock is checked-and-set synchronously, with no render in between,
 * which is what actually closes the window a fast double-click opens.
 */
export interface ReentrancyGuard {
  current: boolean;
}

export function createReentrancyGuard(): ReentrancyGuard {
  return { current: false };
}

/**
 * Runs `action` only if `guard.current` is not already true; while running,
 * `guard.current` is held true and any overlapping call is a silent no-op.
 * Always releases the guard afterward (success or throw), so a later,
 * genuinely new invocation is still allowed once this one settles.
 */
export async function runGuardedOnce(guard: ReentrancyGuard, action: () => Promise<void> | void): Promise<void> {
  if (guard.current) return;
  guard.current = true;
  try {
    await action();
  } finally {
    guard.current = false;
  }
}
