# Agenda Vertical Timeline View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, user-selectable agenda view mode — a vertical
timeline — alongside the existing color-coded grid, on both the admin
Sessions page and the participant Browse Sessions page.

**Architecture:** A pure layout function (`timeline-layout.ts`, mirroring
the existing `grid-layout.ts`) groups a single day's pre-sorted sessions
into timeline rows. A shared presentational component
(`agenda-timeline.tsx`, mirroring `agenda-time-grid.tsx`) renders those rows
as a vertical list of cards via a `renderCard` render-prop. A view-toggle
component switches between Grid and Timeline, persisting the choice to
`localStorage` via a dedicated read/write helper module, read only inside
`useEffect` (SSR-hydration-safe, matching `sidebar-nav.tsx`'s established
pattern). Both existing page-level `'use client'` wrappers
(`sessions-grid-client.tsx`, `browse-grid-client.tsx`) gain the toggle,
track-filter pills, search bar, and day-tab state where missing, then
conditionally render `AgendaTimeGrid` or `AgendaTimeline` — still receiving
only plain, pre-resolved data from their Server Component parents, per the
RSC-boundary rule already enforced throughout this codebase.

**Tech Stack:** Next.js App Router, TypeScript, React Server/Client
Components, Supabase (service/session clients), next-intl (ar/en), Tailwind
CSS (logical properties for RTL), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-31-agenda-vertical-timeline-design.md`
(approved, passed 2 review rounds).

---

## Task 1: `timeline-layout.ts` pure layout function

**Files:**
- Create: `src/lib/schedule/timeline-layout.ts`
- Test: `tests/schedule/timeline-layout.test.ts`

This mirrors `src/lib/schedule/grid-layout.ts`'s existing conventions:
pure function, no DOM/React, reuses the already-fixed Istanbul-aware
minute math.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/schedule/timeline-layout.test.ts
import { describe, expect, it } from 'vitest';
import { computeTimelineLayout, type TimelineInputSession } from '@/lib/schedule/timeline-layout';
import { CONFERENCE_TIMEZONE_OFFSET_MS } from '@/lib/datetime/conference-time';

// start/end written as Europe/Istanbul wall-clock time, converted to the
// UTC instant actually stored in the DB -- same helper convention as
// tests/schedule/grid-layout.test.ts.
const s = (id: string, start: string, end: string, isBreak = false): TimelineInputSession => {
  const toUtcIso = (hhmm: string) => new Date(new Date(`2026-11-05T${hhmm}:00Z`).getTime() - CONFERENCE_TIMEZONE_OFFSET_MS).toISOString();
  return { id, startTime: toUtcIso(start), endTime: toUtcIso(end), isBreak };
};

describe('computeTimelineLayout', () => {
  it('returns an empty array for an empty session list', () => {
    expect(computeTimelineLayout([])).toEqual([]);
  });

  it('sorts sessions into ascending-start-time rows', () => {
    const rows = computeTimelineLayout([s('b', '10:00', '11:00'), s('a', '08:00', '09:00')]);
    expect(rows.map((r) => r.startMinutes)).toEqual([8 * 60, 10 * 60]);
    expect(rows[0].sessionIds).toEqual(['a']);
    expect(rows[1].sessionIds).toEqual(['b']);
  });

  it('groups sessions sharing the exact same start time into one row', () => {
    const rows = computeTimelineLayout([
      s('a', '10:00', '10:45'),
      s('b', '10:00', '10:30'),
      s('c', '10:15', '11:00'),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].startMinutes).toBe(10 * 60);
    expect(new Set(rows[0].sessionIds)).toEqual(new Set(['a', 'b']));
    expect(rows[1].startMinutes).toBe(10 * 60 + 15);
    expect(rows[1].sessionIds).toEqual(['c']);
  });

  it('converts UTC input to Europe/Istanbul wall-clock minutes (regression for the grid-layout.ts timezone fix, same bug class)', () => {
    const rows = computeTimelineLayout([
      { id: 'reg', startTime: '2026-11-05T05:00:00+00:00', endTime: '2026-11-05T06:00:00+00:00', isBreak: false },
    ]);
    expect(rows[0].startMinutes).toBe(8 * 60);
  });

  it('marks a row isBreak=true only when every session in it is a break (real data never mixes break + non-break at the same start time, but the function must have a defined rule)', () => {
    const rows = computeTimelineLayout([s('brk', '10:00', '10:15', true)]);
    expect(rows[0].isBreak).toBe(true);
  });

  it('a zero-duration or inverted session (end <= start) is dropped, not NaN-crashed', () => {
    const rows = computeTimelineLayout([s('a', '10:00', '10:00'), s('b', '11:00', '10:30')]);
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/schedule/timeline-layout.test.ts`
Expected: FAIL with "Cannot find module '@/lib/schedule/timeline-layout'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/schedule/timeline-layout.ts
//
// Pure layout logic for the agenda vertical-timeline view (admin Sessions
// page, participant Browse Sessions page). Mirrors grid-layout.ts's
// conventions (no DOM, no React, independently unit-testable) but produces
// rows for a vertical list instead of pixel-positioned blocks -- this view
// has no lane-packing/overlap concern since rows aren't positioned by
// duration, only grouped by identical start time and ordered.
//
// PRECONDITION: callers MUST pre-filter input to a single conference day
// before calling this function. minutesSinceMidnightConferenceLocal
// (reused from grid-layout.ts's already-fixed Europe/Istanbul conversion)
// returns minutes-since-midnight with NO date component -- two sessions on
// DIFFERENT days at the same wall-clock time (e.g. both at 08:00 Istanbul)
// would produce identical startMinutes and incorrectly group into one row
// if passed together. Both real call sites (sessions-grid-client.tsx,
// browse-grid-client.tsx) already scope their Timeline input to one active
// day via activeDayIndex/activeIndex state before calling this function.
// This function has no day/date field in its input shape and cannot detect
// a caller's mistake, so this precondition is enforced by caller
// discipline, not runtime validation.

