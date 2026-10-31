# Toast Notification System — Design Spec

**Date:** 2026-11-01
**Status:** Approved by user.

## Problem

No toast/notification system exists anywhere in the codebase. Every
success/error message today is rendered as inline page text via a local
`useState<string | null>` pattern repeated independently in nearly every
form (confirmed: `status-control.tsx` and many others across admin/
participant pages all duplicate this same shape). There is no shared,
reusable mechanism for showing a transient notification.

## Scope

Add the toast *infrastructure* — library, global mount point, RTL/dark-mode
wiring — so it's ready to use in any future client component with zero
boilerplate. This is explicitly NOT a rewrite of every existing inline-
error form; that would be a separate, much larger task. One existing form
(`status-control.tsx`) is wired up as a concrete working example/reference
pattern, proving the system end-to-end without taking on a full-app
migration.

## Library

`sonner`, added as a project dependency (`npm install sonner`). Chosen
over a hand-built component for speed, a well-tested RTL/dark-mode story,
and because it's a minimal, framework-idiomatic API (`toast.success(...)`,
`toast.error(...)`) with no custom wrapper needed.

## Mount point

A single `<Toaster />` added once in `src/app/[locale]/layout.tsx` — the
one root layout already covering every route group (public, admin,
participant, scanner, auth). No change needed to any other layout file.

```tsx
<Toaster
  theme="system"
  richColors
  dir={locale === 'ar' ? 'rtl' : 'ltr'}
/>
```

- `theme="system"`: matches the app's existing dark-mode strategy exactly
  — `globals.css` uses `@media (prefers-color-scheme: dark)` with no
  manual toggle/class, so sonner's `system` theme needs zero additional
  wiring to stay in sync.
- `richColors`: sonner's built-in success/error/warning color coding,
  avoiding custom CSS to match this app's existing green/red/amber status
  conventions.
- `dir`: reads the `locale` param already available in this layout (no
  new data fetch) and maps to sonner's native RTL support.

## API surface

No custom wrapper hook or module. Any client component imports `toast`
directly from `sonner` and calls it:

```tsx
import { toast } from 'sonner';

toast.success('Status updated');
toast.error('Failed to update status');
```

This keeps the system genuinely zero-boilerplate everywhere going
forward — sonner's own API is already minimal enough that a wrapper would
only add an indirection layer with no real benefit.

## Reference example: `status-control.tsx`

`src/app/[locale]/(admin)/agenda/sessions/[id]/status-control.tsx` is
updated to call `toast.error(...)` in its two existing catch blocks
(status-change failure, cancellation failure) instead of (or in addition
to, per implementation judgment) its current inline `<p>` error render.
This is the one concrete, verified usage proving the system works
end-to-end in this codebase — not a mandate to touch any other file.

## Explicitly out of scope

- No migration of any other existing inline-error form.
- No custom toast wrapper/hook abstraction over `sonner`'s own API.
- No new design tokens or custom toast styling beyond `richColors` +
  `theme="system"` — sonner's defaults are used as-is.
- No success-toast additions to flows that don't currently have one
  (e.g. this task doesn't add "Booked ✓" toasts to the booking flow,
  which already has its own in-place UI feedback).
