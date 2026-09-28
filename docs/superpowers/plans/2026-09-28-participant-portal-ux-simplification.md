# Participant Portal UX Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the COY21-App participant portal per `docs/superpowers/specs/2026-09-28-participant-portal-ux-simplification-design.md` — a 4-item bottom tab bar + "More" panel replacing the flat 9-item nav, a status-aware card dashboard, clearer "My Program"/"Conference Program" naming, and a 3-step registration form with a skippable optional step.

**Architecture:** `AppShell` gains an opt-in `bottomTabItems` prop, used only by the participant `(shell)` layout — the admin layout passes nothing and is visually/behaviorally unaffected. A new `BottomTabBar` client component renders the 4 primary items; the existing `MobileDrawer`/`SidebarNav` are reused unchanged for the "More" panel's *contents* (list rendering, focus trap, RTL, locale-switch-close), triggered from a new "More" tab instead of (or alongside) the existing hamburger trigger. `participant-nav-config.ts`'s flat `NavItem[]` gains a `placement: 'primary' | 'more'` field partitioning it into the two surfaces. The registration form's existing `STEP_1_FIELDS`/`STEP_2_FIELDS` constants split into three (`STEP_1_FIELDS`/`STEP_2_FIELDS`/`STEP_3_FIELDS`) with `step` widened to a `1 | 2 | 3` union; the Zod schema is untouched. The dashboard page adds card-priority logic driven by existing query functions (`getMyApplicationStatus`, travel completeness, QR availability) plus one new travel-completeness query.

**Tech Stack:** Next.js App Router, React Server/Client Components, next-intl, react-hook-form + zod, Supabase, Tailwind CSS, Vitest.

---

## Task 1: Add `placement` to `NavItem` and partition the participant nav config

**Files:**
- Modify: `src/lib/nav/nav-types.ts`
- Modify: `src/lib/nav/participant-nav-config.ts`
- Test: `tests/nav/participant-nav-config.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/nav/participant-nav-config.test.ts
import { describe, it, expect } from 'vitest';
import { participantNavItems } from '@/lib/nav/participant-nav-config';

describe('participantNavItems placement partition', () => {
  it('has exactly 4 primary items: dashboard, my-agenda, my-qr, and a more-trigger placeholder is NOT one of them', () => {
    const primary = participantNavItems.filter((i) => i.placement === 'primary');
    const hrefs = primary.map((i) => i.href).sort();
    expect(hrefs).toEqual(['/my-agenda', '/my-dashboard', '/my-qr'].sort());
  });

  it('has exactly 6 "more" items: schedule, my-application, my-travel, venue-map, local-info, my-profile', () => {
    const more = participantNavItems.filter((i) => i.placement === 'more');
    const hrefs = more.map((i) => i.href).sort();
    expect(hrefs).toEqual(
      ['/schedule', '/my-application', '/my-travel', '/venue-map', '/local-info', '/my-profile'].sort()
    );
  });

  it('every item has a placement of either primary or more (no unassigned items)', () => {
    for (const item of participantNavItems) {
      expect(['primary', 'more']).toContain(item.placement);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/nav/participant-nav-config.test.ts`
Expected: FAIL — `item.placement` is `undefined`, `NavItem` has no `placement` field yet.

- [ ] **Step 3: Add `placement` to `NavItem` (optional field, backward compatible)**

In `src/lib/nav/nav-types.ts`, add `placement?: 'primary' | 'more'` to the `NavItem` interface. Keep it optional so `admin-nav-config.ts` (which never sets it) still type-checks — the admin layout doesn't use a tab bar and never reads this field.

```typescript
export interface NavItem {
  labelKey: string;
  href: string;
  iconKey: string;
  children?: NavItem[];
  /** Which nav surface this item belongs to for participant-shell layouts using a bottom tab bar. Unused by admin nav configs. */
  placement?: 'primary' | 'more';
}
```

- [ ] **Step 4: Partition `participantNavItems`**

Rewrite `src/lib/nav/participant-nav-config.ts`:

```typescript
import type { NavItem } from './nav-types';

export const participantNavItems: NavItem[] = [
  { labelKey: 'nav.participant.dashboard',   href: '/my-dashboard',   iconKey: 'dashboard',   placement: 'primary' },
  { labelKey: 'nav.participant.agenda',      href: '/my-agenda',      iconKey: 'schedule',    placement: 'primary' },
  { labelKey: 'nav.participant.myQr',        href: '/my-qr',          iconKey: 'qr',          placement: 'primary' },
  { labelKey: 'nav.participant.schedule',    href: '/schedule',        iconKey: 'allocation',  placement: 'more' },
  { labelKey: 'nav.participant.application', href: '/my-application', iconKey: 'applications', placement: 'more' },
  { labelKey: 'nav.participant.travel',      href: '/my-travel',      iconKey: 'travel',       placement: 'more' },
  { labelKey: 'nav.participant.venueMap',    href: '/venue-map',      iconKey: 'map',          placement: 'more' },
  { labelKey: 'nav.participant.localInfo',   href: '/local-info',     iconKey: 'info',         placement: 'more' },
  { labelKey: 'nav.participant.profile',     href: '/my-profile',     iconKey: 'profile',      placement: 'more' },
];
```

Note: per the spec, the "Home" tab bar item points at `/my-dashboard` (the existing dashboard route), and "My Program" is `/my-agenda` renamed at the label level only (Task 3 handles the label text change).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/nav/participant-nav-config.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Run the full test suite to check for regressions in existing nav-consuming code**

