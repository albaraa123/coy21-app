# Agenda Vertical Timeline View — Design Spec

**Date:** 2026-10-31
**Status:** Approved by user. Passed spec-review round 2 (round 1 found
RTL hour-label bug, admin day-tabs data-flow ambiguity, localStorage
hydration-safety + key-naming convention, timeline-layout.ts single-day
precondition, readable-text-color.ts reuse scope — all fixed and
verified). Ready for implementation planning.

## Problem

The agenda currently has one view mode: a color-coded time-grid with room
columns and track-colored blocks (`AgendaTimeGrid`). The user wants a second,
user-selectable view mode — a vertical timeline, similar to a conventional
schedule/agenda list — as an alternative way to scan the same sessions. This
applies to both the admin Sessions page (`/agenda/sessions`) and the
participant Browse Sessions page (`/my-agenda/browse`).

Reference: a screenshot provided by the user showing a top bar (day tabs +
track filter pills + search + result counter) above a vertical list of
time-stamped session cards.

## Scope

Two independent implementations, one per page, each consuming the same
underlying session/track/room data each page already fetches server-side.
No new database queries beyond one additional join (session_people → people)
needed for the speaker/guest search field.

## View toggle

A small segmented control (Grid / Timeline) placed where each page's zoom
controls currently sit. `'use client'`, owns a `useState` for the active
view, persisted to `localStorage` under keys `coy21-admin-sessions-view-v1`
/ `coy21-browse-sessions-view-v1` (hyphenated, versioned — matching the
existing convention in `sidebar-nav-storage.ts`'s `STORAGE_KEY_ADMIN`
/`STORAGE_KEY_PARTICIPANT`, not the colon-delimited style used nowhere else
in this codebase). Purely a client-side preference — not synced
server-side, not shared between users.

**SSR-hydration safety**, matching `sidebar-nav.tsx`'s established pattern
exactly (see that file's own header comment for the full rationale): the
`useState` initial value is a fixed default (`'grid'`), never read from
`localStorage` during render. The actual stored preference is read inside a
`useEffect` that runs once after mount, then applied via `setState` — this
avoids a server/client markup mismatch, since the server has no
`localStorage` to read from. Read/write helpers follow
`sidebar-nav-storage.ts`'s split-into-a-pure-module convention (e.g.
`agenda-view-storage.ts`): framework-free functions taking a
`Pick<Storage, 'getItem'>`/`Pick<Storage, 'setItem'>`, wrapped in
try/catch, returning/ignoring silently on any failure (missing key,
malformed value, storage unavailable in private browsing) — view
preference is a pure UX nicety, never worth crashing the page over.

## Top bar (both pages, Timeline view only)

- **Day tabs.** The participant Browse page already has day tabs
  (`browse-grid-client.tsx`, `activeIndex` state). The admin Sessions page
  currently has no day-tab concept at all — `page.tsx` already produces
  `dayGroups: DayGroupData[]` (one entry per conference day, grouped by the
  real `conference_day_id` FK), but `sessions-grid-client.tsx` maps over
  *all* of them unconditionally, stacked, with a heading per group when
  there's more than one (`showDayHeading`).

  Timeline view introduces a new `activeDayIndex` state in
  `SessionsGridClient`, mirroring `BrowseGridClient`'s existing
  `activeIndex` pattern exactly (same `useState(0)`, same
  `Math.min(activeIndex, dayGroups.length - 1)` clamp). This state is
  **local to Timeline view and irrelevant to Grid view** — Grid view keeps
  rendering every `dayGroups` entry stacked, unconditionally, exactly as it
  does today, with no change to its own rendering logic. Switching the view
  toggle does not need to preserve or reset anything cross-view, since Grid
  has no day-selection concept to preserve in the first place. The
  `dayGroups` prop itself is unchanged — Timeline view just additionally
  picks one entry from the same array Grid already receives in full.
- **Track filter pills.** One pill per track: color dot + track name,
  multi-select (click toggles membership), plus an "All" pill that clears
  the selection. Pure client-side filtering of already-fetched data for the
  active day — no new query. Unselecting all effectively means "show all"
  (same as the "All" pill).
- **Search bar.** Filters the active day's (already track-filtered) sessions
  by: (a) session title, locale-aware (`title_en`/`title_ar`), and (b) any
  assigned speaker/guest's full name, locale-aware
  (`people.full_name_en`/`full_name_ar` via the `session_people` join).
  Client-side substring match, case-insensitive.
- **Result counter.** "X جلسة" / "X sessions" — the count of sessions
  visible after track-filter + search, for the active day only.

## Timeline body

- **Vertical axis:** hour labels at the **inline-start** edge (NOT a
  hardcoded "left") — this app supports Arabic as a locale and the
  existing `AgendaTimeGrid` deliberately uses CSS logical properties
  throughout (`start-0`, `border-s`/`border-e`, `pe-2`, `text-end`) so the
  hour column sits on the correct physical side automatically in both LTR
  and RTL. `AgendaTimeline` follows the exact same convention: logical
  properties only, never `left`/`right`/`ms-`/`me-`-style physical
  utilities, on both desktop and the mobile layout.

  Reuses the existing Istanbul-aware minute math already fixed in
  `grid-layout.ts` (no new timezone logic — this view needs only
  sorting/grouping by the same already-correct minute values, not
  pixel-accurate positioning).
