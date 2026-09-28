/**
 * Pure, DOM-adjacent-but-not-React logic for MobileDrawer's accessibility
 * behaviors, split out of mobile-drawer.tsx so it can be unit-tested
 * without a real browser/jsdom. Each function takes plain DOM values
 * (arrays of elements, KeyboardEvent-shaped objects, a pathname pair) and
 * returns/mutates only what it's given — no React, no refs, no effects.
 *
 * Why extracted rather than tested via a DOM: this repo has no
 * jsdom/@testing-library, and vitest.config.ts is explicitly
 * environment: 'node'. Task 5's brief allows either adding jsdom or
 * extracting pure logic; the focus-trap tab-wrap calculation,
 * Escape-key detection, and close-on-navigate comparison are all pure
 * enough to extract cleanly, so that path was taken here to keep the
 * suite dependency-free and fast. See mobile-drawer.tsx for where these
 * are wired into real DOM refs/effects (untestable without jsdom, and
 * exercised instead by manual verification — documented in the task
 * report).
 */

/**
 * Given the drawer's focusable elements (in DOM/tab order) and the
 * currently focused element, compute which element Tab (or Shift+Tab)
 * should move focus to, wrapping at the ends. Returns null if there are
 * no focusable elements (nothing to trap focus within).
 */
export function computeFocusTrapTarget(
  focusableElements: readonly unknown[],
  currentlyFocused: unknown,
  shiftKey: boolean
): unknown | null {
  if (focusableElements.length === 0) return null;

  const first = focusableElements[0];
  const last = focusableElements[focusableElements.length - 1];
  const currentIndex = focusableElements.indexOf(currentlyFocused);

  if (shiftKey) {
    // Shift+Tab on (or before/outside) the first element wraps to the last.
    if (currentIndex <= 0) return last;
    return null; // let default browser behavior handle the rest
  }

  // Tab on (or after/outside) the last element wraps to the first.
  if (currentIndex === -1 || currentIndex >= focusableElements.length - 1) return first;
  return null;
}

/** True if the given key event represents an Escape keypress. */
export function isEscapeKey(key: string): boolean {
  return key === 'Escape' || key === 'Esc';
}

/** True if a pathname change (old !== new) should close the drawer. */
export function shouldCloseOnPathnameChange(previousPathname: string, nextPathname: string): boolean {
  return previousPathname !== nextPathname;
}