Run: `npx vitest run tests/shell/`
Expected: PASS — `placement` is additive/optional, `admin-nav-config.ts` and every existing consumer of `NavItem`/`NavGroup` (SidebarNav, MobileDrawer, AppShell) ignores the new field entirely until Task 2 wires it up.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/nav/nav-types.ts src/lib/nav/participant-nav-config.ts tests/nav/participant-nav-config.test.ts
git commit -m "feat(nav): partition participant nav items into primary/more placements"
```

---

## Task 2: Build `BottomTabBar` component

**Files:**
- Create: `src/components/shell/bottom-tab-bar.tsx`
- Test: `tests/shell/bottom-tab-bar.test.tsx` (new file)

This component renders the 4 fixed tabs (3 `primary`-placement `NavItem`s passed in, plus a hardcoded "More" trigger as the 4th). It is `'use client'` since it needs `usePathname()` for active-tab highlighting, same pattern as `SidebarNav`. It does **not** render the More panel's contents itself — clicking "More" opens the existing `MobileDrawer` (Task 3 wires this).

**Testing convention note:** this codebase has no `@testing-library/react`/jsdom setup (confirmed: `vitest.config.ts` uses `environment: 'node'`, and existing `.test.tsx` files like `tests/components/badge.test.tsx` use `react-dom/server`'s `renderToStaticMarkup` to assert on rendered HTML strings, not interactive DOM testing). Follow that exact convention here — assert on markup content/attributes via string/regex matching, not `fireEvent`/`screen` queries. Click-behavior (the `onMoreClick` callback firing) cannot be verified via `renderToStaticMarkup` since it produces static HTML with no live event handlers attached — verify that behavior only through Step 6's manual browser check in Task 3, not as an automated unit test. This is a real, narrower test than an interactive-DOM setup would give; do not introduce `@testing-library/react` or `jsdom` as a new dependency to work around it without checking with the user first, since that's a toolchain change beyond this plan's scope.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/shell/bottom-tab-bar.test.tsx
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BottomTabBar } from '@/components/shell/bottom-tab-bar';
import type { NavItem } from '@/lib/nav/nav-types';

const primaryItems: NavItem[] = [
  { labelKey: 'nav.participant.dashboard', href: '/my-dashboard', iconKey: 'dashboard', placement: 'primary' },
  { labelKey: 'nav.participant.agenda', href: '/my-agenda', iconKey: 'schedule', placement: 'primary' },
  { labelKey: 'nav.participant.myQr', href: '/my-qr', iconKey: 'qr', placement: 'primary' },
];

const navTranslations = {
  'nav.participant.dashboard': 'Home',
  'nav.participant.agenda': 'My Program',
  'nav.participant.myQr': 'My QR',
};

// BottomTabBar calls usePathname()/Link from '@/i18n/routing', which needs
// Next.js router context to run outside a real app tree. Check how
// sidebar-nav.tsx's own tests (if any exist — `find tests -iname "*sidebar-nav*"`)
// handle this before writing BottomTabBar's test; if none exist, this
// component may need a thin presentational sub-component (pure props in,
// no routing hooks) that IS unit-testable via renderToStaticMarkup, with
// the usePathname()-dependent active-tab logic kept in a separate,
// separately-unit-testable pure function (e.g. `isTabActive(item, pathname)`
// reusing the existing `isItemActive` from route-matching.ts, already
// covered by its own tests). Prefer that split over trying to mock
// '@/i18n/routing' inline, matching how this codebase's existing components
// avoid framework-coupled logic inside hard-to-test render bodies.
describe('BottomTabBar', () => {
  it('renders exactly 4 tabs: 3 primary items plus a More trigger, in order', () => {
    const html = renderToStaticMarkup(
      <BottomTabBar
        primaryItems={primaryItems}
        navTranslations={navTranslations}
        moreLabel="More"
        currentPathname="/my-dashboard"
      />
    );
    expect(html).toContain('Home');
    expect(html).toContain('My Program');
    expect(html).toContain('My QR');
    expect(html).toContain('More');
  });

  it('marks the tab matching the current pathname with aria-current="page"', () => {
    const html = renderToStaticMarkup(
      <BottomTabBar
        primaryItems={primaryItems}
        navTranslations={navTranslations}
        moreLabel="More"
        currentPathname="/my-dashboard"
      />
    );
    expect(html).toMatch(/aria-current="page"[^>]*>[\s\S]*?Home|Home[\s\S]*?aria-current="page"/);
  });

  it('gives the More trigger an accessible name via visible text, not icon alone', () => {
    const html = renderToStaticMarkup(
      <BottomTabBar
        primaryItems={primaryItems}
        navTranslations={navTranslations}
        moreLabel="More"
        currentPathname="/my-dashboard"
      />
    );
    expect(html).toContain('>More<');
  });
});
```

Note: this rewritten test drops the `onMoreClick` prop from the render call and replaces it with an explicit `currentPathname` prop — because `usePathname()` cannot run outside a real Next.js tree in a `renderToStaticMarkup` unit test. This is a real design implication for Step 3 below: `BottomTabBar` should accept `currentPathname` as a prop (computed by its caller, `AppShell`, which is itself inside the real app tree and can call `usePathname()`) rather than calling the hook internally — making the component pure-props and directly testable, and resolving the untestable-hook problem instead of working around it. `onMoreClick` still exists as a prop for the real (non-test) wiring in Task 3; it's simply not exercised by this static-markup test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shell/bottom-tab-bar.test.tsx`
Expected: FAIL — `Cannot find module '@/components/shell/bottom-tab-bar'`

- [ ] **Step 3: Write the implementation**