export interface TimelineInputSession {
  id: string;
  startTime: string; // ISO
  endTime: string; // ISO
  isBreak: boolean;
}

export interface TimelineRow {
  /** Minutes since midnight, Europe/Istanbul wall-clock time. */
  startMinutes: number;
  /** Session ids sharing this exact start time, in input order. */
  sessionIds: string[];
  /** True when every session in this row is a break. */
  isBreak: boolean;
}

function minutesSinceMidnightConferenceLocal(iso: string): number {
  // Local fixed +3h UTC offset constant -- see conference-time.ts for the
  // full "Turkey has no DST since 2016" rationale. Imported, not
  // redeclared, so a future DST/offset change only needs one edit.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CONFERENCE_TIMEZONE_OFFSET_MS } = require('@/lib/datetime/conference-time');
  const istanbulMs = new Date(iso).getTime() + CONFERENCE_TIMEZONE_OFFSET_MS;
  const d = new Date(istanbulMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function computeTimelineLayout(sessions: TimelineInputSession[]): TimelineRow[] {
  const valid = sessions
    .map((s) => ({ ...s, startMinutes: minutesSinceMidnightConferenceLocal(s.startTime), endMinutes: minutesSinceMidnightConferenceLocal(s.endTime) }))
    .filter((s) => s.endMinutes > s.startMinutes);

  const byStart = new Map<number, typeof valid>();
  for (const s of valid) {
    if (!byStart.has(s.startMinutes)) byStart.set(s.startMinutes, []);
    byStart.get(s.startMinutes)!.push(s);
  }

  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([startMinutes, group]) => ({
      startMinutes,
      sessionIds: group.map((s) => s.id),
      isBreak: group.every((s) => s.isBreak),
    }));
}
```

**IMPORTANT — fix the `require()` before finishing this task:** the sketch
above uses a dynamic `require()` to avoid an import-ordering edit; this is
NOT acceptable in real code (this is a TypeScript ESM codebase, no
`require()` anywhere else in `src/lib/schedule/`). Replace it with a normal
top-of-file `import { CONFERENCE_TIMEZONE_OFFSET_MS } from
'@/lib/datetime/conference-time';`, exactly as `grid-layout.ts` already
does it (see that file's own import for the precedent). This note exists
because an implementer should not copy the `require()` form verbatim.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/schedule/timeline-layout.test.ts`
Expected: PASS, 6/6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule/timeline-layout.ts tests/schedule/timeline-layout.test.ts
git commit -m "feat: add pure timeline-layout.ts for the agenda vertical timeline view"
```

---

## Task 2: `agenda-view-storage.ts` localStorage helpers

**Files:**
- Create: `src/components/schedule/agenda-view-storage.ts`
- Test: `tests/schedule/agenda-view-storage.test.ts`

Mirrors `src/components/shell/sidebar-nav-storage.ts` exactly: pure,
framework-free, `Pick<Storage, ...>`-typed, try/catch, silent on failure.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/schedule/agenda-view-storage.test.ts
import { describe, expect, it, vi } from 'vitest';
import { readAgendaView, writeAgendaView, type AgendaView } from '@/components/schedule/agenda-view-storage';

describe('agenda-view-storage', () => {
  it('returns "grid" when nothing is stored', () => {
    const storage = { getItem: () => null };
    expect(readAgendaView(storage, 'k')).toBe('grid');
  });

  it('returns the stored value when it is a valid AgendaView', () => {
    const storage = { getItem: () => 'timeline' };
    expect(readAgendaView(storage, 'k')).toBe('timeline');
  });

  it('returns "grid" for a malformed/unexpected stored value', () => {
    const storage = { getItem: () => 'garbage' };
    expect(readAgendaView(storage, 'k')).toBe('grid');
  });

  it('returns "grid" when storage.getItem throws (private browsing etc.)', () => {
    const storage = { getItem: () => { throw new Error('blocked'); } };
    expect(readAgendaView(storage, 'k')).toBe('grid');
  });

  it('writes the given value under the given key', () => {
    const setItem = vi.fn();
    writeAgendaView({ setItem }, 'k', 'timeline' as AgendaView);
    expect(setItem).toHaveBeenCalledWith('k', 'timeline');
  });

  it('swallows a write failure silently', () => {
    const storage = { setItem: () => { throw new Error('quota'); } };
    expect(() => writeAgendaView(storage, 'k', 'grid')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/schedule/agenda-view-storage.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/components/schedule/agenda-view-storage.ts
//
// Pure, framework-free localStorage read/write helpers for the agenda
// Grid/Timeline view-toggle preference. Split out from the toggle
// component for unit-testability, mirroring
// src/components/shell/sidebar-nav-storage.ts's exact convention
// (functions taking a Pick<Storage, ...>-shaped object, not the real
// Storage type, so tests don't need jsdom; try/catch, silent on failure --
// view preference is a pure UX nicety, never worth crashing the page over).
//
// Storage key is caller-supplied (not hardcoded here) because the admin
// Sessions page and participant Browse page need separate keys -- see
// each page's own view-toggle usage for its exact key
// (coy21-admin-sessions-view-v1 / coy21-browse-sessions-view-v1), matching
// sidebar-nav-storage.ts's STORAGE_KEY_ADMIN/STORAGE_KEY_PARTICIPANT
// hyphenated, versioned naming convention.

export type AgendaView = 'grid' | 'timeline';

export function readAgendaView(storage: Pick<Storage, 'getItem'>, storageKey: string): AgendaView {
  try {
    const raw = storage.getItem(storageKey);
    return raw === 'timeline' ? 'timeline' : 'grid';
  } catch {
    return 'grid';
  }
}

export function writeAgendaView(storage: Pick<Storage, 'setItem'>, storageKey: string, view: AgendaView): void {
  try {
    storage.setItem(storageKey, view);
  } catch {
    // Ignore -- see module doc.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/schedule/agenda-view-storage.test.ts`
Expected: PASS, 6/6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/schedule/agenda-view-storage.ts tests/schedule/agenda-view-storage.test.ts
git commit -m "feat: add localStorage helpers for the agenda view-toggle preference"
```

---

## Task 3: `agenda-view-toggle.tsx` component

**Files:**
- Create: `src/components/schedule/agenda-view-toggle.tsx`

No test file (thin presentational `'use client'` component driving
`useState`/`useEffect`/callback — the logic worth testing already lives in
Task 2's pure helpers; this task is verified via the full-page smoke test
in Task 6/7 and a manual browser check).

- [ ] **Step 1: Write the component**

```tsx
// src/components/schedule/agenda-view-toggle.tsx
'use client';

// Grid/Timeline segmented control shared by the admin Sessions page and
// the participant Browse Sessions page. Owns the active-view useState and
// persists it via agenda-view-storage.ts.
//
// SSR-hydration safety, matching src/components/shell/sidebar-nav.tsx's
// established pattern exactly (see that file's own header comment for the
// full rationale): the initial useState value is a fixed deterministic
// default ('grid'), NEVER read from localStorage during render -- the
// server has no localStorage to read from, so reading it synchronously
// here would produce a server/client markup mismatch whenever a user's
// stored preference is 'timeline'. The actual stored preference is read
// inside a useEffect that runs once after mount, then applied via
// setState.
import { useEffect, useState } from 'react';
import { readAgendaView, writeAgendaView, type AgendaView } from './agenda-view-storage';

export function AgendaViewToggle({
  storageKey,
  view,
  onChange,
  gridLabel,
  timelineLabel,
}: {
  storageKey: string;
  view: AgendaView;
  onChange: (view: AgendaView) => void;
  gridLabel: string;
  timelineLabel: string;
}) {
  useEffect(() => {
    onChange(readAgendaView(window.localStorage, storageKey));
    // Intentionally runs once on mount only -- see module header comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (next: AgendaView) => {
    onChange(next);
    writeAgendaView(window.localStorage, storageKey, next);
  };

  return (
    <div role="tablist" className="inline-flex rounded-md border border-charcoal/20 p-0.5 dark:border-gray-700">
      <button
        type="button"
        role="tab"
        aria-selected={view === 'grid'}
        onClick={() => select('grid')}
        className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
          view === 'grid' ? 'bg-turquoise text-white' : 'text-charcoal/60 hover:text-charcoal dark:text-gray-400'
        }`}
      >
        {gridLabel}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'timeline'}
        onClick={() => select('timeline')}
        className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
          view === 'timeline' ? 'bg-turquoise text-white' : 'text-charcoal/60 hover:text-charcoal dark:text-gray-400'
        }`}
      >
        {timelineLabel}
      </button>
    </div>
  );
}
```

Note: `view` is owned by the PARENT client component (`SessionsGridClient`
/ `BrowseGridClient`), not by `AgendaViewToggle` itself, since the parent
needs to know the active view to decide which of `AgendaTimeGrid` /
`AgendaTimeline` to render. `AgendaViewToggle` only reads the persisted
value on mount and reports changes up via `onChange` -- same
lift-state-up shape already used for `minuteHeightPx` in the existing zoom
controls.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep agenda-view-toggle`
Expected: no output (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/components/schedule/agenda-view-toggle.tsx
git commit -m "feat: add AgendaViewToggle Grid/Timeline segmented control"
```

---

## Task 4: `agenda-track-filter-pills.tsx` and `agenda-search-bar.tsx`

**Files:**
- Create: `src/components/schedule/agenda-track-filter-pills.tsx`
- Create: `src/components/schedule/agenda-search-bar.tsx`

Both are thin, stateless (controlled) presentational `'use client'`
components -- all state lives in the parent, same pattern as Task 3.

- [ ] **Step 1: Write `agenda-track-filter-pills.tsx`**

```tsx
// src/components/schedule/agenda-track-filter-pills.tsx
'use client';

// Multi-select track filter pills for the Timeline view's top bar. Color
// dot + track name per pill (per the approved spec); controlled component,
// no internal state -- the parent (SessionsGridClient/BrowseGridClient)
// owns the selected-track-id Set and passes it down, same lift-state-up
// shape as every other control on these pages.
export interface AgendaTrackFilterOption {
  id: string;
  name: string;
  color: string;
}

export function AgendaTrackFilterPills({
  options,
  selectedIds,
  onToggle,
  onClear,
  allLabel,
}: {
  options: AgendaTrackFilterOption[];
  /** Empty set means "no filter" (== show all), same as pressing allLabel. */
  selectedIds: Set<string>;
  onToggle: (trackId: string) => void;
  onClear: () => void;
  allLabel: string;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={onClear}
        className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
          selectedIds.size === 0
            ? 'border-turquoise bg-turquoise/10 text-turquoise'
            : 'border-charcoal/20 text-charcoal/60 hover:text-charcoal dark:border-gray-700 dark:text-gray-400'
        }`}
      >
        {allLabel}
      </button>
      {options.map((opt) => {
        const active = selectedIds.has(opt.id);
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onToggle(opt.id)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              active ? 'border-turquoise bg-turquoise/10 text-turquoise' : 'border-charcoal/20 text-charcoal/60 hover:text-charcoal dark:border-gray-700 dark:text-gray-400'
            }`}
          >
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: opt.color }} />
            {opt.name}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Write `agenda-search-bar.tsx`**

