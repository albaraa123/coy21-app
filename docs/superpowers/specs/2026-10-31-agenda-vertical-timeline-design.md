# Agenda Vertical Timeline View — Design Spec

**Date:** 2026-10-31
**Status:** Approved by user, ready for implementation planning.

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
view, persisted to `localStorage` (key scoped per page, e.g.
`coy21:agenda-view:admin-sessions` / `coy21:agenda-view:browse-sessions`) so
a user's choice sticks across visits. Purely a client-side preference — not
synced server-side, not shared between users.

## Top bar (both pages, Timeline view only)

- **Day tabs.** The participant Browse page already has day tabs
  (`browse-grid-client.tsx`). The admin Sessions page currently renders all
  days stacked in Grid view; in Timeline view specifically, admin also
  switches to one-day-at-a-time via day tabs, to match the reference design
  and keep the timeline list a manageable length.
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

- **Vertical axis:** hour labels on the left, reusing the existing
  Istanbul-aware minute math already fixed in `grid-layout.ts` (no new
  timezone logic — this view needs only sorting/grouping by the same
  already-correct minute values, not pixel-accurate positioning).
- **Row grouping:** sessions sorted by start time; sessions sharing the same
  start time are grouped into the same row and laid out side-by-side
  (simple flex-wrap, not lane-packed pixel math like the grid — this view
  has no need for `assignLanes`' overlap-handling since cards aren't
  positioned by duration).
- **Session card (collapsed):** track color dot + track name, time range
  (e.g. "08:00 – 09:00"), room name, title. Admin cards also show the
  status chip (reusing the existing contrast-safe chip styling pattern from
  `sessions-grid-client.tsx`'s `renderBlock`). Participant cards always show
  the Book/Waitlist control (reusing `BookButton`/`WaitlistButton` in their
  existing `compact` mode).
- **Expand on click:** reveals additional detail (description, assigned
  speakers/guests where available) in place, no navigation. This differs
  from the Grid view's admin behavior (which navigates to the session detail
  page on block click) — Timeline view's click always expands in place on
  both pages.
- **Breaks:** rendered visually lighter — no track color fill, a thin
  left border only, muted text — distinguishing them from real sessions.
- **Mobile:** single column, hour labels remain on the left at reduced
  width; cards stack full-width.

## New files

- `src/lib/schedule/timeline-layout.ts` — pure function, no DOM/React.
  Takes the same `GridInputSession`-shaped rows (plus a `isBreak` flag,
  determined by the caller from `session_types`) already available to each
  page, groups them by identical start time into ordered rows, and
  separates breaks from regular sessions. Returns plain data. Independently
  unit-testable, mirroring `grid-layout.ts`'s existing convention.
- `src/components/schedule/agenda-timeline.tsx` — shared presentational
  component, no `'use client'` (plain data in, plain markup out, same
  reasoning as `AgendaTimeGrid`). Takes a `renderCard` render-prop, exactly
  like `AgendaTimeGrid`'s `renderBlock` — but per the RSC-boundary lesson
  learned earlier this session (a production outage from a Server Component
  passing a function prop into a `'use client'` component), this render-prop
  will only ever be constructed and consumed entirely within a `'use
  client'` wrapper component, never passed in from a Server Component.
- `src/components/schedule/agenda-view-toggle.tsx` — the Grid/Timeline
  segmented control. `'use client'`, owns the `localStorage` read/write
  (wrapped in try/catch per this session's established browser-storage
  convention — private browsing / blocked storage must not crash the page).
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