```tsx
// src/components/shell/bottom-tab-bar.tsx
'use client';

/**
 * Persistent bottom tab bar for the participant portal shell — 3 primary
 * NavItems (placement: 'primary' in participant-nav-config.ts) plus a
 * fixed 4th "More" trigger that opens the existing MobileDrawer (see
 * app-shell.tsx for wiring). This component owns only the 4-tab strip;
 * it renders no panel/drawer content itself.
 *
 * Accessibility (per docs/superpowers/specs/2026-09-28-participant-portal-
 * ux-simplification-design.md §1): active tab gets aria-current="page";
 * every tab (including icon-only ones) has an accessible name via visible
 * label text (no icon-only tabs in the current design — label always
 * renders); touch targets sized via padding, not just icon size; RTL
 * mirroring is automatic via flex + logical properties (no explicit
 * left/right), same convention as sidebar-nav.tsx.
 */
import { Link } from '@/i18n/routing';
import { isItemActive } from '@/lib/nav/route-matching';
import type { NavItem } from '@/lib/nav/nav-types';
import { ICON_MAP } from '@/lib/nav/icon-map';

export interface BottomTabBarProps {
  primaryItems: NavItem[];
  navTranslations: Record<string, string>;
  moreLabel: string;
  onMoreClick: () => void;
  /**
   * Current pathname, passed in by the caller (which itself calls
   * usePathname()) rather than read internally via the hook here — keeps
   * this component pure-props, directly testable with
   * renderToStaticMarkup (no Next.js router context needed), matching
   * this codebase's existing component-test convention (see
   * tests/components/badge.test.tsx).
   */
  currentPathname: string;
}

function resolveLabel(navTranslations: Record<string, string>, labelKey: string): string {
  return navTranslations[labelKey] ?? labelKey;
}

export function BottomTabBar({ primaryItems, navTranslations, moreLabel, onMoreClick, currentPathname }: BottomTabBarProps) {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-charcoal/10 bg-white dark:border-white/10 dark:bg-gray-900 md:hidden"
    >
      {primaryItems.map((item) => {
        const active = isItemActive(item, currentPathname);
        const Icon = ICON_MAP[item.iconKey];
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium ${
              active ? 'text-turquoise' : 'text-charcoal/60 dark:text-gray-400'
            }`}
          >
            {Icon ? <Icon className="h-5 w-5" aria-hidden="true" /> : null}
            <span>{resolveLabel(navTranslations, item.labelKey)}</span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMoreClick}
        className="flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium text-charcoal/60 dark:text-gray-400"
      >
        <span aria-hidden="true" className="text-lg leading-none">⋯</span>
        <span>{moreLabel}</span>
      </button>
    </nav>
  );
}
```

Check `src/lib/nav/route-matching.ts` exports `isItemActive` with this exact signature before writing this — read the file first if unsure.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shell/bottom-tab-bar.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/bottom-tab-bar.tsx tests/shell/bottom-tab-bar.test.tsx
git commit -m "feat(shell): add BottomTabBar component for participant nav"
```

---

## Task 3: Wire `BottomTabBar` into `AppShell` (opt-in, participant-only)

**Files:**
- Modify: `src/components/shell/app-shell.tsx`
- Modify: `src/app/[locale]/(participant)/(shell)/layout.tsx`
- Test: `tests/shell/app-shell-bottom-tab-bar.test.tsx` (new file)

`AppShell` gains an optional `bottomTabItems` + `moreLabel` prop pair. When absent (admin layout's call site, unmodified), nothing changes — no tab bar renders, matching current admin behavior exactly. When present (participant layout), the tab bar renders and clicking "More" opens the existing `MobileDrawer` via `MobileDrawerProvider`'s existing open/close state — no new state management needed, `useMobileDrawer()` already exists for this.

**Testing approach note:** `AppShell` is a composition root (`Topbar` + `MobileDrawerProvider` + `SidebarNav`, each with their own `usePathname()`/context dependencies) with no existing unit test of its own (confirmed: `find tests -iname "*app-shell*"` before writing this task turned up nothing) — it is presumably covered only by higher-level integration/live tests, if at all. Introducing a full-tree render test for it here would be new test infrastructure beyond this plan's scope (same `@testing-library/react`-unavailability problem as Task 2, compounded by `AppShell`'s deeper Next.js context dependencies). Instead, verify the conditional-rendering logic directly in the source and rely on Task 10's manual browser walkthrough for end-to-end confirmation — do not force an automated render test where the codebase has no established pattern for one at this component's level.

- [ ] **Step 1: Confirm there is no existing `app-shell` test to extend**

Run: `find tests -iname "*app-shell*"`
Expected: no results. If results exist, read them first and follow their established pattern instead of what follows below.

Run: `npx vitest run tests/shell/app-shell-bottom-tab-bar.test.tsx`
- [ ] **Step 2: Modify `AppShell`**

In `src/components/shell/app-shell.tsx`:
1. Read `src/components/shell/mobile-drawer-trigger.tsx` and `mobile-drawer-context.tsx` first to confirm `useMobileDrawer()`'s exact shape (`{ open, setOpen }` or similar) before wiring this — do not guess the API.
2. Add to `AppShellProps`:
```typescript
  /** Primary-placement NavItems for the participant bottom tab bar. Omit entirely for shells (e.g. admin) that don't use one. */
  bottomTabItems?: NavItem[];
  /** Label for the "More" tab. Required when bottomTabItems is provided. */
  moreLabel?: string;
```
   (Import `NavItem` alongside the existing `NavGroup` import.)
3. `BottomTabBar` needs `currentPathname` (a prop, not an internal hook call per Task 2's design) and `onMoreClick` (a callback into `useMobileDrawer()`'s open-setter). Since `AppShell` itself is a Server Component (no `usePathname()` available directly in its own body — confirmed by its own doc comment: "No 'use client', no usePathname... per Task 5's brief"), wrap `BottomTabBar` in a small new client component (e.g. `bottom-tab-bar-client-wrapper.tsx`, `'use client'`) that calls both `usePathname()` and `useMobileDrawer()` internally and renders `<BottomTabBar currentPathname={...} onMoreClick={...} ... />` — mirroring exactly how `MobileDrawerTrigger` already exists as the client-side sibling handling the same kind of client-only concern for the existing hamburger trigger. Render this new wrapper conditionally (only when `bottomTabItems` is truthy) inside the existing `<MobileDrawerProvider>`, as a further sibling alongside `Topbar`/`MobileDrawer`. Add bottom padding to `<main>` (e.g. `pb-16 md:pb-0`) when the tab bar is present, so page content doesn't render underneath the fixed bar.

