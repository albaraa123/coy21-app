import { describe, expect, it } from 'vitest';
import {
  computeFocusTrapTarget,
  isEscapeKey,
  shouldCloseOnPathnameChange,
} from '@/components/shell/mobile-drawer-logic';

describe('computeFocusTrapTarget', () => {
  const elements = ['first', 'middle', 'last'];

  it('returns null when there are no focusable elements', () => {
    expect(computeFocusTrapTarget([], 'anything', false)).toBeNull();
  });

  it('Tab on the last element wraps to the first', () => {
    expect(computeFocusTrapTarget(elements, 'last', false)).toBe('first');
  });

  it('Tab on an element outside the list (focus escaped) wraps to the first', () => {
    expect(computeFocusTrapTarget(elements, 'outside-element', false)).toBe('first');
  });

  it('Tab on a middle element does not force a wrap (returns null, default behavior)', () => {
    expect(computeFocusTrapTarget(elements, 'middle', false)).toBeNull();
  });

  it('Shift+Tab on the first element wraps to the last', () => {
    expect(computeFocusTrapTarget(elements, 'first', true)).toBe('last');
  });

  it('Shift+Tab on an element outside the list wraps to the last', () => {
    expect(computeFocusTrapTarget(elements, 'outside-element', true)).toBe('last');
  });

  it('Shift+Tab on a middle element does not force a wrap', () => {
    expect(computeFocusTrapTarget(elements, 'middle', true)).toBeNull();
  });

  it('handles a single-focusable-element drawer: Tab wraps to itself', () => {
    expect(computeFocusTrapTarget(['only'], 'only', false)).toBe('only');
    expect(computeFocusTrapTarget(['only'], 'only', true)).toBe('only');
  });
});

describe('isEscapeKey', () => {
  it('recognizes "Escape"', () => {
    expect(isEscapeKey('Escape')).toBe(true);
  });

  it('recognizes legacy "Esc"', () => {
    expect(isEscapeKey('Esc')).toBe(true);
  });

  it('rejects other keys', () => {
    expect(isEscapeKey('Enter')).toBe(false);
    expect(isEscapeKey('Tab')).toBe(false);
    expect(isEscapeKey('')).toBe(false);
  });
});

describe('shouldCloseOnPathnameChange', () => {
  it('returns true when the pathname changed', () => {
    expect(shouldCloseOnPathnameChange('/participants', '/agenda')).toBe(true);
  });

  it('returns false when the pathname is unchanged', () => {
    expect(shouldCloseOnPathnameChange('/participants', '/participants')).toBe(false);
  });

  it('treats a locale-only-equal but otherwise different dynamic path as a change', () => {
    expect(shouldCloseOnPathnameChange('/participants/abc-123', '/participants/def-456')).toBe(true);
  });
});
