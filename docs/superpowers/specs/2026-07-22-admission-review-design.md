# RCOY MENA 2026 — Phase 2: Admission Review Dashboard Design

**Date:** 2026-07-22
**Status:** Approved for planning

## Purpose

Give `registration_admission_manager` staff a working tool to manually review submitted conference applications and record admission decisions, per the operational spec's explicit rule that the platform never auto-decides admission — all accept/waitlist/reject decisions are human-made. This is Phase 2, building directly on Phase 1's foundation (five-role auth/RLS, `applications` schema, registration flow), which is complete and merged to `master`.

## Non-goals (explicitly out of scope for this phase)

- Excel/CSV bulk import or export of applications or decisions
- Bulk accept/reject actions (multi-select + apply-to-all)
- Automatic decision emails to applicants on status change (status changes only update the database and the audit trail in this phase; notification emails are a separate later feature)
- Clustering, session allocation, or anything from the post-admission phases of the operational spec
- Access for any role other than `registration_admission_manager` and `super_admin`
- Draft applications appearing anywhere in this dashboard — only `submitted` and later statuses are visible
- Setting `withdrawn` from this dashboard — Phase 1 deferred `withdrawn` entirely (no UI path reaches it), and Phase 2 does not add one either
- Reviewer-assignment history — only the *current* `assigned_reviewer_id` is tracked; reassigning or unassigning overwrites it with no audit trail (unlike status changes, which are logged)

## Tech Stack

Unchanged from Phase 1: Next.js App Router (`app/[locale]/...`), Supabase (Postgres/Auth/RLS), TypeScript, Tailwind. New work follows the same server-component + server-action + RLS pattern established in Phase 1 (see `submitApplication` in `src/app/[locale]/(participant)/register/actions.ts` as the reference pattern for status-changing server actions).

## Data Model

```sql
-- One reviewer assignment per application. References profiles (not a separate
-- reviewers table) since any registration_admission_manager can be assigned.
alter table applications add column assigned_reviewer_id uuid references profiles(id);

create index applications_status_idx on applications (status);
create index applications_assigned_reviewer_idx on applications (assigned_reviewer_id);

-- Internal review notes. Deliberately separate from application_status_history:
-- notes are free-form, staff-authored commentary (this phase treats them as
-- append-only — no edit/delete UI, matching history's audit-trail spirit, though
-- the table itself doesn't enforce immutability since notes aren't a formal
-- decision record); application_status_history is the fixed-shape status-transition
-- audit log from Phase 1 and is not modified by this phase.
create table application_notes (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  author_id uuid not null references profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);
```

### Row-Level Security