- [ ] **Step 3: Wire the participant layout**

In `src/app/[locale]/(participant)/(shell)/layout.tsx`, pass the new props to `<AppShell>`:

```typescript
const primaryTabItems = participantNavItems.filter((item) => item.placement === 'primary');
```

and add `bottomTabItems={primaryTabItems}` and `moreLabel={t('moreLabel')}` (add a `shell.moreLabel` translation key in Task 6) to the `<AppShell>` call.

Do **not** touch `src/app/[locale]/(admin)/layout.tsx` — its `<AppShell>` call stays exactly as-is, with no `bottomTabItems`/`moreLabel` props, confirming admin is unaffected.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. This is the primary automated verification for this task, given the composition-root testing gap noted above — confirm both call sites (`(admin)/layout.tsx` unchanged, `(participant)/(shell)/layout.tsx` with the new props) type-check against the widened `AppShellProps`.

- [ ] **Step 5: Run the full shell test suite for regressions**

Run: `npx vitest run tests/shell/`
Expected: PASS — existing admin-layout and drawer tests unaffected (none of them exercise the new optional props, so none should change behavior).

- [ ] **Step 6: Manual verification (defer full walkthrough to Task 10, but do a quick sanity check now)**

Run: `npm run dev`, visit a participant page (e.g. `/my-dashboard`) and confirm the bottom tab bar renders with working links and the "More" trigger opens the existing drawer. Visit an admin page and confirm no tab bar appears and nothing else changed.

- [ ] **Step 7: Commit**

```bash
git add src/components/shell/app-shell.tsx "src/app/[locale]/(participant)/(shell)/layout.tsx"
git commit -m "feat(shell): wire BottomTabBar into AppShell for participant layout only"
```

---

## Task 4: RTL and accessibility test coverage for the tab bar

**Files:**
- Test: `tests/shell/bottom-tab-bar.test.tsx` (extend from Task 2)

Per the spec's accessibility/RTL requirements not yet covered by Task 2's tests.

- [ ] **Step 1: Add RTL order test**

```tsx
it('renders tabs in DOM order matching primaryItems order regardless of locale (RTL handled by CSS dir, not JS reordering)', () => {
  const html = renderToStaticMarkup(
    <BottomTabBar
      primaryItems={primaryItems}
      navTranslations={navTranslations}
      moreLabel="More"
      currentPathname="/my-dashboard"
    />
  );
  const labelPositions = ['Home', 'My Program', 'My QR', 'More'].map((label) => html.indexOf(`>${label}<`));
  const sorted = [...labelPositions].sort((a, b) => a - b);
  expect(labelPositions).toEqual(sorted);
});
```

(Add this `it` block to the existing `describe('BottomTabBar', ...)` block from Task 2 — same file, same imports, no new imports needed.)

Confirm this passes as-is (the component uses `flex` with no explicit `flex-direction: row-reverse`, relying on the page's `dir="rtl"` attribute — set elsewhere in the layout tree, likely `<html dir={...}>` — to visually mirror without DOM reordering, matching `sidebar-nav.tsx`'s convention of logical CSS properties). If it fails, do not add JS-level reordering — instead verify the parent `<html>`/`<body>` sets `dir` correctly (check `src/app/[locale]/layout.tsx`) and rely on that.

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/shell/bottom-tab-bar.test.tsx`
Expected: PASS (now 4 tests total)

- [ ] **Step 3: Commit**

```bash
git add tests/shell/bottom-tab-bar.test.tsx
git commit -m "test(shell): add RTL tab-order coverage for BottomTabBar"
```

---

## Task 5: Rename "my-agenda" / "schedule" nav labels to "My Program" / "Conference Program"

**Files:**
- Modify: `src/messages/en.json`
- Modify: `src/messages/ar.json`
- Test: `tests/nav/participant-nav-labels.test.ts` (new file)

Per spec §3 — label-only change, routes (`/my-agenda`, `/schedule`) stay the same.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/nav/participant-nav-labels.test.ts
import { describe, it, expect } from 'vitest';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

describe('participant nav labels: My Program / Conference Program', () => {
  it('English: agenda label is "My Program", schedule label is "Conference Program"', () => {
    expect(en.nav.participant.agenda).toBe('My Program');
    expect(en.nav.participant.schedule).toBe('Conference Program');
  });

  it('Arabic: agenda label is "برنامجي", schedule label is "برنامج المؤتمر"', () => {
    expect(ar.nav.participant.agenda).toBe('برنامجي');
    expect(ar.nav.participant.schedule).toBe('برنامج المؤتمر');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/nav/participant-nav-labels.test.ts`
Expected: FAIL — current values are "My Bookings"/"Assigned Schedule" (en) and "أجندتي"/"جدولي" (ar).

- [ ] **Step 3: Update `src/messages/en.json`**

At the `nav.participant` block (around line 59-69), change:
```json
"agenda": "My Program",
"schedule": "Conference Program",
```
(leave every other key in that block unchanged).

- [ ] **Step 4: Update `src/messages/ar.json`**