- **Row grouping:** sessions sorted by start time; sessions sharing the same
  start time are grouped into the same row and laid out side-by-side
  (simple flex-wrap, not lane-packed pixel math like the grid — this view
  has no need for `assignLanes`' overlap-handling since cards aren't
  positioned by duration).
- **Session card (collapsed):** track color dot + track name, time range
  (e.g. "08:00 – 09:00"), room name, title. Unlike Grid view's blocks, a
  Timeline card's background is a neutral surface color (not filled with
  the track color), so `pickReadableTextColor` is NOT needed for the
  card's own body text (normal `text-charcoal`/dark-mode text tokens
  apply, same as any other card in this codebase). Admin cards also show
  the status chip — this chip IS still colored (small, track-colored or
  status-colored background), so it still needs
  `pickReadableTextColor(chipColor)` for its own text, same contrast-safe
  reasoning as `sessions-grid-client.tsx`'s existing chip, just scoped to
  the chip itself rather than the whole card. Participant cards always
  show the Book/Waitlist control (reusing `BookButton`/`WaitlistButton` in
  their existing `compact` mode, with `compactTextColor` left at its
  default since the card background is neutral, not track-colored).
- **Expand on click:** reveals additional detail (description, assigned
  speakers/guests where available) in place, no navigation. This differs
  from the Grid view's admin behavior (which navigates to the session detail
  page on block click) — Timeline view's click always expands in place on
  both pages.
- **Breaks:** rendered visually lighter — no track color fill, a thin
  left border only, muted text — distinguishing them from real sessions.
- **Mobile:** single column, hour labels remain at the inline-start edge
  (same logical-property convention as above) at reduced width; cards
  stack full-width.

## New files

- `src/lib/schedule/timeline-layout.ts` — pure function, no DOM/React.
  Takes the same `GridInputSession`-shaped rows (plus a `isBreak` flag,
  determined by the caller from `session_types`) already available to each
  page, groups them by identical start time into ordered rows, and
  separates breaks from regular sessions. Returns plain data. Independently
  unit-testable, mirroring `grid-layout.ts`'s existing convention.

  **Precondition, must be documented in the function's own header
  comment:** callers MUST pre-filter input to a single conference day
  before calling this function. `minutesSinceMidnightConferenceLocal` (the
  already-fixed Istanbul-aware conversion in `grid-layout.ts`, reused here)
  returns minutes-since-midnight with no date component — two sessions on
  *different* days at the same wall-clock time (e.g. both at 08:00
  Istanbul) produce identical start-minute values and would incorrectly
  group into the same row if passed together. This is safe in practice
  only because both call sites already scope Timeline input to one active
  day (via the `activeDayIndex`/`activeIndex` state described above) before
  calling `computeTimelineLayout` — the function itself has no day/date
  field in its input shape and cannot detect a caller's mistake, so the
  precondition must be explicit, not assumed.
- `src/components/schedule/agenda-timeline.tsx` — shared presentational
  component, no `'use client'` (plain data in, plain markup out, same
  reasoning as `AgendaTimeGrid`). Takes a `renderCard` render-prop, exactly
  like `AgendaTimeGrid`'s `renderBlock` — but per the RSC-boundary lesson
  learned earlier this session (a production outage from a Server Component
  passing a function prop into a `'use client'` component), this render-prop
  will only ever be constructed and consumed entirely within a `'use
  client'` wrapper component, never passed in from a Server Component.
- `src/components/schedule/agenda-view-toggle.tsx` — the Grid/Timeline
  segmented control. `'use client'`, reads/writes view preference via the
  helpers below, following `sidebar-nav.tsx`'s useEffect-only-read pattern
  (see "View toggle" section above).
- `src/components/schedule/agenda-view-storage.ts` — pure, framework-free
  `localStorage` read/write helpers for the view-toggle preference, split
  out for unit-testability exactly like `sidebar-nav-storage.ts` (DOM-free
  functions taking a `Pick<Storage, 'getItem'|'setItem'>`-shaped object,
  wrapped in try/catch, silent on failure).
- `src/components/schedule/agenda-track-filter-pills.tsx` — the track
  multi-select pills. `'use client'`.
- `src/components/schedule/agenda-search-bar.tsx` — the search input +
  result counter. `'use client'`.

## Modified files

- `src/app/[locale]/(admin)/agenda/sessions/page.tsx` — adds the
  `session_people → people` join for search; passes the enriched day-group
  data to `sessions-grid-client.tsx`.
- `src/app/[locale]/(admin)/agenda/sessions/sessions-grid-client.tsx` —
  gains the view toggle, day tabs (new for this page), track pills, search
  bar, and conditionally renders `AgendaTimeGrid` or `AgendaTimeline`.
- `src/app/[locale]/(participant)/(shell)/my-agenda/browse/page.tsx` — adds
  the same `session_people → people` join.
- `src/app/[locale]/(participant)/(shell)/my-agenda/browse/browse-grid-client.tsx`
  — gains the view toggle, track pills, search bar (day tabs already
  exist), and conditionally renders `AgendaTimeGrid` or `AgendaTimeline`.

## Explicitly out of scope

- No new server-side query beyond the one join; all filtering/search is
  client-side over already-fetched data.
- No change to the existing Grid view's behavior, layout, or files beyond
  adding the toggle control itself.
- No persistence of view-mode preference server-side or across devices.
- No drag-and-drop or editing from the Timeline view (admin editing stays
  on the existing session detail page, reached the same way Grid view
  reaches it — except Timeline's card-click expands in place instead of
  navigating, per the "Timeline body" section above).