```tsx
// src/components/schedule/agenda-search-bar.tsx
'use client';

// Search input + result counter for the Timeline view's top bar.
// Controlled component -- the parent owns the query string and the
// already-filtered count, same pattern as the other Timeline controls.
import { Input } from '@/components/ui/input';

export function AgendaSearchBar({
  value,
  onChange,
  placeholder,
  resultCount,
  resultCountLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  resultCount: number;
  /** A next-intl-resolved string like "12 sessions" / "12 جلسة" -- the
      caller resolves pluralization via t(), this component just renders it. */
  resultCountLabel: string;
}) {
  return (
    <div className="flex flex-1 items-center gap-3">
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="max-w-xs"
        aria-label={placeholder}
      />
      <span className="shrink-0 text-xs text-charcoal/50 dark:text-gray-400">{resultCountLabel}</span>
    </div>
  );
}
```

This imports the shared `Input` component from
`src/components/ui/input.tsx` (added in the separate Input/Select
unification work already merged to `master` before this plan was written
-- confirm it exists at that path before starting; if the unification
branch hasn't been merged yet, use a raw `<input>` with equivalent classes
as a temporary stand-in and leave a one-line comment to swap it once
merged).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "agenda-track-filter-pills|agenda-search-bar"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/components/schedule/agenda-track-filter-pills.tsx src/components/schedule/agenda-search-bar.tsx
git commit -m "feat: add track-filter pills and search bar for the timeline top bar"
```

---

## Task 5: `agenda-timeline.tsx` shared presentational component

**Files:**
- Create: `src/components/schedule/agenda-timeline.tsx`

This is the Timeline-view equivalent of `agenda-time-grid.tsx`. No
`'use client'` (plain data in, plain markup out, same reasoning as
`AgendaTimeGrid`). Takes a `renderCard` render-prop that -- per this
session's hard-learned RSC-boundary lesson -- must only ever be
constructed and consumed entirely within a `'use client'` wrapper
(Task 6/7), never passed in from a Server Component.

- [ ] **Step 1: Write the component**

```tsx
// src/components/schedule/agenda-timeline.tsx
//
// Shared vertical-timeline chrome for the admin Sessions page and the
// participant Browse Sessions page, alongside AgendaTimeGrid (the original
// grid view). Pure presentational: groups sessions into timeline rows via
// computeTimelineLayout, renders the hour axis and row structure, never
// the business logic of what's INSIDE a card -- that's the `renderCard`
// render-prop, same separation of concerns as AgendaTimeGrid's
// `renderBlock`.
//
// No 'use client': positions/grouping are computed from plain data, same
// reasoning as AgendaTimeGrid and MountReveal -- nothing here is
// interactive or needs a browser API.
//
// RTL: hour labels sit at the inline-start edge via logical CSS properties
// (start-0, border-e, pe-2, text-end) -- NEVER left/right/ms-/me- physical
// utilities -- matching agenda-time-grid.tsx's own convention, since this
// app supports Arabic as a locale.
import { computeTimelineLayout, type TimelineInputSession } from '@/lib/schedule/timeline-layout';

