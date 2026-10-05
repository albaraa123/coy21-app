# Live Operations Dashboard (5a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a live-updating, no-refresh-needed operations dashboard for staff to monitor conference-day attendance: per-session occupancy, full/near-full alerts, scanner-device staleness, and rejection-rate monitoring — the first use of Supabase Realtime in this codebase.

**Architecture:** One aggregate RPC (`ops_dashboard_snapshot()`) computes every number the dashboard needs, server-side, reusing the existing `session_effective_occupied_count()`/`is_staff()` helpers. A lightweight trigger on `attendance_records`/`scan_attempts` broadcasts a coarse "something changed" signal over a Realtime channel; the client never receives row data over Realtime, only a cue to re-invoke the snapshot RPC. A 30-second poll runs alongside Realtime as a silent-disconnect safety net.

**Tech Stack:** Next.js (App Router, Server + Client Components), Supabase Postgres (migrations, PL/pgSQL, Realtime broadcast), `@supabase/supabase-js` Realtime client, Vitest (live integration tests against the scratch Supabase project), next-intl.

**Spec:** `docs/superpowers/specs/2026-10-05-ops-dashboard-design.md` — read this first; it has the full rationale for every decision below, including two review rounds' worth of fixes already incorporated into its SQL (corrected RLS justification, `count(distinct ...)` fix, room-vs-session staleness scoping fix).

---

### Task 0: Realtime broadcast spike (must run before anything else)

