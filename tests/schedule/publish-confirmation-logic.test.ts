import { describe, expect, it, vi } from 'vitest';
import {
  canSubmitConfirmation,
  createReentrancyGuard,
  isConfirmationTextValid,
  runGuardedOnce,
} from '@/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/publish-confirmation-logic';

// Pure-logic tests for Task 15's typed-confirmation gate. Extracted out of
// the dialog component per this repo's established pattern (see
// mobile-drawer-logic.test.ts) because vitest.config.ts runs with
// environment: 'node' (no jsdom) — real <input> typing/onChange events
// can't be simulated via renderToStaticMarkup, so the comparison and gate
// logic is tested directly here instead.

describe('isConfirmationTextValid', () => {
  it('accepts an exact case-sensitive match of the English phrase', () => {
    expect(isConfirmationTextValid('PUBLISH', 'PUBLISH')).toBe(true);
  });

  it('accepts an exact match of the Arabic phrase', () => {
    expect(isConfirmationTextValid('نشر', 'نشر')).toBe(true);
  });

  it('rejects a lowercase/incorrectly-cased typo of the English phrase', () => {
    expect(isConfirmationTextValid('publish', 'PUBLISH')).toBe(false);
  });

  it('rejects a partial or fuzzy match', () => {
    expect(isConfirmationTextValid('PUBLIS', 'PUBLISH')).toBe(false);
    expect(isConfirmationTextValid('PUBLISHH', 'PUBLISH')).toBe(false);
  });

  it('rejects the wrong-locale phrase entirely', () => {
    expect(isConfirmationTextValid('نشر', 'PUBLISH')).toBe(false);
    expect(isConfirmationTextValid('PUBLISH', 'نشر')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isConfirmationTextValid('', 'PUBLISH')).toBe(false);
  });

  it('trims leading/trailing whitespace (copy-paste artifact) before comparing', () => {
    expect(isConfirmationTextValid('  PUBLISH  ', 'PUBLISH')).toBe(true);
    expect(isConfirmationTextValid('PUBLISH\n', 'PUBLISH')).toBe(true);
    expect(isConfirmationTextValid('\tPUBLISH', 'PUBLISH')).toBe(true);
  });

  it('does NOT collapse or fold internal whitespace/case — only outer trim is applied', () => {
    expect(isConfirmationTextValid('PUB LISH', 'PUBLISH')).toBe(false);
    expect(isConfirmationTextValid('Publish', 'PUBLISH')).toBe(false);
  });
});

describe('canSubmitConfirmation', () => {
  const base = {
    canConfirm: true,
    typedConfirmation: 'PUBLISH',
    requiredPhrase: 'PUBLISH',
    submitting: false,
  };

  it('allows submission when every condition is satisfied', () => {
    expect(canSubmitConfirmation(base)).toBe(true);
  });

  it('blocks submission when already submitting (double-submission prevention)', () => {
    expect(canSubmitConfirmation({ ...base, submitting: true })).toBe(false);
  });

  it('blocks submission when the pre-existing canConfirm gate (blockers/acknowledgment) is not satisfied', () => {
    expect(canSubmitConfirmation({ ...base, canConfirm: false })).toBe(false);
  });

  it('blocks submission when the typed confirmation text does not match', () => {
    expect(canSubmitConfirmation({ ...base, typedConfirmation: 'publish' })).toBe(false);
    expect(canSubmitConfirmation({ ...base, typedConfirmation: '' })).toBe(false);
  });

  it('blocks submission when both submitting and canConfirm are false (submitting takes precedence, still false either way)', () => {
    expect(canSubmitConfirmation({ ...base, submitting: true, canConfirm: false })).toBe(false);
  });

  it('works with the Arabic required phrase', () => {
    expect(canSubmitConfirmation({ ...base, typedConfirmation: 'نشر', requiredPhrase: 'نشر' })).toBe(true);
    expect(canSubmitConfirmation({ ...base, typedConfirmation: 'PUBLISH', requiredPhrase: 'نشر' })).toBe(false);
  });
});

// Code-review follow-up (blocking fix): canSubmitConfirmation({ submitting:
// true }) above proves the PURE gate logic is correct, but `submitting` is
// a React prop that only updates on the NEXT render after
// setConfirming(true) is called — it does not close the real race where a
// fast double-click fires the click handler twice before that re-render
// (and the button's real `disabled` attribute) ever lands. runGuardedOnce
// is the actual mechanism the dialog uses to close that window: a plain
// mutable flag, checked-and-set synchronously with no render involved.
// These tests simulate the real race directly — calling runGuardedOnce
// twice back-to-back, before the first call's action has resolved — and
// assert the guarded action only actually runs once.
describe('runGuardedOnce (real double-invocation / rapid double-click race)', () => {
  it('invokes the action exactly once when called twice concurrently before the first resolves', async () => {
    const guard = createReentrancyGuard();
    const action = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

    // Simulates two rapid clicks: both handler invocations start before
    // either has awaited anything, exactly like two real click events
    // firing before React re-renders the button as disabled.
    const first = runGuardedOnce(guard, action);
    const second = runGuardedOnce(guard, action);

    await Promise.all([first, second]);

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('releases the guard after the action settles, allowing a later genuinely-new call', async () => {
    const guard = createReentrancyGuard();
    const action = vi.fn(() => Promise.resolve());

    await runGuardedOnce(guard, action);
    await runGuardedOnce(guard, action);

    expect(action).toHaveBeenCalledTimes(2);
  });

  it('releases the guard even when the action throws, so a retry after a failed publish is not permanently locked out', async () => {
    const guard = createReentrancyGuard();
    const failingAction = vi.fn(() => Promise.reject(new Error('confirm failed')));
    const succeedingAction = vi.fn(() => Promise.resolve());

    await expect(runGuardedOnce(guard, failingAction)).rejects.toThrow('confirm failed');
    expect(guard.current).toBe(false);

    await runGuardedOnce(guard, succeedingAction);
    expect(succeedingAction).toHaveBeenCalledTimes(1);
  });

  it('a third overlapping call while the first two are still in flight is also a no-op', async () => {
    const guard = createReentrancyGuard();
    const action = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

    const calls = [runGuardedOnce(guard, action), runGuardedOnce(guard, action), runGuardedOnce(guard, action)];
    await Promise.all(calls);

    expect(action).toHaveBeenCalledTimes(1);
  });
});