export interface AgendaTimelineSession extends TimelineInputSession {
  // Caller-defined shape carried through untouched to renderCard -- this
  // component never reads session fields beyond TimelineInputSession's
  // id/startTime/endTime/isBreak.
}

const HOUR_LABEL_WIDTH_PX = 56;

function defaultFormatHourLabel(minutesSinceMidnight: number): string {
  const h = Math.floor(minutesSinceMidnight / 60) % 24;
  const suffix = h < 12 ? 'AM' : 'PM';
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  return `${displayHour}${suffix}`;
}

export function AgendaTimeline<TSession extends AgendaTimelineSession>({
  sessions,
  renderCard,
  emptyState,
  formatHourLabel = defaultFormatHourLabel,
}: {
  /** Must already be scoped to a single conference day -- see
      timeline-layout.ts's header comment for why. */
  sessions: TSession[];
  /** `sessionsInRow` are the original (untouched) session objects sharing
      this row's start time, in input order -- a caller renders one card
      per entry, laid out side-by-side (flex-wrap) for concurrent sessions. */
  renderCard: (sessionsInRow: TSession[], isBreak: boolean) => React.ReactNode;
  emptyState?: React.ReactNode;
  formatHourLabel?: (minutesSinceMidnight: number) => string;
}) {
  if (sessions.length === 0) {
    return emptyState ?? null;
  }

  const rows = computeTimelineLayout(sessions);
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  return (
    <div className="flex flex-col divide-y divide-charcoal/10 rounded-lg border border-charcoal/10 dark:divide-gray-700 dark:border-gray-700">
      {rows.map((row) => {
        const rowSessions = row.sessionIds.map((id) => sessionById.get(id)!).filter(Boolean);
        return (
          <div key={row.startMinutes} className="flex gap-3 p-3">
            <div className="shrink-0 text-end text-xs text-charcoal/50 dark:text-gray-500" style={{ width: HOUR_LABEL_WIDTH_PX, paddingInlineEnd: 8 }}>
              {formatHourLabel(row.startMinutes)}
            </div>
            <div className="flex flex-1 flex-wrap gap-2">
              {renderCard(rowSessions, row.isBreak)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep agenda-timeline`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/components/schedule/agenda-timeline.tsx
git commit -m "feat: add AgendaTimeline shared vertical-timeline component"
```

---

## Task 6: Wire Timeline view into the participant Browse page

**Files:**
- Modify: `src/app/[locale]/(participant)/(shell)/my-agenda/browse/page.tsx`
- Modify: `src/app/[locale]/(participant)/(shell)/my-agenda/browse/browse-grid-client.tsx`
- Modify: `src/messages/en.json`, `src/messages/ar.json`

This page already has day tabs (`activeIndex` state) -- Timeline view
reuses that same state, so no new day-selection concept is needed here
(unlike Task 7's admin page).

- [ ] **Step 1: Extend `page.tsx`'s session query**

In the existing `sessions` query (around line 31-49), add
`session_types ( code )` alongside the existing `session_types (
enable_waitlist )` join -- merge into one join object:
`session_types ( code, enable_waitlist )`. Add `session_people (
people ( full_name_en, full_name_ar ) )` as a new joined relation for the
Timeline search-by-speaker feature (spec's "Top bar" section).

Add `legendItems`-adjacent per-day track options for the filter pills: the
page already computes `distinctTracksForLegend` per day group for the
color legend -- reuse that exact same array as the `AgendaTrackFilterPills`
options prop (same `{id, name, color}` shape), no new query needed.

In the `dayData: BrowseDayData[]` map (around line 142-185), add two new
fields per session:

```typescript
isBreak: s.session_types?.code === 'BRK',
speakerNames: (s.session_people ?? []).map((sp: { people: { full_name_en: string; full_name_ar: string } | null }) =>
  locale === 'ar' ? sp.people?.full_name_ar : sp.people?.full_name_en
).filter((n: string | undefined): n is string => Boolean(n)),
```

- [ ] **Step 2: Extend `BrowseDayData`/`BrowseSessionBlockData` in `browse-grid-client.tsx`**

Add `isBreak: boolean` and `speakerNames: string[]` to
`BrowseSessionBlockData`. No change to `BrowseDayData` itself beyond what
Task 1-5's new components need (track filter options already flow through
the existing `legendItems` field -- reuse it, don't duplicate it).

- [ ] **Step 3: Add view/filter/search state and the view-conditional render**

In `BrowseGridClient`, add:

```typescript
const [view, setView] = useState<AgendaView>('grid');
const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set());
const [query, setQuery] = useState('');
```

Derive the filtered session list for Timeline view (Grid view is
unaffected -- it keeps using `activeDay.sessions` exactly as today):

```typescript
const filteredSessions = activeDay.sessions.filter((s) => {
  if (selectedTrackIds.size > 0 && !selectedTrackIds.has(s.trackColumnId /* see note below */)) return false;
  if (query.trim()) {
    const q = query.trim().toLowerCase();
    const titleMatch = s.title.toLowerCase().includes(q);
    const speakerMatch = s.speakerNames.some((n) => n.toLowerCase().includes(q));
    if (!titleMatch && !speakerMatch) return false;
  }
  return true;
});
```

**Note on `trackColumnId`:** `BrowseSessionBlockData` currently carries
`roomId` (the Grid view's column key) but NOT a separate `trackId` field --
`blockColor` is derived from the track but the id itself isn't threaded
through. Add `trackId: string` to `BrowseSessionBlockData` in `page.tsx`'s
map (it's already available as `s.track_id` on the raw row) and to the
interface in `browse-grid-client.tsx`, so track-filter pills can match
against it. This is a small additive field, not a restructuring.

Render `AgendaViewToggle` next to the existing zoom controls. When
`view === 'timeline'`, render `AgendaTrackFilterPills` +
`AgendaSearchBar` + `AgendaTimeline` instead of the zoom controls +
`AgendaTimeGrid`; when `view === 'grid'`, render exactly what's there
today, completely unchanged.

The Timeline `renderCard` is defined inline inside this same `'use
client'` component (legal -- see this file's own header comment on why a
function defined and consumed entirely within one client component's own
render never crosses the RSC boundary):

```tsx
renderCard={(sessionsInRow, isBreak) => sessionsInRow.map((s) => (
  <div
    key={s.id}
    className={isBreak
      ? 'flex-1 border-s-2 border-charcoal/20 py-1 ps-2 text-xs text-charcoal/50 dark:border-gray-700 dark:text-gray-500'
      : 'flex min-w-[220px] flex-1 flex-col gap-1 rounded-md border border-charcoal/10 bg-warm-white p-2 dark:border-gray-700 dark:bg-gray-900'}
  >
    {!isBreak && (
      <span className="flex items-center gap-1.5 text-[10px] font-medium text-charcoal/60 dark:text-gray-400">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.blockColor }} />
        {/* track name -- resolve via the same legendItems/trackFilterOptions array by s.trackId */}
      </span>
    )}
    <span className="text-sm font-semibold">{s.title}</span>
    {!isBreak && (
      <div className="mt-auto">
        {s.alreadyBooked ? (
          <span className="text-[10px] font-medium">✓ Booked</span>
        ) : s.showWaitlistButton ? (
          <WaitlistButton sessionId={s.id} isWaitlisted={s.isWaitlisted} isPastDeadline={s.isPastDeadline} compact />
        ) : (
          <BookButton sessionId={s.id} isFull={s.isFull} isPastDeadline={s.isPastDeadline} compact />
        )}
      </div>
    )}
  </div>
))}
```

Note: `compact` is passed WITHOUT `compactTextColor` here -- per the
spec's clarification, Timeline cards have a neutral (non-track-colored)
background, so the button should use its default white-on-nothing... wait,
default is white text, which is wrong on a neutral/light card background.
**Correction needed during implementation:** since the card background here
is `bg-warm-white` (light), the compact button's default `compactTextColor
= '#ffffff'` (white) would be unreadable. Either pass an explicit dark
`compactTextColor` (e.g. `'#1a1a1a'` matching `--color-charcoal`) or check
whether `BookButton`/`WaitlistButton`'s compact mode has a non-white
option already -- if not, this is a one-line prop addition
(`compactTextColor="#1a1a1a"` or similar), not a new component. Verify
visually in the browser (Task 8) before considering this card style done.

Expand-on-click: wrap the card in a `useState`-driven expand toggle (one
`expandedId: string | null` in the parent, or a small local component if
preferred) that reveals the description when expanded. Keep this simple --
a single `expandedId` string in `BrowseGridClient` state, toggled on card
click (not on the Book/Waitlist button, which already calls
`stopPropagation` internally per `booking-button.tsx`'s compact-mode
handlers).

- [ ] **Step 4: Add translation keys**

Add to `src/messages/en.json`'s `agenda.sessions` (or a new shared
`agenda.timeline` namespace if cleaner -- match whichever existing
structure this page's translations already use) and the matching
`src/messages/ar.json` keys: `view.grid`, `view.timeline`, `search.placeholder`,
`search.resultCount` (with `{count}` ICU plural if the codebase's existing
i18n setup supports it -- check an existing pluralized key like `pageOf`
for the pattern), `filters.allTracks`.

- [ ] **Step 5: Typecheck, lint, test, build**

```bash
npx tsc --noEmit
npx eslint src/app/\[locale\]/\(participant\)/\(shell\)/my-agenda/browse/ src/components/schedule/
npx vitest run tests/schedule/
npm run build
```

All must pass with zero new errors. The full build is non-negotiable here
given this session's prior RSC-boundary production outage.

- [ ] **Step 6: Commit**

```bash
git add src/app/\[locale\]/\(participant\)/\(shell\)/my-agenda/browse/ src/messages/en.json src/messages/ar.json
git commit -m "feat: add Timeline view to the participant Browse Sessions page"
```

---

## Task 7: Wire Timeline view into the admin Sessions page

**Files:**
- Modify: `src/app/[locale]/(admin)/agenda/sessions/page.tsx`
- Modify: `src/app/[locale]/(admin)/agenda/sessions/sessions-grid-client.tsx`
- Modify: `src/messages/en.json`, `src/messages/ar.json`

This page has NO day-tab concept today (`SessionsGridClient` maps over all
`dayGroups` stacked, unconditionally) and is server-side paginated
(`PAGE_SIZE = 50`, `?page=` query param) -- two things Task 6's page
didn't have to deal with. Handle both explicitly:

**Pagination caveat:** Timeline/Grid view both operate on whatever one
page of sessions the server already returned (same as today) -- Timeline
view does NOT attempt to fetch all pages at once. This matches the
existing Grid view's own behavior (it only ever renders the current
page's sessions) and keeps this task additive rather than a pagination
redesign. If a conference day's sessions span more than one page, Timeline
view (like Grid view today) will only show the sessions on the current
page -- acceptable since this is a pre-existing limitation, not a
regression introduced by this feature.

- [ ] **Step 1: Extend `page.tsx`'s session query**

Add `session_type:session_types(code)` and `session_people (people
(full_name_en, full_name_ar))` to the existing `.select(...)` string
(around line 86-88). Add `trackId` tracking for filter pills -- `tracks`
is already fetched in full (line 79) with `color`, reuse it directly as
`AgendaTrackFilterPills` options (no new query).

In the `dayGroupData` map (around line 232-249), add:

```typescript
isBreak: s.session_type?.code === 'BRK',
trackId: s.track_id,
speakerNames: (s.session_people ?? []).map((sp) => locale === 'ar' ? sp.people?.full_name_ar : sp.people?.full_name_en).filter((n): n is string => Boolean(n)),
```

- [ ] **Step 2: Add `activeDayIndex` state to `SessionsGridClient`**

```typescript
const [activeDayIndex, setActiveDayIndex] = useState(0);
```

This state is **local to Timeline view and irrelevant to Grid view** --
per the approved spec, Grid view keeps rendering every `dayGroups` entry
stacked, unconditionally, exactly as it does today (the existing `.map()`
over `dayGroups` at line ~100 is untouched). When `view === 'timeline'`,
render day tabs (same markup/behavior as `BrowseGridClient`'s existing day
tabs -- copy that pattern) driving `activeDayIndex`, and render only
`dayGroups[Math.min(activeDayIndex, dayGroups.length - 1)]` through
`AgendaTimeline`.

- [ ] **Step 3: Add view/filter/search state, mirroring Task 6 exactly**

Same `view`/`selectedTrackIds`/`query` state shape as
`BrowseGridClient`. Filtered-sessions derivation same pattern, scoped to
the active day group only.

`renderCard` for the admin page differs from Task 6's in two ways: (a) it
shows the status chip (reuse the exact `color-mix`-based chip markup
already in this file's existing `renderBlock`, just moved into the new
`renderCard`), and (b) click-to-expand does NOT navigate to the session
detail page (per spec, Timeline's card click always expands in place on
both pages) -- this differs from Grid view's block click, which still
navigates via `<Link>` exactly as today. Do not change Grid view's
navigate-on-click behavior.

```tsx
renderCard={(sessionsInRow, isBreak) => sessionsInRow.map((s) => (
  <div
    key={s.id}
    role="button"
    tabIndex={0}
    onClick={() => setExpandedId((cur) => (cur === s.id ? null : s.id))}
    className={isBreak
      ? 'flex-1 border-s-2 border-charcoal/20 py-1 ps-2 text-xs text-charcoal/50 dark:border-gray-700 dark:text-gray-500'
      : 'flex min-w-[220px] flex-1 cursor-pointer flex-col gap-1 rounded-md border border-charcoal/10 bg-warm-white p-2 dark:border-gray-700 dark:bg-gray-900'}
  >
    {!isBreak && (
      <span className="flex flex-wrap items-center justify-between gap-1">
        <span className="flex items-center gap-1.5 text-[10px] font-medium text-charcoal/60 dark:text-gray-400">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.blockColor }} />
          {s.sessionCode}
        </span>
        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `color-mix(in srgb, ${chipTextColor} 18%, transparent)`, color: chipTextColor }}>
          {s.statusLabel}
        </span>
      </span>
    )}
    <span className="text-sm font-semibold">{s.titleEn}</span>
    {expandedId === s.id && !isBreak && (
      <div className="mt-1 text-xs text-charcoal/60 dark:text-gray-400">
        {/* speaker names, room, etc. -- expanded detail per spec */}
      </div>
    )}
  </div>
))}
```

Where `chipTextColor` is computed via `pickReadableTextColor(blockColor)`
per-card (same function already imported in `agenda-time-grid.tsx`, import
it here too) -- the chip itself is colored even though the card body isn't,
per the spec's clarification on `readable-text-color.ts`'s scope.

- [ ] **Step 4: Add translation keys**

Same as Task 6 Step 4, admin-specific namespace/strings (likely reusing
the exact same `agenda.sessions.view.*`/`search.*` keys Task 6 adds, if
both pages share the `agenda.sessions` namespace already -- check before
duplicating).

- [ ] **Step 5: Typecheck, lint, test, build**

```bash
npx tsc --noEmit
npx eslint src/app/\[locale\]/\(admin\)/agenda/sessions/ src/components/schedule/
npx vitest run tests/schedule/
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/app/\[locale\]/\(admin\)/agenda/sessions/ src/messages/en.json src/messages/ar.json
git commit -m "feat: add Timeline view to the admin Sessions page"
```

---

## Task 8: Manual browser verification

No automated test can verify visual RTL correctness, mobile layout, or the
Book/Waitlist click-vs-expand interaction end-to-end. Per this project's
established practice (`superpowers:run` skill / CLAUDE.md UI-testing
guidance), start the dev server and manually check:

- [ ] Toggle Grid ⇄ Timeline on both pages; confirm the choice persists
      after a hard refresh (localStorage).
- [ ] Switch the app to Arabic (`/ar/...`); confirm hour labels sit on the
      correct (start/right-in-RTL) side, not the LTR-left side.
- [ ] Click a track filter pill; confirm only that track's sessions show;
      confirm "All" clears the filter.
- [ ] Search by a known session title substring and by a known speaker's
      name; confirm the result counter updates correctly.
- [ ] On the participant page: click a card to expand it; click Book/Join
      waitlist inside a card; confirm the click does NOT also toggle the
      card's expand state (the `compact` button's existing
      `stopPropagation` should already guarantee this -- verify it live).
- [ ] On the admin page: click a card to expand it; confirm it does NOT
      navigate away (unlike Grid view's block click, which still does).
- [ ] Resize to a mobile viewport; confirm the single-column layout and
      that hour labels don't overlap card content.
- [ ] Confirm a real Break session (e.g. "Coffee Break", session_code
      D1-13) renders in the lighter/muted break style, not as a normal
      card.

Report findings; fix any visual issues found before moving to final review.

---

## Final steps

After Task 8 passes:

1. Dispatch a final code-reviewer subagent for the entire branch diff
   (per `superpowers:subagent-driven-development`'s "Final code review"
   step) -- NOT per-task, one pass over everything.
2. Use `superpowers:finishing-a-development-branch` to verify the full
   test suite, then present the merge/PR/keep/discard options to the user.
