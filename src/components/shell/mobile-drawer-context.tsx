'use client';

/**
 * Shared client-only state for coordinating the mobile drawer's
 * open/close state between two SIBLING Client Components that a Server
 * Component (AppShell) composes independently: MobileDrawerTrigger
 * (rendered inside the server-rendered Topbar tree) and MobileDrawer
 * (rendered alongside the desktop sidebar/main, elsewhere in the same
 * tree). Neither can directly hold a reference to the other's state
 * across that composition, and passing a raw setState/callback FUNCTION
 * from a Server Component into a Client Component's props is not legal
 * RSC serialization (that was the original bug this file replaces the
 * fix for — see app-shell.tsx's and app-shell-client.tsx's git history /
 * the bug-fix commit this file was introduced in).
 *
 * A React Context provider is the standard, documented way to share
 * client-only interaction state between sibling Client Components that a
 * Server Component composes as children, without ever needing to pass a
 * function value across the server/client boundary: AppShell (server)
 * renders <MobileDrawerProvider> (client) wrapping the whole shell
 * subtree, and both MobileDrawerTrigger and MobileDrawer — each
 * instantiated independently from the server tree — read/write shared
 * state via useMobileDrawer() from inside that provider. The provider
 * itself is passed no function props from the server either: it takes
 * only `children` (ReactNode), which is the one thing legal to pass
 * across that boundary.
 */

import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface MobileDrawerContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Ref to the button that opened the drawer, so focus can return to it on close. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const MobileDrawerContext = createContext<MobileDrawerContextValue | null>(null);

export function MobileDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const value = useMemo(() => ({ open, setOpen, triggerRef }), [open]);

  return <MobileDrawerContext.Provider value={value}>{children}</MobileDrawerContext.Provider>;
}

/**
 * Throws if used outside a MobileDrawerProvider — both MobileDrawerTrigger
 * and MobileDrawer are only ever meant to be rendered inside AppShell,
 * which always wraps its subtree in the provider. A silent fallback
 * here would hide a real composition bug (a trigger/drawer instance that
 * can never actually coordinate with its counterpart).
 */
export function useMobileDrawer(): MobileDrawerContextValue {
  const ctx = useContext(MobileDrawerContext);
  if (!ctx) {
    throw new Error('useMobileDrawer must be used within a MobileDrawerProvider');
  }
  return ctx;
}
