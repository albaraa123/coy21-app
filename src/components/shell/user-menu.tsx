'use client';

/**
 * User menu (client, interactive parts only). Displays a translated role
 * label passed in by the caller as a plain string prop — this component
 * MUST NOT contain any raw user_role enum value or role->label mapping
 * logic itself (that mapping happens server-side, in whatever component
 * builds `userDisplay` for AppShell, per Task 5's authorization/privacy
 * requirement). This component only ever receives already-safe,
 * already-translated display data.
 *
 * The logout trigger is a true server-action form submission
 * (<form action={logOutAction}>), not a client-only fetch/session
 * manipulation, per the task brief. useActionState (React 19, the
 * version installed per package.json) supplies the pending state and any
 * error returned by the action without a separate manual submit handler.
 *
 * Close behavior: the menu closes on outside pointerdown and on Escape —
 * the same two mechanisms MobileDrawer implements (see
 * mobile-drawer.tsx), reusing mobile-drawer-logic.ts's isEscapeKey rather
 * than reimplementing key-matching. Without this, the only way to close
 * the menu would be re-clicking the toggle button, which is both a real
 * usability bug and a miss against ARIA authoring practices for a
 * role="menu" widget (Escape-to-close and click-outside-to-close are
 * both expected).
 */

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { logOutAction, type LogOutActionState } from '@/app/[locale]/(auth)/actions';
import { isEscapeKey } from './mobile-drawer-logic';

export interface UserMenuProps {
  name: string;
  roleLabel: string;
  logoutLabel: string;
}

function LogoutSubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md px-3 py-2 text-start text-sm font-medium text-charcoal/80 hover:bg-charcoal/5 disabled:opacity-50"
    >
      {pending ? '…' : label}
    </button>
  );
}

export function UserMenu({ name, roleLabel, logoutLabel }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<LogOutActionState, FormData>(logOutAction, {});
  // Wraps BOTH the toggle button and the menu panel (not just the panel),
  // so a click on the toggle button itself is correctly treated as
  // "inside" by the outside-pointerdown handler below. If containerRef
  // only wrapped the panel, clicking the toggle button to close an
  // already-open menu would first close it via the outside-click check
  // and then immediately reopen it via the button's own onClick toggle —
  // a re-open flicker bug.
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside pointerdown or Escape — mirrors MobileDrawer's
  // close-on-Escape handling (mobile-drawer.tsx), plus a click-outside
  // check keyed off containerRef.
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isEscapeKey(event.key)) {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-charcoal hover:bg-charcoal/5"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-charcoal/10 text-xs font-semibold uppercase">
          {name.charAt(0) || '?'}
        </span>
        <span className="hidden text-start sm:flex sm:flex-col sm:leading-tight">
          <span>{name}</span>
          <span className="text-xs font-normal text-charcoal/60">{roleLabel}</span>
        </span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={name}
          className="absolute end-0 z-10 mt-2 w-48 rounded-md border border-charcoal/10 bg-warm-white p-1 shadow-lg"
        >
          <form action={formAction}>
            <LogoutSubmitButton label={logoutLabel} />
          </form>
          {state.error && (
            <p role="alert" className="px-3 py-1 text-xs text-red-600">
              {state.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