**Files:**
- Create (temporary, deleted by end of this task): `supabase/migrations/20261006070000_realtime_spike_temp.sql`
- Create (temporary, deleted by end of this task): `scripts/realtime-spike.mjs` (or a throwaway Vitest file — implementer's choice, whichever is faster to run once)

The spec flags `realtime.send(...)` as unverified against this project's actual Supabase/Realtime extension version. This task's entire purpose is to resolve that uncertainty BEFORE any other code is written — if the assumption is wrong, every other task's design changes.

- [ ] **Step 1: Write a throwaway broadcast migration**

```sql
-- 20261006070000_realtime_spike_temp.sql (TEMPORARY -- delete after this task)
create or replace function realtime_spike_test() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(
    jsonb_build_object('spike', true),
    'spike-event',
    'ops-dashboard-spike',
    false
  );
end;
$$;

grant execute on function realtime_spike_test() to authenticated;
```

Run: `SUPABASE_ACCESS_TOKEN=sbp_fc74787c8d47c3706fe5c10e393533ca334e3049 npx supabase db push`. If this fails with a function-not-found error on `realtime.send`, STOP — read Supabase's current docs/changelog for this project's Postgres version to find the actual broadcast function name (it may be `realtime.broadcast_changes`, a direct `insert into realtime.messages`, or something else), rewrite this spike with the correct call, and retry. Do not proceed to Step 2 until a broadcast call of SOME kind succeeds against the live project.

- [ ] **Step 2: Confirm a subscribed client receives the broadcast**

Write a tiny throwaway script (or a one-off Vitest test, deleted at the end of this task) that:
1. Opens a Supabase client, subscribes to channel `'ops-dashboard-spike'` with `.on('broadcast', { event: 'spike-event' }, (payload) => { ... })`.
2. Calls `realtime_spike_test()` via RPC from a second client (or the same one).
3. Asserts the broadcast payload arrives within a few seconds.

```ts
import { createClient } from '@supabase/supabase-js';
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
let received = false;
const channel = client.channel('ops-dashboard-spike');
channel.on('broadcast', { event: 'spike-event' }, (payload) => {
  console.log('RECEIVED:', payload);
  received = true;
});
await channel.subscribe();
await new Promise((r) => setTimeout(r, 1000)); // let subscription settle
await client.rpc('realtime_spike_test' as never);
await new Promise((r) => setTimeout(r, 3000)); // wait for the broadcast
console.log(received ? 'SPIKE SUCCEEDED' : 'SPIKE FAILED -- no broadcast received');
process.exit(received ? 0 : 1);
```

Run it: `node scripts/realtime-spike.mjs` (or `npx vitest run` if written as a test). If it fails, this is a hard blocker — report BLOCKED with the exact error, do not guess at a fix, and do not proceed to any other task in this plan until a human or a follow-up investigation resolves it. The spec's entire Realtime architecture (scope decisions 3-5) depends on this working.

- [ ] **Step 3: Clean up and record the confirmed API shape**

Once Step 2 succeeds: delete the temporary migration file, run a corresponding `drop function if exists realtime_spike_test();` against the live project via `npx supabase db query --linked` (or include the drop in a tiny follow-up migration if the CLI's migration-tracking makes a bare delete-and-forget unsafe — check `supabase migration list` to confirm the temp migration can be cleanly removed from history, since this project's CLI tracks migrations by filename, not content, per prior sub-projects' experience), delete the throwaway script. **If a follow-up drop-migration file was created to perform the cleanup**: after confirming via `supabase migration list` that the project's migration history is clean (the spike function's creation and removal both fully reconciled, nothing left half-applied), delete that drop-migration file too — it served its one-time purpose and shouldn't be committed either, same as the spike migration itself. Write down the EXACT confirmed working call shape (function name, argument order, argument types) as a comment at the top of Task 1's migration file in this plan (edit this plan document itself if the shape differs from what Task 1 assumes below) so Task 1's implementer doesn't have to rediscover it.

- [ ] **Step 4: Commit**

Only the plan-document edit (if the confirmed shape differs from the assumption) and nothing else — all spike files must be deleted, not committed. Verify with `git status` that no stray temp files remain before moving to Task 1.

```bash
git status  # must show no new/modified files from the spike itself
```

---

### Task 0.5: Fix pre-existing drift in `tests/lib/nav/nav-config.test.ts` — ALREADY DONE

**Files:**
- Modified: `tests/lib/nav/nav-config.test.ts`

**This was a prerequisite fix, independent of the ops dashboard feature itself** — discovered during this plan's own review when a reviewer ran the test suite and found it already red on `master`, unrelated to anything this plan touches. `tests/lib/nav/nav-config.test.ts` was last synced with the real route tree at "Phase 5.5 Task 4 (2026-07-28)" (per its own header comment) and had drifted out of sync with several pieces of work since then. It was fixed and verified green (14/14 tests pass, `npx tsc --noEmit` and `npx eslint tests/lib/nav/nav-config.test.ts` both clean) directly during plan review, rather than left as a prescriptive future step — a second review round (after an initial attempt that only covered 2 of the actual failure modes) found the drift was deeper than first assessed, so the full fix is recorded here for reference rather than as instructions to re-derive.

**What was actually wrong and how it was fixed** (for context — this task is DONE, no further action needed before Task 1):

1. `ADMIN_VERIFIED_ROUTES` was missing `/attendance/walk-in`, `/staff`, `/staff/assignments`, `/settings` (all real, rendered sidebar routes added by work since the list was last synced) — added.
2. `PARTICIPANT_VERIFIED_ROUTES` was missing `/schedule` (real, defined in `participant-nav-config.ts`) — added.
3. The group-count test asserted 6 groups with a stale label sequence (`nav.groups.schedulePublication`, which doesn't exist in the real config — the real 3rd group is `nav.groups.allocation`); the real config has 7 groups including `staff` and `settings`, added since the test was last synced — corrected to 7 groups with the real `labelKey` sequence.
4. The Attendance-group hrefs test was missing `/attendance/walk-in` in its `.toEqual([...])` array — corrected.
5. **A deeper, initially-missed category of drift**: several real, fully-built admin pages were never rendered as their own sidebar `NavItem`s, because they're reachable only by clicking through from a hub/landing page or another page's body — the SAME relationship `ADMIN_DETAIL_ONLY_ROUTES` already modeled for dynamic-segment detail routes, just never extended to cover non-dynamic-segment click-through-only pages. Found by actually running the suite after fixes 1-4 and iterating on each newly-surfaced failure rather than assuming the first visible failure was the only one (the test's `for` loop throws on the first bad assertion, so later failures in the same loop were invisible until earlier ones were fixed). The full set, each verified by reading its actual page file and confirming where it's actually linked from:
   - `/agenda` (hub page; its own body links to `/agenda/session-types`, `/agenda/tags`, among others)
   - `/agenda/session-types`, `/agenda/tags` (both real pages, reachable only via click-through from `/agenda`)
   - `/allocation` (hub page; its own body links to `/allocation/clustering`, `/allocation/extraction`)
   - `/allocation/clustering`, `/allocation/extraction` (both real pages, reachable only via click-through from `/allocation`)
   - `/allocation/schedules/changed` (real page, linked from `/allocation/schedules`'s own body)
   - `/participants` (no content of its own — transparently redirects to `/applications`)
   - `/participants/imports` (real page, linked from three cards on `/dashboard`)

   All 9 were added to `ADMIN_DETAIL_ONLY_ROUTES`, and that array's header comment was rewritten to describe both the dynamic-segment pattern and this click-through-only pattern (previously the comment claimed every entry contained a `[...]` token, which stopped being true). The test `'never renders a detail-only route...'`'s name was updated to stop implying the carve-out is exclusively about dynamic segments.

6. **A 4th review round, re-running an exhaustive route-by-route diff rather than trusting "14/14 pass" as proof of completeness, found a 10th instance of the exact same pattern**: `/agenda/sessions/new` (a real, staff-gated session-creation page, linked from `/agenda/sessions`'s own "new session" button — the same relationship its dynamic-segment sibling `/agenda/sessions/[id]` already has to that list page) was present in neither `ADMIN_VERIFIED_ROUTES` nor `ADMIN_DETAIL_ONLY_ROUTES`, giving it zero test coverage (not failing — simply invisible to the suite). Added to both arrays alongside `/agenda/sessions/[id]`. Re-confirmed 14/14 passing after this addition.

   That same review round also flagged 3 fully orphaned, unreachable pages (`/content/local-info`, `/local-info-hub` — a literal dead test stub, `/reports/local-info`) with zero inbound links anywhere in the app — these are pre-existing dead code, not nav-config drift in the same sense (the test can only validate routes someone tells it about; unreachable code has no nav entry to be missing), and are explicitly left out of this prerequisite fix's scope. Worth a separate cleanup, not a blocker here.

No new rendered `NavItem` was added for any of the 10 click-through-only routes found across all rounds — this task fixed the TEST file's accuracy only, not the sidebar's actual rendered contents, which is a separate product/UX decision outside this prerequisite fix's scope.

This task fixed ONLY what was needed to bring the test file current with the real, already-existing route tree — it did not add any new route, nav entry, or feature. Task 4 (later in this plan) adds the ops-dashboard entry on top of this now-correct, fully-verified baseline.

---

### Task 1: `ops_dashboard_snapshot()` RPC + Realtime broadcast triggers

**Files:**
- Create: `supabase/migrations/20261006071000_ops_dashboard_snapshot.sql`
- Test: `tests/attendance/ops-dashboard-live.test.ts` (created here)

Depends on Task 0 (needs the confirmed `realtime.send(...)` — or equivalent — call shape).

- [ ] **Step 1: Write the RPC migration**

Copy the full `ops_dashboard_snapshot()` SQL from the spec's Data Model section verbatim (`docs/superpowers/specs/2026-10-05-ops-dashboard-design.md`) — it already incorporates both review rounds' fixes (`count(distinct ...)`, the room-vs-session staleness scoping, the renamed `breakdown` alias). Do not rewrite it from scratch; copy it, then adjust ONLY the broadcast function call in the trigger (Step 2 below) to match whatever Task 0 confirmed.

- [ ] **Step 2: Write the broadcast trigger using Task 0's confirmed call shape**

```sql
create or replace function notify_ops_dashboard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send( -- or whatever Task 0 confirmed
    jsonb_build_object('session_id', coalesce(new.session_id, old.session_id)),
    'change',
    'ops-dashboard-events',
    false
  );
  return new;
end;
$$;

create trigger attendance_records_notify_ops_dashboard
  after insert or update on attendance_records
  for each row execute function notify_ops_dashboard();

create trigger scan_attempts_notify_ops_dashboard
  after insert on scan_attempts
  for each row execute function notify_ops_dashboard();
```

- [ ] **Step 3: Apply the migration**

Run: `SUPABASE_ACCESS_TOKEN=sbp_fc74787c8d47c3706fe5c10e393533ca334e3049 npx supabase db push`.

- [ ] **Step 4: Write the failing tests**

Create `tests/attendance/ops-dashboard-live.test.ts`, following the established live-test conventions (`runId`-suffixed fixtures, `vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 })`, dedicated room/session/applicant seeding per test, `afterAll` cleanup respecting FK order — model this file's structure on `tests/agenda/booking-rules-completion-live.test.ts`, the most recently-written live-test file in this codebase, reading it first for the exact helper-function conventions).

The 9 tests below cover spec Testing Requirements 1-6 exactly (requirement numbers noted in each `it(...)` comment below). Spec Testing Requirement 7 — a Realtime client receiving a broadcast event after a seeded insert — is deliberately NOT included in this automated suite; the spec itself defers it to manual verification, and that verification happens in Task 3 Step 3, not here. This is a documented, spec-sanctioned omission, not a gap — do not add a Realtime-assertion test to this file; there is no existing precedent anywhere in this codebase's test suite for asserting on a received Realtime/WebSocket event, and inventing one here would be out of scope for this task.

```typescript
describe('ops_dashboard_snapshot', () => {
  it('returns occupied_count/occupancy_pct matching session_effective_occupied_count exactly [spec req 1]', async () => {
    // seed a session with capacity 4, 2 active self-service bookings,
    // call both session_effective_occupied_count(sessionId) and
    // ops_dashboard_snapshot(), find this session's row in the
    // snapshot result, assert occupied_count matches and
    // occupancy_pct === round(100 * 2/4, 1) === 50.0
  });

  it('is_full is true exactly at capacity, false one below it [spec req 2]', async () => {
    // capacity 2, 1 booking -> is_full false; add a 2nd booking -> is_full true
  });

  it('is_near_full is true at the 90% threshold boundary [spec req 2]', async () => {
    // capacity 10, 9 bookings -> is_near_full true, is_full false
  });

  it('does not count a scanner twice when it has both a room-scoped and session-scoped assignment row [bonus coverage of the plan-review-caught double-count fix, not itself a spec req]', async () => {
    // seed one scanner_user_id with two scanner_assignments rows: one
    // room_id-scoped, one session_id-scoped, both matching the same
    // session; assert scanner_count === 1, not 2
  });

  it('flags a scanner stale after 15 minutes with no scan, not stale within 15 minutes [spec req 3]', async () => {
    // seed a scan_attempts row with created_at = now() - 20 minutes for
    // one scanner -> expect it counted in stale_scanner_count; seed
    // another with created_at = now() - 5 minutes for a different
    // scanner on the same session -> expect it NOT counted
  });

  it('does not flag a room-scoped scanner stale if it recently scanned a DIFFERENT session in the same room [bonus coverage of the room-vs-session scoping fix, not itself a spec req]', async () => {
    // two sessions in the same room, one scanner_assignments row scoped
    // to room_id only; seed a scan_attempts row against session A's id
    // within the last 15 minutes; assert the scanner is NOT counted
    // stale when checking session B's row in the snapshot
  });

  it('rejection_count_30m and rejection_breakdown exclude admitted-flavored results and age out scans older than 30 minutes [spec req 4]', async () => {
    // seed scan_attempts rows: one 'admitted' (should be excluded), one
    // 'invalid_qr' at now()-10min (should count), one 'duplicate' at
    // now()-40min (should be aged out); assert rejection_count_30m == 1
    // and rejection_breakdown == {"invalid_qr": 1}
  });

  it('rejects a non-staff caller with Not authorized [spec req 5]', async () => {
    // call ops_dashboard_snapshot() as a plain accepted-applicant client,
    // assert error.message contains 'Not authorized'
  });

  it('inserting attendance_records/scan_attempts rows does not error (broadcast trigger does not break normal writes) [spec req 6]', async () => {
    // a plain directBooking + attendance_records insert via the admin
    // client must still succeed with the new triggers attached --
    // regression check, not a new behavior
  });
});
```

Fill in each test body with real seeded fixtures and real RPC calls — the sketch above gives the scenario and assertion, not literal copy-paste code.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/attendance/ops-dashboard-live.test.ts`

Expected: all 9 tests PASS. If any fail, fix the migration (not the test) unless the test itself has a bug.

- [ ] **Step 6: Regenerate database types**

Run: `SUPABASE_ACCESS_TOKEN=sbp_fc74787c8d47c3706fe5c10e393533ca334e3049 npx supabase gen types typescript --linked`, diff against the current `src/types/database.ts` to confirm the diff is purely additive (the new `ops_dashboard_snapshot` RPC entry), then replace the file.

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint tests/attendance/ops-dashboard-live.test.ts`. Pre-existing unrelated errors in `tests/attendance/qr-issuance-reservation.test.ts`/`tests/attendance/qr-credentials-lifecycle-trigger.test.ts` are known and out of scope.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20261006071000_ops_dashboard_snapshot.sql tests/attendance/ops-dashboard-live.test.ts src/types/database.ts
git commit -m "feat: add ops_dashboard_snapshot RPC and Realtime broadcast triggers"
```

---

### Task 2: Dashboard page + client component (initial load, no live update yet)

**Files:**
- Create: `src/app/[locale]/(admin)/attendance/ops-dashboard/page.tsx`
- Create: `src/app/[locale]/(admin)/attendance/ops-dashboard/ops-dashboard-client.tsx`
- Modify: `src/messages/en.json`
- Modify: `src/messages/ar.json`

Depends on Task 1 (needs `ops_dashboard_snapshot()` live and typed). This task ships the page with a correct initial render; Realtime wiring is added in Task 3 so each task stays reviewable in isolation.

- [ ] **Step 1: Read the existing `demand/page.tsx` precedent in full**

Read `src/app/[locale]/(admin)/attendance/demand/page.tsx` completely before writing anything — match its auth-gate shape, its mobile-card/desktop-table dual-layout convention, and its next-intl usage exactly.

- [ ] **Step 2: Write `page.tsx`**

Server component. Same gate shape as `demand/page.tsx`: `createClient()` + `auth.getUser()` + redirect-if-unauthenticated, `createServiceRoleClient()` + `profiles.role` + `isStaffRole()` + `notFound()`. Fetch the initial snapshot via `supabase.rpc('ops_dashboard_snapshot')` (no `as never` cast needed once Task 1's type regeneration lands). Pass the result to `<OpsDashboardClient initialRows={...} />`.

- [ ] **Step 3: Write `ops-dashboard-client.tsx`**

Client component. For this task only: render the initial snapshot as a static view (no Realtime subscription yet — that's Task 3). Layout per the spec's UI section:
- A top "alerts" summary: lists every row where `is_full`, `is_near_full`, `stale_scanner_count > 0`, or `rejection_count_30m` exceeds some visible threshold (pick a simple, clearly-labeled threshold for "elevated" — e.g. `rejection_count_30m >= 5`; this doesn't need to be configurable, just visible and sensible).
- A per-session card grid below it (mobile cards + desktop table, mirroring `demand/page.tsx`'s dual-layout convention), each showing: title, room, an occupancy bar (green under 90%, amber 90%-99%, red at/over 100%), occupancy count/capacity text, a scanner-staleness badge if `stale_scanner_count > 0`, and a small rejection-count indicator.

- [ ] **Step 4: Add i18n keys**

Add a new top-level namespace (e.g. `"opsDashboard"`) to both `src/messages/en.json` and `src/messages/ar.json`, following the exact structure/style of the existing `"attendanceDemand"` namespace (title, description, column/label keys, empty-state keys). Write a natural, hand-quality Arabic translation — check `attendanceDemand`'s Arabic keys for register/style to match, not machine-translated-sounding phrasing.

- [ ] **Step 5: Self-review / manual verification**

Browser verification may not be practical in this environment. Do a careful code-level trace: confirm the auth gate matches `demand/page.tsx`'s exactly, confirm the RPC call has no stale-type cast, confirm the alert-summary logic correctly identifies every row needing attention, confirm the mobile/desktop dual layout renders the same data (no column present in one but not the other). State this trace explicitly in your report.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint "src/app/[locale]/(admin)/attendance/ops-dashboard/"`.

- [ ] **Step 7: Commit**

```bash
git add "src/app/[locale]/(admin)/attendance/ops-dashboard/" src/messages/en.json src/messages/ar.json
git commit -m "feat: add ops dashboard page with initial snapshot render"
```

---

### Task 3: Realtime subscription + fallback polling

**Files:**
- Modify: `src/app/[locale]/(admin)/attendance/ops-dashboard/ops-dashboard-client.tsx`

Depends on Task 2 (the static client component must exist first) and Task 0/1 (the confirmed broadcast channel/event names).

**Required implementation detail — a shared, monotonically-increasing request-id guard** (applies to both Step 1 and Step 2 below, since they are two independent call sites that can both have an RPC call in flight at once): keep a `useRef<number>(0)` request counter in the component. Every time either the debounced Realtime handler or the polling interval is about to call `ops_dashboard_snapshot()`, increment the counter and capture the new value as `thisRequestId`. When that call's response resolves, only call `setRows(...)` if `thisRequestId === requestIdRef.current` (i.e., no newer request has been issued since this one started) — otherwise discard the response silently. This is the fix, not a thing to merely check for in Step 3: without it, a slow-resolving poll response can land after a faster Realtime-triggered response and overwrite fresher data with stale data.

- [ ] **Step 1: Add the Realtime subscription**

In `ops-dashboard-client.tsx`, in a `useEffect` on mount: open a Supabase browser client (check how other client components in this codebase obtain one — e.g. `src/lib/supabase/client.ts` or similar; read an existing client component that already does this, like `scanner-client.tsx`'s pattern, for the exact import/instantiation convention), subscribe to the `ops-dashboard-events` broadcast channel with the event name Task 1 confirmed (`'change'` per the spec, unless Task 0/1 settled on something else — check Task 1's final migration for the actual values used). On any message: debounce ~1-2 seconds (a simple `setTimeout`/`clearTimeout` pattern is sufficient, no need for a library), then re-invoke `ops_dashboard_snapshot()` via RPC through the shared request-id-guarded fetch helper described above, and update state with the new rows only if the guard passes. Clean up the subscription (`channel.unsubscribe()`) on unmount.

- [ ] **Step 2: Add fallback polling**

In the same component, a second `useEffect` setting a `setInterval` at 30 seconds that also re-invokes the snapshot RPC through the SAME shared request-id-guarded fetch helper (independent of whether Realtime fired recently — simplicity over cleverness here; re-fetching slightly more often than strictly necessary is cheap and harmless for a page like this). Clear the interval on unmount.

- [ ] **Step 3: Manual verification or self-review**

If a local dev environment with a live Supabase connection is available, manually verify: open the dashboard in a browser, seed an `attendance_records` insert via a separate script/test, confirm the dashboard updates within a couple seconds without a manual refresh. This also satisfies the spec's Testing Requirement 7 (a Realtime client receiving a broadcast after a seeded insert) — the spec explicitly defers that requirement to manual verification rather than an automated live test, and this step is where that verification happens; note this explicitly in your task report rather than leaving it unstated. If live manual verification isn't practical in this environment, do a careful code-level trace instead: confirm the subscription is correctly opened/closed, confirm the debounce doesn't drop a re-invocation entirely (only delays it), and confirm the request-id guard from Steps 1/2 is actually wired into both call sites (not just one) — re-read both `useEffect`s side by side and verify neither bypasses the shared helper.

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint "src/app/[locale]/(admin)/attendance/ops-dashboard/"`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/(admin)/attendance/ops-dashboard/ops-dashboard-client.tsx"
git commit -m "feat: wire up Realtime live updates and fallback polling on ops dashboard"
```

---

### Task 4: Nav entry

**Files:**
- Modify: `src/lib/nav/admin-nav-config.ts`
- Modify: `src/messages/en.json`
- Modify: `src/messages/ar.json`
- Modify: `tests/lib/nav/nav-config.test.ts` — **required, not optional.** This file has a standing regression test that asserts an EXACT, literal array for the Attendance group's hrefs, plus a separate "no href outside the verified route list" test. Both will fail the moment this task's nav entry is added, unless this file is updated in the SAME commit. The file's own header comment says exactly this: "If you rename, add, or remove a route under the admin app directory, you MUST update this list (and the corresponding nav-config file) in the same change, or this test will fail."

Depends on Task 0.5 (this file must already be a correctly-passing baseline — matching the REAL current route tree, including `/attendance/walk-in` — before this task adds one more route on top of it; without Task 0.5, this task would be patching an already-broken/stale test and risk compounding the drift instead of fixing it) and Task 2 (the page must exist to link to).

- [ ] **Step 1: Add the nav entry**

In `src/lib/nav/admin-nav-config.ts`, in the existing Attendance group (alongside `scanners`, `admissions`, `walk-in`, `demand`), add a new entry: `{ labelKey: 'nav.attendance.opsDashboard', href: '/attendance/ops-dashboard', iconKey: 'dashboard' }`. Use `iconKey: 'dashboard'` — a real icon key defined in `src/lib/nav/icon-map.tsx`, not yet used by any entry WITHIN the Attendance group (`scanners` uses `attendance`, `admissions` uses `applications`, `walk-in` uses `qr`, `demand` uses `demand`). Note: `dashboard` IS already used elsewhere in the nav — by the top-level, ungrouped `/dashboard` item (`adminDashboardItem`). This means the ops-dashboard nav entry's icon will render identically to the top-level Dashboard link's icon. This is an accepted, known duplication (both are legitimately "dashboard"-flavored concepts), not a mistake to "fix" by picking a different icon — just don't be surprised when you see the same glyph twice in the sidebar.

- [ ] **Step 2: Add the nav label i18n key**

Add `"opsDashboard": "Ops Dashboard"` (en) / an appropriately natural Arabic equivalent (ar) under the existing `nav.attendance` key group in both message files.

- [ ] **Step 3: Update the nav regression tests**

In `tests/lib/nav/nav-config.test.ts` (now a correctly-passing baseline per Task 0.5):
1. Add `'/attendance/ops-dashboard'` to the `ADMIN_VERIFIED_ROUTES` array, alongside the now-present `'/attendance/scanners'`, `'/attendance/admissions'`, `'/attendance/walk-in'`, `'/attendance/demand'` entries (Task 0.5 already changed this file's line numbers from what an earlier draft of this plan assumed — read the file to find their actual current line numbers before editing, rather than trusting any number written here).
2. Update the test Task 0.5 renamed to include `/attendance/walk-in` — add `/attendance/ops-dashboard` to its `.toEqual([...])` array at whatever position Step 1 above inserted it into the actual nav config (the array must match the real insertion order exactly, not just contain the same items in any order — `.toEqual` on an array is order-sensitive), and update the test's description once more to also mention the new route.

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint src/lib/nav/admin-nav-config.ts tests/lib/nav/nav-config.test.ts`.

- [ ] **Step 5: Run the nav test suite to confirm it's green**

Run: `npx vitest run tests/lib/nav/nav-config.test.ts`. This MUST pass before committing — it is not part of Task 5's later sweep, it's this task's own regression gate, since Task 5 only broadly re-confirms what every task already should have left green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/nav/admin-nav-config.ts src/messages/en.json src/messages/ar.json tests/lib/nav/nav-config.test.ts
git commit -m "feat: add ops dashboard nav entry"
```

---

### Task 5: Full sweep and final review

**Files:**
- Modify: `tests/attendance/ops-dashboard-live.test.ts` (if any gaps found)

- [ ] **Step 1: Full relevant-suite run**

Run: `npx vitest run tests/attendance tests/agenda tests/lib/nav tests/program-attendance` (the broadcast triggers touch `attendance_records`/`scan_attempts`, which every scanner/admission/no-show test exercises; `tests/lib/nav` covers Task 0.5/4's nav-config regression tests — though both tasks' own gates should have already left these green, re-confirming here catches anything a later task accidentally broke; `tests/program-attendance` includes `demand-capacity-live.test.ts`, which directly reads `attendance_records.status='admitted'` rows — NOT `session_effective_occupied_count()`, which it does not call — making it a second, independent consumer of the same table this sub-project's broadcast trigger attaches to, worth a regression check even though it doesn't share the snapshot RPC itself).

- [ ] **Step 2: Full typecheck and lint**

Run: `npx tsc --noEmit` (compare any output against master's pre-existing baseline — verify via `git diff master -- <file>` that any file showing errors was genuinely untouched by this branch before dismissing it) and `npx eslint src/ tests/attendance/ops-dashboard-live.test.ts`.

- [ ] **Step 3: Dispatch a final whole-branch code-reviewer subagent**

Covering the full diff against `master`, cross-referencing the spec, with particular attention to: does the broadcast trigger's payload genuinely never leak attendance/applicant data (re-verify against the final trigger SQL, not just the spec's sketch); does `ops_dashboard_snapshot()`'s occupancy figure genuinely match `session_effective_occupied_count()` in every case the live tests cover; does the Realtime subscription correctly clean up on unmount (no leaked channel across navigations); is there any race between the debounced Realtime refetch and the 30-second poll that could show stale data overwriting fresh data.

- [ ] **Step 4: Proceed to `superpowers:finishing-a-development-branch`**

Push, create a PR (reusing the title/body pattern from prior sub-projects' PRs), await merge, clean up the worktree and branch.
