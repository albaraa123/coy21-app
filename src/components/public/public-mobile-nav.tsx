'use client';

/**
 * Mobile navigation drawer for the PUBLIC site.
 *
 * DIVERGENCE FROM src/components/shell/mobile-drawer.tsx (documented per
 * the task brief, which asks to try reuse first and explain if it
 * genuinely doesn't fit): MobileDrawer's props are hardwired to
 * `navGroups: NavGroup[]` and it renders `<SidebarNav navGroups={...}>`
 * directly (see mobile-drawer.tsx line ~158) — SidebarNav in turn renders
 * collapsible grouped sections with iconKey-driven icons
 * (src/lib/nav/nav-types.ts), which is the right shape for the
 * admin/participant dashboards (many items, grouped, iconified,
 * localStorage-persisted collapse state) but the WRONG shape for the
 * public nav: a single flat list of 8 links with no groups and no icons.
 * Forcing the public nav into a one-group NavGroup[] just to satisfy
 * MobileDrawer's prop type would mean synthesizing fake iconKeys and
 * fighting SidebarNav's grouped/collapsible rendering for something that
 * should just be a plain list — worse than a small, honest divergence.
 *
 * What IS reused rather than reimplemented: the exact pure a11y logic
 * functions MobileDrawer itself uses, imported directly from
 * mobile-drawer-logic.ts (computeFocusTrapTarget, isEscapeKey,
 * shouldCloseOnPathnameChange) — so the focus trap, Escape-to-close, and
 * close-on-navigate behaviors are byte-for-byte the same tested logic,
 * not a reimplementation. Only the markup/content (flat PublicNavigation
 * list instead of SidebarNav) and the open/close-on-locale-change wiring
 * are duplicated, and they're duplicated in the same shape as
 * MobileDrawer (including the locale-change tracking, RTL-correct
 * inset-inline-start placement, and body-scroll lock) for behavioral
 * parity.
 */
import { useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/routing';
import {
  computeFocusTrapTarget,
  isEscapeKey,
  shouldCloseOnPathnameChange,
} from '@/components/shell/mobile-drawer-logic';
import { PublicNavigation } from './public-navigation';


function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector));
}

export interface PublicMobileNavProps {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

export function PublicMobileNav({ open, onClose, triggerRef }: PublicMobileNavProps) {
  const t = useTranslations('public.nav');
  const pathname = usePathname();
  const locale = useLocale();
  const navigationKey = `${locale}:${pathname}`;
  const previousNavigationKeyRef = useRef(navigationKey);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previous = previousNavigationKeyRef.current;
    previousNavigationKeyRef.current = navigationKey;
    if (open && shouldCloseOnPathnameChange(previous, navigationKey)) {
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationKey]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

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
      <div className="absolute inset-0 bg-charcoal/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('openMenu')}
        tabIndex={-1}
        className="absolute inset-y-0 start-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto bg-warm-white shadow-xl outline-none"
        style={{ insetInlineStart: 0 }}
      >
        <div className="flex items-center justify-end p-3">
          <button
            type="button"
            onClick={onClose}
            aria-label={t('closeMenu')}
            className="rounded-md p-2 text-charcoal/70 hover:bg-charcoal/5 hover:text-charcoal"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <PublicNavigation className="px-2 pb-4" onNavigate={onClose} />
      </div>
    </div>
  );
}