At the equivalent `nav.participant` block, change:
```json
"agenda": "برنامجي",
"schedule": "برنامج المؤتمر",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/nav/participant-nav-labels.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Check for other usages of the old label text**

Run: `grep -rn "My Bookings\|Assigned Schedule" src/`
Expected: no matches outside `en.json`/`ar.json` themselves (if any page hardcodes these strings directly instead of via translation keys, flag it — do not silently change unrelated hardcoded copy without confirming it's the same UI surface).

- [ ] **Step 7: Commit**

```bash
git add src/messages/en.json src/messages/ar.json tests/nav/participant-nav-labels.test.ts
git commit -m "feat(i18n): rename my-agenda/schedule nav labels to My Program / Conference Program"
```

---

## Task 6: Add `shell.moreLabel` translation key

**Files:**
- Modify: `src/messages/en.json`
- Modify: `src/messages/ar.json`

Needed by Task 3's layout wiring.

- [ ] **Step 1: Add the key to both files**

In `src/messages/en.json`, in the `shell` block (near `logoutLabel`/`drawerAriaLabel` around line 617-618), add:
```json
"moreLabel": "More",
```

In `src/messages/ar.json`, in the equivalent `shell` block, add:
```json
"moreLabel": "المزيد",
```

- [ ] **Step 2: Verify no JSON syntax errors**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/messages/en.json'))" && node -e "JSON.parse(require('fs').readFileSync('src/messages/ar.json'))"`
Expected: no output (both parse successfully).

- [ ] **Step 3: Typecheck (next-intl may have typed message keys)**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/messages/en.json src/messages/ar.json
git commit -m "feat(i18n): add shell.moreLabel translation key"
```

---

## Task 7: Add a travel-completeness query for dashboard card logic

**Files:**
- Modify: `src/lib/dashboard/participant-dashboard-queries.ts`
- Test: `tests/dashboard/participant-dashboard-queries.test.ts` (extend if exists, else create)

Per spec §2, the dashboard needs to know whether the participant has submitted travel info, to decide card priority. Check first whether an existing query in `src/lib/travel-ops/` already exposes this in a caller-scoped form before writing a new one — reuse if so.

- [ ] **Step 1: Check for existing reusable travel-completeness logic**

Run: `grep -rn "application_travel_info" src/lib/dashboard/ src/app/\[locale\]/\(participant\)/`

If an existing participant-scoped travel query already exists (e.g. in `my-travel/page.tsx` or `my-travel/actions.ts`), read it and reuse its exact query shape/table columns rather than inventing a new one — note its file path here before proceeding to Step 2.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/dashboard/participant-dashboard-queries.test.ts (add to existing file, or create new)
import { describe, it, expect, vi } from 'vitest';
import { getMyTravelCompleteness } from '@/lib/dashboard/participant-dashboard-queries';

describe('getMyTravelCompleteness', () => {
  it('returns { kind: "empty" } when the caller has no applications row at all (never claimed/submitted)', async () => {
    const service = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    };
    const result = await getMyTravelCompleteness({ userId: 'user-1', service: service as never });
    expect(result).toEqual({ kind: 'empty' });
  });

  it('returns { kind: "data", value: { submitted: true } } when a travel_info row exists', async () => {
    const service = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'travel-1' }, error: null }),
      }),
    };
    const result = await getMyTravelCompleteness({ userId: 'user-1', service: service as never });
    expect(result.kind).toBe('data');
  });
});
```

Adjust the exact mock shape once you've read `application_travel_info`'s real columns and the caller-scoping pattern from Step 1 — this is illustrative, not exact.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/dashboard/participant-dashboard-queries.test.ts`
Expected: FAIL — `getMyTravelCompleteness` not exported.

- [ ] **Step 4: Implement `getMyTravelCompleteness`**

Follow the exact pattern of `getMySchedulePublicationState` in the same file (two-step lookup: caller's own `applications.id` via `applicant_id = userId`, then `application_travel_info` scoped to that `application_id`). Add:

```typescript
export type MyTravelCompleteness = { submitted: boolean };

export async function getMyTravelCompleteness(caller: DashboardParticipantCaller): Promise<CardResult<MyTravelCompleteness>> {
  const { data: application, error: applicationError } = await caller.service
    .from('applications')
    .select('id')
    .eq('applicant_id', caller.userId)
    .maybeSingle();

  if (applicationError) return { kind: 'error', message: applicationError.message };
  if (!application) return { kind: 'empty' };

  const { data: travelInfo, error: travelError } = await caller.service
    .from('application_travel_info')
    .select('id')
    .eq('application_id', application.id)
    .maybeSingle();

  if (travelError) return { kind: 'error', message: travelError.message };
  return { kind: 'data', value: { submitted: Boolean(travelInfo) } };
}
```

Adjust the exact table/column names to match what Step 1's investigation found — `application_travel_info`'s real primary key and FK column names must be verified against `supabase/migrations/20260730110000_application_travel_and_health_info_tables.sql` before writing this, not assumed.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/dashboard/participant-dashboard-queries.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/dashboard/participant-dashboard-queries.ts tests/dashboard/participant-dashboard-queries.test.ts
git commit -m "feat(dashboard): add getMyTravelCompleteness query for status-aware home cards"
```

---

## Task 8: Rebuild `my-dashboard` as a status-aware card screen

**Files:**
- Modify: `src/app/[locale]/(participant)/(shell)/my-dashboard/page.tsx`
- Test: `tests/dashboard/my-dashboard-card-priority.test.ts` (new file — pure function test, not a full page render test)

Per spec §2, implement the three representative states as a pure card-ordering function first (testable in isolation), then wire it into the page.

- [ ] **Step 1: Write the failing test for the card-priority function**

