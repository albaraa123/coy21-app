// tests/auth/temporary-password-display.test.ts
import { describe, it, expect } from 'vitest';
import { temporaryPasswordDisplay, APPROVED_TEMP_PASSWORD } from '@/lib/auth/provision-participant-account';

describe('temporaryPasswordDisplay', () => {
  it('shows "No account" when there is no account regardless of must_change_password', () => {
    expect(temporaryPasswordDisplay('no_account', true)).toBe('No account');
    expect(temporaryPasswordDisplay('no_account', false)).toBe('No account');
  });

  it('shows "Existing password" for an existing_account row, never the approved temp password', () => {
    expect(temporaryPasswordDisplay('existing_account', true)).toBe('Existing password');
    expect(temporaryPasswordDisplay('existing_account', false)).toBe('Existing password');
  });

  it('shows the approved temporary password while must_change_password is true', () => {
    expect(temporaryPasswordDisplay('account_created', true)).toBe(APPROVED_TEMP_PASSWORD);
    expect(temporaryPasswordDisplay('password_change_required', true)).toBe(APPROVED_TEMP_PASSWORD);
    expect(temporaryPasswordDisplay('conflict', true)).toBe(APPROVED_TEMP_PASSWORD);
  });

  it('shows "Password changed" once must_change_password is false and an account exists', () => {
    expect(temporaryPasswordDisplay('active', false)).toBe('Password changed');
    expect(temporaryPasswordDisplay('account_created', false)).toBe('Password changed');
    expect(temporaryPasswordDisplay('password_change_required', false)).toBe('Password changed');
  });

  it('never returns anything other than these 3 fixed strings or the approved constant', () => {
    const statuses = ['no_account', 'account_created', 'password_change_required', 'active', 'existing_account', 'creation_failed', 'conflict'] as const;
    const allowedOutputs = new Set(['No account', 'Existing password', APPROVED_TEMP_PASSWORD, 'Password changed']);
    for (const status of statuses) {
      for (const mustChange of [true, false]) {
        expect(allowedOutputs.has(temporaryPasswordDisplay(status, mustChange))).toBe(true);
      }
    }
  });
});