- `applications`: a new UPDATE policy grants `registration_admission_manager`/`super_admin` the ability to update `status` and `assigned_reviewer_id` on any application (using the same `current_user_role()` helper from Phase 1's RLS migration). This is additive — it does not change or replace the applicant's own `applications_update_own_draft` policy from Phase 1, which still only permits the applicant to update their own row while `status = 'draft'`. Unlike that policy, this one has **no `WITH CHECK` clause** — a deliberate choice: staff are a trusted role with legitimate latitude to set any valid status, so there is no lower-privileged-actor-smuggling-a-transition concern to guard against (the same reasoning Phase 1 used to justify `profiles_update_super_admin` also lacking `WITH CHECK`).

  **This policy exists for defense-in-depth and for any future direct/client-side staff tooling, but it is not the primary gate for the three server actions below.** Like `submitApplication` (Phase 1's reference pattern), `updateApplicationStatus`, `assignReviewer`, and `addNote` all write through `createServiceRoleClient()`, which bypasses RLS entirely — so RLS is not what stops an invalid status transition or an unauthorized write from these actions. The actual gate is each action's own explicit role check (authenticate the caller, verify their `profiles.role`) plus, for `updateApplicationStatus`, the state-machine validation described below. This mirrors Phase 1's own security model exactly: RLS protects direct client/PostgREST access (e.g. if a `registration_admission_manager`'s browser session ever queries `applications` directly), while server actions enforce their own authorization because they run with elevated (service-role) privileges by necessity — the same design already in place for `submitApplication`.
- `application_notes`: `registration_admission_manager`/`super_admin` get full SELECT/INSERT. No UPDATE/DELETE policy in this phase (no edit/delete UI, so no policy needed yet — matches Phase 1's "no policy = default-deny" pattern for `application_status_history`/`email_log`). No other role has any access. **As with the `applications` UPDATE policy above, the INSERT half is defense-in-depth, not the primary gate: `addNote` also writes via `createServiceRoleClient()`, so its own role check is what actually authorizes the write.** The SELECT half is different — the detail page's notes-thread read (see below) uses the regular server component client (`createClient()` from `src/lib/supabase/server.ts`, which respects RLS and the caller's session), the same client Phase 1's `register/page.tsx` and `my-application/page.tsx` use for their own reads. So this SELECT policy genuinely is the operative gate for who can read notes, not just a backstop.
- The existing `applications_select_staff` policy from Phase 1 already grants `registration_admission_manager` read access to all applications — reused as-is for both the list and detail pages' reads, which (like Phase 1's participant-facing pages) use the RLS-respecting server component client, not the service-role client. The service-role client is used only by the three server actions, which perform writes and need to bypass RLS to write across all applicants' rows, not by the pages themselves.

## Status State Machine

Applications reach this dashboard already in `submitted` (set by Phase 1's `submitApplication`). From there, this phase permits exactly these transitions via `updateApplicationStatus`:

```text
submitted ⇄ under_review
under_review → accepted
under_review → waitlisted
under_review → rejected
accepted ⇄ waitlisted
accepted ⇄ rejected
waitlisted ⇄ rejected
```

Concretely: `under_review` is reachable and re-enterable (a reviewer can pull an application back from `submitted` into `under_review`, or push it back from `under_review` to `submitted` if picked up by mistake). Once a decision (`accepted`/`waitlisted`/`rejected`) is set, staff can change it directly to **either** of the other two decision states — all three decision states are mutually reachable from one another (a full graph among the three, not a chain: e.g. `accepted → rejected` is legal without passing through `waitlisted`). Phase 1's applicant-facing permanence (e.g., no re-application after `rejected`) is about the *applicant's* ability to act, not a restriction on staff correcting their own call. `draft` and `withdrawn` are never reachable from this dashboard (see Non-goals). The server action rejects any transition not in this list.

## Pages and Server Actions

Following Phase 1's established route convention (`app/[locale]/(group)/route/page.tsx`, e.g. `(participant)/register`, `(participant)/my-application`), Phase 2 pages live under a new `(admin)` route group:

### `app/[locale]/(admin)/applications/page.tsx` — list page (server component)

- Query: `applications` where `status != 'draft'`, joined with `profiles` (via `applicant_id`) for display name (`profiles.full_name`) and email, and `assigned_reviewer_id`'s profile for reviewer name.
- Default sort: `submitted_at` descending (newest submissions first) — required for pagination to be well-defined; ties broken by `id`.
- Server-side, offset-based pagination (page-size TBD at implementation time, e.g. 50/page) — required given the 5,000+ applicant scale; no client-side full-table load. Offset pagination is acceptable at this phase's scale and staff-only, low-concurrency access pattern; keyset/cursor pagination is a future optimization if the applicant volume or query latency later warrants it, not a Phase 2 requirement.
- Filters (query-string driven, so filtered views are shareable/bookmarkable): `status`, `assigned_reviewer_id`.
- Search: case-insensitive substring match (`ilike`) against `profiles.full_name`, `profiles.email`, and `applications.country`.
- Table columns: application number, applicant name, email, country, status, assigned reviewer, submitted date.
- Row click → detail page.

### `app/[locale]/(admin)/applications/[id]/page.tsx` — detail page (server component)

- Full read of one application (via the RLS-respecting `createClient()`, same as Phase 1's pages): all personal-info and conference-info fields from Phase 1's schema, plus current status, assigned reviewer, and the notes thread (newest first, each showing author name + timestamp — also read via the RLS-respecting client, gated by `application_notes`'s SELECT policy).
- Access is scoped by RLS (`applications_select_staff` for the application read, the new `application_notes` SELECT policy for the notes thread), but the page also explicitly checks the caller's role server-side before rendering. An authenticated user whose role is neither `registration_admission_manager` nor `super_admin` gets Next.js's `notFound()` (a plain 404), **not** a redirect to `/my-application` or `/register`. This was deliberately reconsidered during spec review: redirecting to `/my-application` would, for a staff account with no `applications` row of its own, cascade through `/my-application`'s own not-found redirect to `/register`, which then *creates* a stray draft `applications` row owned by the staff member's profile — silently violating this same doc's non-goal that no draft applications should be associated with this dashboard's use. A 404 has no such side effect and requires no new page.

### Server actions (mirroring `submitApplication`'s shape)

- `updateApplicationStatus(applicationId, newStatus)`: fetches the application's current `status` first, validates the transition against the state machine above (rejecting with an error if not permitted), then updates `applications.status` **with the fetch's `status` value included as an additional `.eq('status', oldStatus)` condition on the update itself** (not just the read) **and checks the affected-row count** — the same optimistic-concurrency guard `submitApplication` uses to close the read-then-write race where two staff members concurrently transition the same application. If zero rows are affected, the action errors with "Application status changed by someone else, please refresh" rather than proceeding to insert a history row for a transition that didn't actually happen. On success, inserts one `application_status_history` row with `old_status` set from the fetched value, `new_status: newStatus`, `changed_by: <caller's profile id>` (unlike the applicant-initiated `submitApplication`, which uses `null` for `changed_by`, this is staff-initiated so the actor is recorded), and `note: 'Status changed by reviewer'` (a fixed string, mirroring `submitApplication`'s hardcoded `'Applicant-initiated submission'` — no free-text reason field in this phase; reviewers wanting to explain a decision use `addNote` separately). No email is sent (see Non-goals).
- `assignReviewer(applicationId, reviewerId)`: validates that `reviewerId` refers to a profile whose role is `registration_admission_manager` or `super_admin` (rejecting otherwise), then updates `applications.assigned_reviewer_id`. Passing `null` unassigns. No history/audit row — this phase doesn't track assignment history, only current assignment (see Non-goals).
- `addNote(applicationId, body)`: rejects an empty or whitespace-only `body`, otherwise inserts one `application_notes` row with `author_id` set to the caller.

All three actions authenticate the caller and verify their role is `registration_admission_manager` or `super_admin` before writing. As noted in the RLS section above, this role check — not RLS — is the actual authorization gate for these actions, since all three use the service-role client (matching Phase 1's `submitApplication` pattern exactly).

## Testing

- RLS behavioral tests (extending Phase 1's `tests/rls/applications.test.ts` pattern): a `registration_admission_manager` can update any application's status/assignment and insert notes; a `participant` and `agenda_allocation_manager` cannot do either.
- Server action tests/manual verification: status change writes exactly one `application_status_history` row with the correct `changed_by`; reviewer assignment updates the column; notes appear in the thread with correct author attribution. **Also test each action's own role check directly** (not just the RLS backstop above) — since all three use the service-role client and bypass RLS, the role check inside the action is the actual gate; a test calling `updateApplicationStatus`/`assignReviewer`/`addNote` as an authenticated `participant` or `agenda_allocation_manager` must confirm the action itself rejects the call, not rely on RLS tests to prove this.