```typescript
// tests/dashboard/my-dashboard-card-priority.test.ts
import { describe, it, expect } from 'vitest';
import { computeDashboardCardOrder, type DashboardCardId } from '@/app/[locale]/(participant)/(shell)/my-dashboard/card-priority';

describe('computeDashboardCardOrder', () => {
  it('not-yet-accepted: application status first (large), program card dimmed/disabled', () => {
    const order = computeDashboardCardOrder({ applicationStatus: 'submitted', travelSubmitted: false, qrAvailable: false });
    expect(order[0]).toBe<DashboardCardId>('applicationStatus');
  });

  it('accepted, travel not submitted: travel-completion card first', () => {
    const order = computeDashboardCardOrder({ applicationStatus: 'accepted', travelSubmitted: false, qrAvailable: true });
    expect(order[0]).toBe<DashboardCardId>('completeTravelInfo');
  });

  it('accepted, travel complete, QR available: QR card first', () => {
    const order = computeDashboardCardOrder({ applicationStatus: 'accepted', travelSubmitted: true, qrAvailable: true });
    expect(order[0]).toBe<DashboardCardId>('myQr');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard/my-dashboard-card-priority.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the pure card-priority function**

```typescript
// src/app/[locale]/(participant)/(shell)/my-dashboard/card-priority.ts
//
// Pure function implementing the 3 representative states from
// docs/superpowers/specs/2026-09-28-participant-portal-ux-simplification-
// design.md §2. Deliberately NOT an exhaustive state machine (per spec's
// "Out of scope" note) — extend this function's cases if a future spec
// enumerates more states; do not special-case beyond what's listed here
// without updating the design doc first.
export type DashboardCardId = 'applicationStatus' | 'completeTravelInfo' | 'myQr' | 'myProgram';

export interface DashboardCardInputs {
  applicationStatus: 'draft' | 'submitted' | 'under_review' | 'accepted' | 'waitlisted' | 'rejected' | 'withdrawn';
  travelSubmitted: boolean;
  qrAvailable: boolean;
}

export function computeDashboardCardOrder(inputs: DashboardCardInputs): DashboardCardId[] {
  const notYetAccepted = ['submitted', 'under_review', 'waitlisted'].includes(inputs.applicationStatus);

  if (notYetAccepted) {
    return ['applicationStatus', 'myProgram'];
  }

  if (inputs.applicationStatus === 'accepted' && !inputs.travelSubmitted) {
    return ['completeTravelInfo', 'myQr', 'myProgram'];
  }

  if (inputs.applicationStatus === 'accepted' && inputs.travelSubmitted && inputs.qrAvailable) {
    return ['myQr', 'myProgram'];
  }

  // Fallback for accepted+travelSubmitted+!qrAvailable, and draft/rejected/
  // withdrawn — not covered as a named state by the spec's 3 examples.
  // Application status card first is the safest default (matches the
  // not-yet-accepted case) until this is refined against real usage.
  return ['applicationStatus', 'myProgram'];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard/my-dashboard-card-priority.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire `computeDashboardCardOrder` into the page**

Modify `my-dashboard/page.tsx`:
1. Import `getMyTravelCompleteness` (Task 7) alongside the existing three query functions, and call it in the existing `Promise.all`.
2. Import `computeDashboardCardOrder` from the new `card-priority.ts`.
3. Determine `qrAvailable` — reuse `getMyQrState` from `src/lib/attendance/participant-qr.ts` (reviewed earlier: returns `{ kind: 'QR_AVAILABLE' | 'NOT_YET_AVAILABLE' | ... }`), calling it as a 4th item in the `Promise.all`.
4. Compute `applicationStatus.value?.status` (default to a safe fallback like `'submitted'` if the query returned `empty`/`error`, since `computeDashboardCardOrder` requires a concrete status) and pass into `computeDashboardCardOrder`.
5. Replace the current fixed 2-card layout (application status card, schedule-publication card) with a card renderer that iterates the computed order, rendering each `DashboardCardId` as its corresponding `<Card>` block. Keep each card's existing internal content/copy (application status badge, schedule-publication notice) — only the *order and presence* changes, not each card's content, except:
   - Add a new `completeTravelInfo` card (large, actionable) linking to `/my-travel`, shown only when it's first in the computed order.
   - The existing schedule-publication card becomes the `myProgram` card, relabeled per Task 5's "My Program" naming, linking to `/my-agenda` (not `/schedule` — this is the personal-program card, per spec §2's table using "My Program" not "Conference Program").
   - Add a `myQr` card (linking to `/my-qr`) rendered when `'myQr'` appears in the computed order.

Do not remove the existing claim-state notice card (`claimState.kind === 'data' && !claimState.value.claimed`) — that's a separate, orthogonal concern (pre-claim account linking) not covered by this spec's card-priority states; it renders above the priority-ordered cards, unchanged from today.

- [ ] **Step 6: Manually verify in the dev server**

Run: `npm run dev`, then in a browser sign in as a test participant at each of the 3 states (submitted, accepted-no-travel, accepted-with-travel-and-QR — use existing test fixtures or the admin UI to set `applications.status`/seed `application_travel_info`/`qr_credentials` as needed) and confirm card order matches the spec table. Screenshot or describe what you see for each state before moving on.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 8: Run the dashboard test suite**

Run: `npx vitest run tests/dashboard/`
Expected: PASS, no regressions in any existing dashboard tests.

- [ ] **Step 9: Commit**

```bash
git add "src/app/[locale]/(participant)/(shell)/my-dashboard/" tests/dashboard/my-dashboard-card-priority.test.ts
git commit -m "feat(dashboard): status-aware card ordering on my-dashboard"
```

---

## Task 9: Split registration form's field groups into 3 steps

**Files:**
- Create: `src/app/[locale]/(participant)/(bare)/register/registration-form-steps.ts`
- Modify: `src/app/[locale]/(participant)/(bare)/register/registration-form.tsx`
- Test: `tests/registration/registration-form-steps.test.ts` (new file)

**Testing convention note (same constraint as Tasks 2-3):** this codebase has no `@testing-library/react`/jsdom setup, and a multi-step form's step-transition/validation-gating logic is genuinely interactive (simulating field input, clicking "Next", asserting the resulting step) — `renderToStaticMarkup` cannot exercise this (it produces one static snapshot, no event simulation). Rather than introducing new test infrastructure unilaterally, this task extracts the step-transition and skip-eligibility logic into small, pure, directly-unit-testable functions (same pattern as Task 8's `card-priority.ts`), and defers full interactive verification to a manual browser walkthrough (Step 8 below). If the assigned worker judges that thorough automated coverage of the interactive flow is important enough to justify adding `@testing-library/react` + `jsdom` as new dependencies, that is a toolchain decision to raise with the user first — do not add it silently mid-task.

