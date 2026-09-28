'use client';

/**
 * Mobile navigation drawer. Client-only (needs usePathname, focus
 * management, keyboard events, body-scroll lock).
 *
 * Accessibility requirements implemented (see Task 5 brief):
 *  - Manual focus trap (Tab/Shift+Tab wrap) — no focus-trap library exists
 *    in package.json (checked before writing this file), so implemented
 *    by hand using computeFocusTrapTarget from mobile-drawer-logic.ts.
 *  - Close on Escape (isEscapeKey from mobile-drawer-logic.ts).
 *  - Close on any pathname OR locale change (see note below on why both
 *    are needed).
 *  - Focus returns to the stored trigger-button ref on close.
 *  - body scroll lock while open, cleaned up on unmount even if still open.
 *  - aria-label on the drawer landmark.
 *  - Logical CSS placement (inset-inline-start, not left) for correct RTL.
 *  - Always starts closed (open state is fully owned by
 *    MobileDrawerProvider, shared via useMobileDrawer() — this
 *    component never initializes itself open).
 *
 * IMPORTANT — pathname alone is NOT enough to catch a locale switch:
 * next-intl's usePathname() (verified against
 * node_modules/next-intl/dist/esm/development/navigation/react-client/
 * useBasePathname.js) deliberately returns the LOCALE-STRIPPED pathname
 * (e.g. "/participants" for both /ar/participants and /en/participants).
 * A pure locale switch on the same route therefore does NOT change what
 * usePathname() returns, so relying on pathname change alone would leave
 * the drawer stuck open with mismatched RTL/LTR classes across a locale
 * switch — exactly the bug the task brief's test requirement is aimed at
 * catching. useLocale() (from 'next-intl') is tracked alongside pathname
 * so a locale-only navigation also triggers the close.
 *
 * open/onClose/triggerRef come from useMobileDrawer() (a Context shared
 * with the sibling MobileDrawerTrigger instance — see
 * mobile-drawer-context.tsx's doc comment) rather than as direct props
 * from a parent, since MobileDrawer and MobileDrawerTrigger are rendered
 * as siblings in the server-composed tree, not parent/child.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useLocale } from 'next-intl';
import { usePathname } from '@/i18n/routing';
import type { NavGroup } from '@/lib/nav/nav-types';
import { SidebarNav } from './sidebar-nav';
import { useMobileDrawer } from './mobile-drawer-context';
import { computeFocusTrapTarget, isEscapeKey, shouldCloseOnPathnameChange } from './mobile-drawer-logic';

export interface MobileDrawerProps {
  navGroups: NavGroup[];
  storageKey: string;
  ariaLabel: string;
  /** Plain map of NavItem/NavGroup `labelKey` -> translated display text; forwarded to SidebarNav. */
  navTranslations: Record<string, string>;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector));
}

export function MobileDrawer({ navGroups, storageKey, ariaLabel, navTranslations }: MobileDrawerProps) {
  const { open, setOpen, triggerRef } = useMobileDrawer();
  // Stable identity across renders (setOpen from useState is itself
  // stable) so the keydown-listener effect below, keyed on [open, onClose],
  // doesn't re-subscribe on every render.
  const onClose = useCallback(() => setOpen(false), [setOpen]);
  const pathname = usePathname();
  const locale = useLocale();
  // Combine both signals into one comparison key: a change in EITHER
  // pathname or locale should close the drawer (see the module doc for
  // why locale must be tracked separately from pathname).
  const navigationKey = `${locale}:${pathname}`;
  const previousNavigationKeyRef = useRef(navigationKey);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Close on any pathname OR locale change while open.
  useEffect(() => {
    const previous = previousNavigationKeyRef.current;
    previousNavigationKeyRef.current = navigationKey;
    if (open && shouldCloseOnPathnameChange(previous, navigationKey)) {
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationKey]);

  // Body scroll lock while open, cleaned up on unmount regardless of open state.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // Escape-to-close + manual focus trap, and focus-return on close.
  useEffect(() => {
    if (!open) return;

    // Move focus into the drawer when it opens.
    const panel = panelRef.current;
    if (panel) {
      const focusable = getFocusableElements(panel);
      (focusable[0] ?? panel).focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isEscapeKey(event.key)) {
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
  }, [open, onClose]);

  // Return focus to the trigger button whenever the drawer transitions to closed.
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      triggerRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open, triggerRef]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <div
        className="absolute inset-0 bg-charcoal/40"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className="absolute inset-y-0 start-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto bg-warm-white shadow-xl outline-none"
        style={{ insetInlineStart: 0 }}
      >
        <div className="flex items-center justify-end p-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-md p-2 text-charcoal/70 hover:bg-charcoal/5 hover:text-charcoal"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <SidebarNav navGroups={navGroups} storageKey={storageKey} navTranslations={navTranslations} />
      </div>
    </div>
  );
}