- [ ] **Step 1: Check for an existing test file covering this form**

Run: `find tests -iname "*registration-form*"`

If found, read it fully before writing new tests — extend it rather than duplicating coverage, and note here which existing test cases must keep passing unchanged.

- [ ] **Step 2: Write the failing test for the extracted pure logic**

```typescript
// tests/registration/registration-form-steps.test.ts
import { describe, it, expect } from 'vitest';
import { isStepValid, STEP_1_FIELDS, STEP_2_FIELDS, STEP_3_FIELDS } from '@/app/[locale]/(participant)/(bare)/register/registration-form-steps';
import type { z } from 'zod';
import type { registrationSchema } from '@/lib/validation/registration';

type FormValues = z.infer<typeof registrationSchema>;

describe('registration-form-steps', () => {
  it('STEP_1_FIELDS no longer includes organization (moved to step 3)', () => {
    expect(STEP_1_FIELDS).not.toContain('organization');
  });

  it('STEP_2_FIELDS is exactly interests, experience_level, participation_goals', () => {
    expect([...STEP_2_FIELDS].sort()).toEqual(['experience_level', 'interests', 'participation_goals'].sort());
  });

  it('STEP_3_FIELDS includes all 8 optional fields plus organization', () => {
    expect([...STEP_3_FIELDS].sort()).toEqual(
      [
        'organization', 'climate_experience', 'past_initiatives', 'topics_to_learn',
        'content_type_pref', 'track_interests', 'priority_sessions', 'special_needs',
      ].sort()
    );
  });

  it('isStepValid(1, values) is false when a required step-1 field is missing', () => {
    const values: Partial<FormValues> = { phone: '123', country: 'Oman' }; // missing nationality, city, field_of_work, preferred_language, birth_date/age_group
    expect(isStepValid(1, values)).toBe(false);
  });

  it('isStepValid(1, values) is true when all required step-1 fields are present (with age_group satisfying the birth_date-or-age_group refine)', () => {
    const values: Partial<FormValues> = {
      phone: '123', country: 'Oman', nationality: 'Omani', city: 'Muscat',
      field_of_work: 'Climate', preferred_language: 'en', age_group: '25_34',
    };
    expect(isStepValid(1, values)).toBe(true);
  });

  it('isStepValid(3, values) is always true regardless of step-3 field contents (all optional — Skip is always available)', () => {
    expect(isStepValid(3, {})).toBe(true);
    expect(isStepValid(3, { organization: 'Some org' })).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/registration/registration-form-steps.test.ts`
Expected: FAIL — `registration-form-steps` module doesn't exist yet.

- [ ] **Step 4: Extract step constants and validity logic into a new pure module, then rewrite `registration-form.tsx` with 3 steps**

First, create `src/app/[locale]/(participant)/(bare)/register/registration-form-steps.ts`:

```typescript
// src/app/[locale]/(participant)/(bare)/register/registration-form-steps.ts
//
// Pure, directly-unit-testable step definitions and per-step validity
// checks for registration-form.tsx's 3-step flow. Extracted from the
// component so step-gating logic can be tested without simulating DOM
// interaction (this codebase has no interactive-DOM test setup — see
// registration-form.tsx's own test file for the full rationale).
import { personalInfoSchema, conferenceInfoSchema } from '@/lib/validation/registration';
import type { z } from 'zod';

type PersonalInfo = z.infer<typeof personalInfoSchema>;
type ConferenceInfo = z.infer<typeof conferenceInfoSchema>;
export type FormValues = PersonalInfo & ConferenceInfo;

export const STEP_1_FIELDS: readonly (keyof FormValues)[] = [
  'phone', 'country', 'nationality', 'birth_date', 'age_group',
  'city', 'field_of_work', 'preferred_language',
];

export const STEP_2_FIELDS: readonly (keyof FormValues)[] = [
  'interests', 'experience_level', 'participation_goals',
];

export const STEP_3_FIELDS: readonly (keyof FormValues)[] = [
  'organization', 'climate_experience', 'past_initiatives', 'topics_to_learn',
  'content_type_pref', 'track_interests', 'priority_sessions', 'special_needs',
];

/**
 * Whether the given step's own required fields are present in `values`.
 * Step 1 uses personalInfoSchema's own .refine (birth_date OR age_group)
 * rather than re-deriving that rule here — parses the step-1 subset of
 * `values` through personalInfoSchema.pick(...) restricted to STEP_1_FIELDS
 * plus a runtime shape that only requires what step 1 actually asks for.
 * Step 3 is always valid (every STEP_3_FIELDS entry is .optional() in
 * conferenceInfoSchema) — this is what makes "Skip" always available.
 */
export function isStepValid(step: 1 | 2 | 3, values: Partial<FormValues>): boolean {
  if (step === 3) return true;
  const schema = step === 1 ? personalInfoSchema : conferenceInfoSchema;
  const result = schema.safeParse(values);
  return result.success;
}
```

Verify this compiles against the real `personalInfoSchema`/`conferenceInfoSchema` shapes in `src/lib/validation/registration.ts` — if `.safeParse` on a partial `values` object rejects for reasons unrelated to the step's own fields (e.g. because `personalInfoSchema.safeParse` also implicitly requires `conferenceInfoSchema` fields due to how they're combined via `.and()` in `registrationSchema`), adjust `isStepValid` to validate against each sub-schema in isolation as written above (`personalInfoSchema`/`conferenceInfoSchema` are the two schemas *before* `.and()` combines them into `registrationSchema` — confirm this split still exists and each sub-schema validates independently before relying on it).

Then rewrite `registration-form.tsx`:

1. Import `STEP_1_FIELDS`, `STEP_2_FIELDS`, `STEP_3_FIELDS` from the new module instead of defining them inline.
2. Widen `useState<1 | 2>(1)` to `useState<1 | 2 | 3>(1)`.
3. Add a progress indicator rendered above all 3 step bodies: `<p>Step {step} of 3</p>` (wire to `useTranslations` for real copy — this plan uses literal English for illustration; final i18n keys are an implementation detail to add to `en.json`/`ar.json` alongside this task, following the existing `t('...')` pattern used elsewhere in this file's sibling pages).
4. Step 1's "Next" button now moves to step 2 (unchanged logic, just relabel if needed).
5. Step 2 (currently the final `<form onSubmit={...}>` in the old code) becomes step 2's body: same fields as new `STEP_2_FIELDS` (interests, experience_level, participation_goals only — `organization` and the 7 other now-optional fields move out). Its "Next" button (new) moves to step 3 instead of submitting; remove `type="submit"` from this step's button, autosave via `autosaveStep(STEP_2_FIELDS)` on transition.
6. Step 3 is new: renders `STEP_3_FIELDS`' inputs (organization, climate_experience, past_initiatives, topics_to_learn, content_type_pref, track_interests, priority_sessions, special_needs — moved verbatim from the old step 2 body, plus the `organization` input moved from the old step 1 body). Two buttons: "Back" (returns to step 2) and "Submit Application" (existing `type="submit"` behavior, calling `onSubmit` — unchanged). Add a "Skip" button beside/near Submit: `onClick={handleSubmit(onSubmit)}` — same submit handler as the Submit button, since `STEP_3_FIELDS` are all `.optional()` in the Zod schema already, so `handleSubmit`'s validation will pass with no step-3 fields filled. Skip is not a *different* code path from Submit — it's the same submit action, offered as a second, more prominent affordance for the case where the user fills nothing.
7. `onSubmit`'s existing call to `autosaveStep(STEP_2_FIELDS)` before `submitApplication` must become `autosaveStep(STEP_3_FIELDS)` (final step before submit changed).
8. Use `isStepValid(step, getValues())` (imported from the new module) to gate whether each step's "Next" button is enabled/clickable — replacing any implicit "just let react-hook-form's own per-field errors show" behavior with an explicit step-level gate, so a participant cannot advance past Step 1 or 2 without that step's required fields filled. Step 3's "Next"-equivalents (Skip/Submit) need no such gate, since `isStepValid(3, ...)` is always `true`.

- [ ] **Step 5: Run the pure-logic test to verify it passes**

Run: `npx vitest run tests/registration/registration-form-steps.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 7: Run the full registration/auth test suite for regressions**

Run: `npx vitest run tests/registration/ tests/auth/`
Expected: PASS.

- [ ] **Step 8: Manually verify the full interactive flow in the browser**

This is the primary verification for the interactive parts this plan's automated tests cannot cover (see this task's testing-convention note above). Run: `npm run dev`, walk through the form as a real participant would (requires a valid invitation/draft application row — use existing test fixtures or an admin-created invitation). Confirm:
- The progress indicator reads "Step 1 of 3" / "Step 2 of 3" / "Step 3 of 3" correctly at each step.
- Step 1's "Next" is disabled/blocked until all required step-1 fields are filled (including the birth_date-or-age_group pair).
- Step 2's "Next" is disabled/blocked until interests/experience_level/participation_goals are filled.
- Step 3's "Skip" button submits successfully with zero step-3 fields filled, and "Submit Application" also works after filling some.
- Submitting with neither `birth_date` nor `age_group` ever filled (if reachable — should be blocked by Step 1's gate per the point above, but confirm the underlying Zod `.refine` still catches it as a defense-in-depth check) surfaces the existing error message, not a silent failure.
- Each step's autosave writes to `applications` via the network tab or DB inspection, and returning to `/register` mid-flow resumes at the correct step with previously-entered values intact (existing `draftToDefaultValues` behavior, unchanged).

Note any deviation from expected behavior found during this walkthrough and fix before proceeding to commit.

- [ ] **Step 9: Commit**

```bash
git add "src/app/[locale]/(participant)/(bare)/register/registration-form.tsx" "src/app/[locale]/(participant)/(bare)/register/registration-form-steps.ts" tests/registration/registration-form-steps.test.ts
git commit -m "feat(registration): split form into 3 steps with skippable optional step 3"
```

---

## Task 10: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the complete test suite**

Run: `npx vitest run`
Expected: no new failures introduced by this plan's changes. Pre-existing failures unrelated to this work (if any — check against known issues in `docs/superpowers/specs/2026-07-31-pre-existing-test-failures-technical-debt.md`) are not this plan's responsibility to fix.

- [ ] **Step 2: Full typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Manually walk the full participant portal in a browser**

Run: `npm run dev`. As a participant test account: confirm the bottom tab bar renders on mobile viewport widths, the desktop sidebar still works at wider viewports (verify `md:` breakpoint behavior — `BottomTabBar` is `md:hidden` per Task 2's implementation, so desktop should show the existing sidebar unaffected), "More" opens the drawer with the 6 secondary items, "My Program"/"Conference Program" labels appear correctly in both locales, and the registration form's 3 steps flow correctly end to end including Skip.

- [ ] **Step 4: Confirm admin dashboard is visually and functionally unchanged**

Sign in as an admin/staff test account, confirm no bottom tab bar appears anywhere in `(admin)` routes, and the existing sidebar/drawer nav behaves exactly as before this plan's changes.

- [ ] **Step 5: Final commit (if any manual-verification fixes were needed)**

```bash
git add -A
git commit -m "chore: final regression fixes for participant portal UX simplification"
```

(Skip this commit if no fixes were needed during Steps 1-4.)
