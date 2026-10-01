# Work-Group Waitlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff opt any session type into waitlist behavior, let participants join a waitlist when a session is full, and automatically promote the next eligible waitlisted participant (FIFO, conflict-aware) the moment a seat frees up via voluntary cancellation — with an email notification on promotion.

**Architecture:** One new boolean column (`session_types.enable_waitlist`), one new table (`session_waitlist`) with its own RLS policies, two new SECURITY DEFINER RPCs (`join_waitlist`, `leave_waitlist`), a modification to the existing `cancel_booking()` RPC to run a FIFO promotion scan, reuse of 4c's `session_notification_outbox` + `process-session-notifications` cron for the promotion email, and additive UI changes to the existing browse/agenda pages and the session-types admin form.

**Tech Stack:** Next.js (App Router, Server Actions), Supabase Postgres (migrations, RLS, PL/pgSQL RPCs), Resend (email), Vitest (live integration tests against the scratch Supabase project).

**Spec:** `docs/superpowers/specs/2026-10-01-work-group-waitlist-design.md` — read this first; it has the full rationale for every decision below. This plan implements it task-by-task.

---

### Task 1: `enable_waitlist` column + session-types admin UI

**Files:**
- Create: `supabase/migrations/20261005000000_add_session_types_enable_waitlist.sql`
- Modify: `src/app/[locale]/(admin)/agenda/session-types/actions.ts`
- Modify: `src/app/[locale]/(admin)/agenda/session-types/session-type-manager.tsx`
- Modify: `src/app/[locale]/(admin)/agenda/session-types/page.tsx`
- Modify: `src/messages/en.json`, `src/messages/ar.json`

This task has no dependency on the waitlist table itself — it only adds the flag staff use to opt a session type in. Doing it first means later tasks (RPCs, UI) can be tested against a real session type with the flag set.

- [ ] **Step 1: Write the migration**

```sql
-- 20261005000000_add_session_types_enable_waitlist.sql
--
-- Lets staff opt any session type into waitlist behavior (sub-project 4d).
-- Defaults to false, so every existing session type keeps today's
-- behavior (participants see "Full" with no action) until staff
-- explicitly enable it. See
-- docs/superpowers/specs/2026-10-01-work-group-waitlist-design.md
-- for full rationale.

alter table session_types add column enable_waitlist boolean not null default false;
```

- [ ] **Step 2: Apply the migration to the scratch project**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase db push` (confirm `supabase/.temp/linked-project.json` points at the scratch project first, per this repo's established workflow).

- [ ] **Step 3: Regenerate database types**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase gen types typescript --project-id <scratch-project-ref> > src/types/database.ts`

Verify `session_types` in the generated file now includes `enable_waitlist: boolean`.

- [ ] **Step 4: Add the checkbox field to the admin form**

In `session-type-manager.tsx`, extend the `SessionType` and `FormState` types and wire the field through — follow the exact pattern the `code`/`nameAr`/`nameEn` fields already use:

```typescript
type SessionType = {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  is_active: boolean;
  enable_waitlist: boolean;
};

type FormState = {
  code: string;
  nameAr: string;
  nameEn: string;
  enableWaitlist: boolean;
};

const EMPTY_FORM: FormState = { code: '', nameAr: '', nameEn: '', enableWaitlist: false };

function sessionTypeToForm(sessionType: SessionType): FormState {
  return {
    code: sessionType.code,
    nameAr: sessionType.name_ar,
    nameEn: sessionType.name_en,
    enableWaitlist: sessionType.enable_waitlist,
  };
}
```

Add a checkbox in the form (after the `nameEn` label block, before the submit buttons):

```tsx
<label className="flex items-center gap-2 text-sm text-charcoal dark:text-gray-100">
  <input
    type="checkbox"
    checked={form.enableWaitlist}
    onChange={(e) => setForm({ ...form, enableWaitlist: e.target.checked })}
    className="h-4 w-4 rounded border-charcoal/20 text-turquoise focus:ring-turquoise dark:border-gray-700"
  />
  {t('enableWaitlist')}
</label>
```

And include it in `handleSubmit`'s `input` object: `{ code: form.code, nameAr: form.nameAr, nameEn: form.nameEn, enableWaitlist: form.enableWaitlist }`.

Also show it in both the mobile card and desktop table rows as a small badge or text indicator next to the existing active/inactive `Badge` — reuse the `elective`/`neutral` variant pattern (e.g., `{sessionType.enable_waitlist && <Badge variant="elective">{t('waitlistEnabled')}</Badge>}`), matching how `is_active` is already shown.

- [ ] **Step 5: Wire the field through the server actions**

In `actions.ts`, extend `sessionTypeInputSchema` and both `createSessionType`/`updateSessionType`'s insert/update payloads:

```typescript
const sessionTypeInputSchema = z.object({
  code: z.string().trim().min(1),
  nameAr: z.string().trim().min(1),
  nameEn: z.string().trim().min(1),
  enableWaitlist: z.boolean(),
});
```

In `createSessionType`'s insert: add `enable_waitlist: parsed.enableWaitlist,`. In `updateSessionType`'s update: add `enable_waitlist: parsed.enableWaitlist,`.

- [ ] **Step 6: Select the new column in the page query**

In `page.tsx`, change `.select('id, code, name_ar, name_en, is_active')` to `.select('id, code, name_ar, name_en, is_active, enable_waitlist')`.

- [ ] **Step 7: Add i18n keys**

In `src/messages/en.json` and `src/messages/ar.json`, inside the `agenda.sessionTypes` namespace, add:
- `enableWaitlist`: `"Enable waitlist when full"` / `"تفعيل قائمة الانتظار عند الامتلاء"`
- `waitlistEnabled`: `"Waitlist"` / `"قائمة انتظار"`

Match the exact existing key style and indentation in both files (check how `active`/`inactive` are currently phrased nearby for tone consistency).

- [ ] **Step 8: Manual verification**

Run the dev server, navigate to `/en/agenda/session-types` as a staff user, create or edit a session type, toggle the checkbox, save, and confirm it persists (reload the page, confirm the badge/indicator shows).

- [ ] **Step 9: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint src/app/[locale]/\(admin\)/agenda/session-types/`. Fix any errors.

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/20261005000000_add_session_types_enable_waitlist.sql src/app/[locale]/\(admin\)/agenda/session-types/ src/messages/en.json src/messages/ar.json src/types/database.ts
git commit -m "feat: add enable_waitlist flag to session types"
```

---

### Task 2: `session_waitlist` table + RLS + `session_notification_type` enum extension

**Files:**
- Create: `supabase/migrations/20261005010000_add_waitlist_promoted_notification_type.sql`
- Create: `supabase/migrations/20261005020000_session_waitlist_table.sql`

Two migrations because this repo's established convention (see 4c's own precedent — `20261004000000_add_session_cancelled_booking_status.sql` committed alone before `20261004010000` referenced the new value) requires `ALTER TYPE ... ADD VALUE` to commit in its own migration before anything in a later migration can reference it.

- [ ] **Step 1: Write the enum-extension migration**

```sql
-- 20261005010000_add_waitlist_promoted_notification_type.sql
--
-- Must be its own migration, committed before any later migration
-- references the new value (Postgres requires ALTER TYPE ... ADD VALUE
-- to commit before use — same constraint 20261004000000 worked around
-- for 'session_cancelled'). See
-- docs/superpowers/specs/2026-10-01-work-group-waitlist-design.md.

alter type session_notification_type add value 'waitlist_promoted';
```

- [ ] **Step 2: Apply it alone first**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase db push`. Confirm it applies cleanly before writing Step 3 — do not write migration 2 and push both at once; the enum value must exist in a committed transaction first.

- [ ] **Step 3: Write the `session_waitlist` table migration**

```sql
-- 20261005020000_session_waitlist_table.sql
--
-- Waitlist for sessions whose type has enable_waitlist = true. See
-- docs/superpowers/specs/2026-10-01-work-group-waitlist-design.md for
-- full design: FIFO promotion on voluntary cancellation (join_waitlist/
-- leave_waitlist in the next migration), conflict-skip at promotion
-- time, no visible queue position, no cap on waitlist size.

create type waitlist_status as enum ('waiting', 'promoted', 'withdrawn');

create table session_waitlist (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  session_id     uuid not null references sessions(id) on delete cascade,
  status         waitlist_status not null default 'waiting',
  joined_at      timestamptz not null default now(),
  promoted_at    timestamptz,
  withdrawn_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One active ('waiting') waitlist entry per participant per session.
create unique index session_waitlist_active_unique
  on session_waitlist (application_id, session_id) where status = 'waiting';

-- FIFO scan for promotion: oldest 'waiting' row per session first.
create index session_waitlist_session_fifo_idx
  on session_waitlist (session_id, joined_at) where status = 'waiting';

-- Same auto-touch trigger session_bookings uses for updated_at (see
-- session_bookings_set_updated_at in 20260823020000_session_bookings.sql).
create trigger session_waitlist_set_updated_at
  before update on session_waitlist
  for each row execute function extensions.moddatetime('updated_at');

-- RLS: real participant-facing SELECT policies (unlike 4c's
-- session_notification_outbox, which has zero policies and relies
-- entirely on GRANT discipline) -- participants legitimately read their
-- own waitlist rows directly from the client to render "On waitlist"
-- state.
alter table session_waitlist enable row level security;

create policy session_waitlist_select_own on session_waitlist
  for select using (
    application_id in (
      select id from applications where applicant_id = auth.uid()
    )
  );

create policy session_waitlist_select_staff on session_waitlist
  for select using (is_staff());

-- No direct INSERT/UPDATE/DELETE from clients -- all writes go through
-- join_waitlist/leave_waitlist/cancel_booking (SECURITY DEFINER RPCs,
-- next migration). service_role bypasses RLS and can always write.
```

Confirm the exact name of the `updated_at` auto-touch trigger function used elsewhere in this codebase before writing Step 3 for real (grep `supabase/migrations/` for `moddatetime` or the trigger name used on `session_bookings`/`sessions` — use whatever that function is actually called, the name above is illustrative based on common Postgres convention and must be verified, not assumed).

- [ ] **Step 4: Apply and verify**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase db push`. Then manually verify in the Supabase SQL editor (or via `psql`) that both policies exist and `session_waitlist` has RLS enabled: `select * from pg_policies where tablename = 'session_waitlist';`.

- [ ] **Step 5: Regenerate database types**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase gen types typescript --project-id <scratch-project-ref> > src/types/database.ts`. Confirm `session_waitlist` and `waitlist_status` now appear.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261005010000_add_waitlist_promoted_notification_type.sql supabase/migrations/20261005020000_session_waitlist_table.sql src/types/database.ts
git commit -m "feat: add session_waitlist table and waitlist_promoted notification type"
```

---

### Task 3: `join_waitlist` and `leave_waitlist` RPCs

**Files:**
- Create: `supabase/migrations/20261005030000_join_and_leave_waitlist_rpcs.sql`
- Test: `tests/agenda/work-group-waitlist-live.test.ts` (created here, extended in Task 4)

- [ ] **Step 1: Write the migration**

```sql
-- 20261005030000_join_and_leave_waitlist_rpcs.sql
--
-- join_waitlist / leave_waitlist: participant-facing self-service RPCs
-- for the waitlist. Modeled directly on book_session()/cancel_booking()'s
-- existing structure (auth check, row lock, clear exceptions instead of
-- raw constraint violations). See
-- docs/superpowers/specs/2026-10-01-work-group-waitlist-design.md
-- section "RPC Changes".

create function join_waitlist(
  p_application_id uuid,
  p_session_id     uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session        sessions%rowtype;
  v_enable_waitlist boolean;
  v_count          int;
  v_deadline       timestamptz;
  v_waitlist_id    uuid;
begin
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select * into v_session from sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'Session not found';
  end if;
  if v_session.status not in ('published', 'confirmed') then
    raise exception 'Session is not open for booking';
  end if;

  select st.enable_waitlist into v_enable_waitlist
  from session_types st where st.id = v_session.session_type_id;
  if not coalesce(v_enable_waitlist, false) then
    raise exception 'This session does not support a waitlist';
  end if;

  v_deadline := coalesce(v_session.booking_deadline, v_session.start_time - interval '3 hours');
  if now() > v_deadline then
    raise exception 'Booking deadline has passed';
  end if;

  v_count := session_effective_occupied_count(p_session_id);
  if v_count < v_session.capacity then
    raise exception 'Session is not full -- book it directly instead of joining the waitlist';
  end if;

  if exists (
    select 1 from session_bookings
    where application_id = p_application_id and session_id = p_session_id and status = 'active'
  ) then
    raise exception 'You already have a booking for this session';
  end if;

  if exists (
    select 1 from session_waitlist
    where application_id = p_application_id and session_id = p_session_id and status = 'waiting'
  ) then
    raise exception 'You are already on the waitlist for this session';
  end if;

  insert into session_waitlist (application_id, session_id)
  values (p_application_id, p_session_id)
  returning id into v_waitlist_id;

  return v_waitlist_id;
end;
$$;

grant execute on function join_waitlist(uuid, uuid) to authenticated;

create function leave_waitlist(
  p_application_id uuid,
  p_session_id     uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_waitlist_id uuid;
begin
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select id into v_waitlist_id from session_waitlist
  where application_id = p_application_id and session_id = p_session_id and status = 'waiting'
  for update;

  if v_waitlist_id is null then
    raise exception 'You are not on the waitlist for this session';
  end if;

  update session_waitlist
  set status = 'withdrawn', withdrawn_at = now()
  where id = v_waitlist_id;
end;
$$;

grant execute on function leave_waitlist(uuid, uuid) to authenticated;
```

Note: the duplicate-join race is already fully closed by the `session_waitlist_active_unique` partial index from Task 2 — the explicit existence check above is for a clear error message on the common path, not the sole correctness guard. A true concurrent double-insert would still hit the unique index and raise a Postgres constraint-violation error (23505); that's acceptable per the spec (not explicitly required to catch and rewrap it, unlike the primary validation checks above).

- [ ] **Step 2: Apply the migration**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase db push`.

- [ ] **Step 3: Write the test file skeleton and fixture helpers**

Create `tests/agenda/work-group-waitlist-live.test.ts`, following `tests/agenda/session-lifecycle-notifications-live.test.ts`'s exact conventions: `runId`-suffixed unique codes/emails, a dedicated room per seeded session (to avoid `sessions_room_no_overlap`), a real signed-in participant client (not service-role) for any RPC gated by `auth.uid()`, and the `schedule_change_events`-before-`sessions` delete-order fix in `afterAll` (direct `UPDATE`s to `sessions` fire the pre-existing `sessions_change_detection` trigger — this test suite does update `sessions.status` indirectly via `cancel_booking`'s promotion path touching `session_bookings`, not `sessions` itself, so confirm during implementation whether that cleanup fix is actually needed here; if no test in this file ever directly `UPDATE`s `sessions`, it is not).

Add a `seedSessionType(codeSlug, enableWaitlist)` helper (insert into `session_types`, track id for cleanup) alongside the existing `seedSession`/`seedAcceptedApplicant`/`directBooking` helper shapes from the 4c test file — `seedSession` will need an optional `sessionTypeId` override parameter (or default to creating/reusing one types without waitlist enabled) since the current 4c test file's `seedSession` doesn't let the caller pick a type with `enable_waitlist = true`.

- [ ] **Step 4: Write the failing tests for `join_waitlist`**

```typescript
describe('join_waitlist', () => {
  it('succeeds when the session is full and its type has enable_waitlist = true', async () => {
    // seed a waitlist-enabled session type, a session with capacity 1,
    // one applicant who books the single seat, a second applicant who
    // joins the waitlist -- assert the RPC returns a waitlist row id and
    // the row exists with status = 'waiting'
  });

  it('rejects when the session is not published/confirmed (e.g. draft)', async () => {
    // seed a waitlist-enabled, full, but still-draft session -- join_waitlist
    // should raise 'Session is not open for booking', same message/condition
    // as book_session's own status check
  });

  it('rejects when the session is not full', async () => {
    // capacity 2, only 1 booked -- join_waitlist should raise
    // 'Session is not full -- book it directly instead of joining the waitlist'
  });

  it('rejects when the session type does not have enable_waitlist = true', async () => {
    // full session, but enable_waitlist = false on its type
  });

  it('rejects a duplicate join', async () => {
    // same applicant calls join_waitlist twice for the same full session
  });

  it('rejects when the caller already holds an active booking for the session', async () => {
    // the applicant who already booked the seat tries to also join its waitlist
  });
});

describe('leave_waitlist', () => {
  it('succeeds and marks the row withdrawn', async () => {});
  it('rejects when the caller has no waiting row for that session', async () => {});
});
```

Fill in each test body using the real seeded fixtures and the signed-in participant client's `.rpc('join_waitlist', {...})` / `.rpc('leave_waitlist', {...})` calls, following the exact assertion style of `session-lifecycle-notifications-live.test.ts` (e.g. `expect(error).not.toBeNull(); expect(error?.message).toContain('...')` for rejections).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/agenda/work-group-waitlist-live.test.ts`

Expected: all 7 tests PASS. If any fail, fix the migration (not the test) unless the test itself has a bug — re-read the spec section "RPC Changes" to confirm expected behavior before changing either.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint tests/agenda/work-group-waitlist-live.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261005030000_join_and_leave_waitlist_rpcs.sql tests/agenda/work-group-waitlist-live.test.ts
git commit -m "feat: add join_waitlist and leave_waitlist RPCs"
```

---

### Task 4: `cancel_booking()` promotion logic

**Files:**
- Create: `supabase/migrations/20261005040000_cancel_booking_waitlist_promotion.sql`
- Modify: `tests/agenda/work-group-waitlist-live.test.ts`

This is the core of the feature — extending `cancel_booking()` to run the FIFO promotion scan described in the spec's "RPC Changes / `cancel_booking()` — modified" section.

- [ ] **Step 1: Write the migration**

Full `create or replace function cancel_booking(...)` — copy `cancel_booking`'s current body verbatim from `supabase/migrations/20261004010000_session_lifecycle_notifications.sql` (reproduced in this plan's research above) and append the promotion logic after the existing `update session_bookings set status = 'cancelled', ...` statement, before `end;`:

```sql
-- 20261005040000_cancel_booking_waitlist_promotion.sql
--
-- Extends cancel_booking() to promote the next eligible waitlisted
-- participant (FIFO, conflict-aware) when a voluntary cancellation frees
-- a seat on a session whose type has enable_waitlist = true. Does NOT
-- apply to staff-initiated session cancellation (session_cancelled
-- bookings, handled entirely by the 4c trigger) -- when staff cancel a
-- session outright there is nothing left to promote anyone into. See
-- docs/superpowers/specs/2026-10-01-work-group-waitlist-design.md
-- scope decision #5.

create or replace function cancel_booking(
  p_booking_id     uuid,
  p_application_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_booking         session_bookings%rowtype;
  v_session         sessions%rowtype;
  v_deadline        timestamptz;
  v_enable_waitlist boolean;
  v_candidate       record;
  v_new_booking_id  uuid;
begin
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select * into v_booking from session_bookings
  where id = p_booking_id and application_id = p_application_id
  for update;

  if v_booking.id is null then
    raise exception 'Booking not found';
  end if;
  if v_booking.status in ('cancelled', 'session_cancelled') then
    raise exception 'Booking is already cancelled';
  end if;

  select * into v_session from sessions where id = v_booking.session_id;
  v_deadline := coalesce(v_session.booking_deadline, v_session.start_time - interval '3 hours');

  if now() > v_deadline then
    raise exception 'Cannot cancel after the booking deadline';
  end if;

  update session_bookings
  set status = 'cancelled', cancelled_at = now()
  where id = p_booking_id;

  -- Waitlist promotion: only for voluntary cancellation (this function),
  -- never for staff-initiated session cancellation (handled by the 4c
  -- trigger, which never calls this function).
  select st.enable_waitlist into v_enable_waitlist
  from session_types st where st.id = v_session.session_type_id;

  if coalesce(v_enable_waitlist, false) then
    <<promotion>>
    for v_candidate in
      select sw.id, sw.application_id
      from session_waitlist sw
      where sw.session_id = v_booking.session_id
        and sw.status = 'waiting'
      order by sw.joined_at asc
    loop
      if exists (
        select 1 from session_bookings sb join sessions s on s.id = sb.session_id
        where sb.application_id = v_candidate.application_id and sb.status = 'active'
          and tstzrange(s.start_time, s.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)')
      ) or exists (
        select 1 from allocation_assignments aa join sessions s on s.id = aa.session_id
        where aa.application_id = v_candidate.application_id and aa.status = 'confirmed'
          and tstzrange(s.start_time, s.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)')
      ) then
        continue;
      end if;

      insert into session_bookings (application_id, session_id)
      values (v_candidate.application_id, v_booking.session_id)
      returning id into v_new_booking_id;

      update session_waitlist
      set status = 'promoted', promoted_at = now()
      where id = v_candidate.id;

      update session_waitlist sw2
      set status = 'withdrawn', withdrawn_at = now()
      from sessions s2
      where sw2.session_id = s2.id
        and sw2.application_id = v_candidate.application_id
        and sw2.status = 'waiting'
        and tstzrange(s2.start_time, s2.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)');

      insert into session_notification_outbox (booking_id, application_id, session_id, notification_type)
      values (v_new_booking_id, v_candidate.application_id, v_booking.session_id, 'waitlist_promoted');

      exit promotion;
    end loop;
  end if;
end;
$$;

grant execute on function cancel_booking(uuid, uuid) to authenticated;
```

- [ ] **Step 2: Apply the migration**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase db push`.

- [ ] **Step 3: Write the failing promotion tests**

Append to `tests/agenda/work-group-waitlist-live.test.ts`:

```typescript
describe('cancel_booking waitlist promotion', () => {
  it('promotes in FIFO order when a seat frees up', async () => {
    // capacity-1 waitlist-enabled session; applicant A books; B joins
    // waitlist first, C joins second; A cancels; assert B now has an
    // active session_bookings row and B's waitlist row is 'promoted';
    // assert C's waitlist row is still 'waiting'
  });

  it('skips a candidate with a time conflict and promotes the next eligible one', async () => {
    // B has a conflicting active booking elsewhere at the same time as
    // the vacated session; C does not; A cancels; assert C is promoted,
    // B's waitlist row is untouched ('waiting')
  });

  it('withdraws the promoted participant\'s other overlapping waitlist entries', async () => {
    // B is waitlisted for two time-overlapping sessions (session_X and
    // session_Y); A cancels a seat in session_X; B is promoted into
    // session_X; assert B's waitlist row for session_Y is now 'withdrawn'
  });

  it('inserts exactly one waitlist_promoted outbox row on promotion', async () => {
    // same as the FIFO test, but assert session_notification_outbox has
    // exactly one row with notification_type = 'waitlist_promoted' and
    // booking_id = the new booking's id
  });

  it('does not promote anyone when staff cancel the session itself', async () => {
    // seed a waitlist-enabled session with a booked seat and a waiting
    // candidate; directly UPDATE sessions.status to 'cancelled' (the 4c
    // trigger path, not cancel_booking); assert the waitlist candidate's
    // row is still 'waiting' and no waitlist_promoted outbox row exists
  });

  it('leaves the seat unfilled when every candidate is conflicted', async () => {
    // both B and C have conflicting bookings elsewhere; A cancels;
    // assert zero new active bookings for this session, both B and C's
    // waitlist rows remain 'waiting'
  });
});
```

Fill in each test body with real seeded fixtures (multiple applicants, multiple sessions with distinct rooms per the room-overlap gotcha, time-overlapping sessions for the conflict/cross-waitlist tests) and call `cancel_booking` via the real signed-in participant client whose booking is being cancelled (matching `auth.uid()` gating), then assert via the service-role `admin` client.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agenda/work-group-waitlist-live.test.ts`

Expected: all tests (from Task 3 and this task) PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint tests/agenda/work-group-waitlist-live.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261005040000_cancel_booking_waitlist_promotion.sql tests/agenda/work-group-waitlist-live.test.ts
git commit -m "feat: promote next eligible waitlist candidate on voluntary cancellation"
```

---

### Task 5: Promotion email + cron integration

**Files:**
- Modify: `src/lib/email/resend.ts`
- Modify: `src/app/api/cron/process-session-notifications/route.ts`
- Create: `tests/email/work-group-waitlist-notification.test.ts`

- [ ] **Step 1: Write the failing email unit test**

Create `tests/email/work-group-waitlist-notification.test.ts`, following `tests/email/session-lifecycle-notifications.test.ts`'s exact structure (mock `fetchEmailSettings`/Resend send, assert subject/body content for both locales, assert the `/my-agenda` link is present):

```typescript
describe('sendWaitlistPromotionNotificationEmail', () => {
  it('sends an English email with a /my-agenda link', async () => { /* ... */ });
  it('sends an Arabic email with a /my-agenda link', async () => { /* ... */ });
  it('returns an error when Resend is not configured', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/email/work-group-waitlist-notification.test.ts`
Expected: FAIL — `sendWaitlistPromotionNotificationEmail` is not defined.

- [ ] **Step 3: Add the email function**

In `src/lib/email/resend.ts`, add after `sendSessionRescheduleNotificationEmail` (following its exact shape, but linking to `/my-agenda` per the spec, not `/my-agenda/browse`):

```typescript
export async function sendWaitlistPromotionNotificationEmail(params: {
  to: string;
  fullName: string;
  sessionTitle: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const agendaUrl = `${config.appUrl}/my-agenda`;

  const subject =
    params.locale === 'ar'
      ? `تمت ترقيتك من قائمة الانتظار: ${params.sessionTitle}`
      : `You're off the waitlist: ${params.sessionTitle}`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nتحرر مقعد في الجلسة "${params.sessionTitle}" وتمت ترقيتك تلقائياً من قائمة الانتظار إلى حجز مؤكد.\n\nيمكنك مراجعة برنامجك من هنا: ${agendaUrl}\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nA seat opened up in "${params.sessionTitle}" and you've been automatically promoted from the waitlist to a confirmed booking.\n\nYou can review your agenda here: ${agendaUrl}\n\nIf you have any questions, please contact us.`;

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}
```

- [ ] **Step 4: Run the email test to verify it passes**

Run: `npx vitest run tests/email/work-group-waitlist-notification.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the cron route's third branch**

In `src/app/api/cron/process-session-notifications/route.ts`:

1. Import `sendWaitlistPromotionNotificationEmail` alongside the other two.
2. Widen the row type's `notification_type` union to include `'waitlist_promoted'`.
3. Convert the two-way ternary (`row.notification_type === 'session_cancelled' ? ... : ...`) into a three-way dispatch, since a bare ternary can no longer express three branches cleanly:

```typescript
let result: { id: string | null; error: string | null };
if (row.notification_type === 'session_cancelled') {
  result = await sendSessionCancellationNotificationEmail({ to: profile.email, fullName: profile.full_name, sessionTitle, locale });
} else if (row.notification_type === 'session_rescheduled') {
  result = await sendSessionRescheduleNotificationEmail({
    to: profile.email, fullName: profile.full_name, sessionTitle,
    oldStartTime: row.old_start_time!, newStartTime: row.new_start_time!, locale,
  });
} else {
  result = await sendWaitlistPromotionNotificationEmail({ to: profile.email, fullName: profile.full_name, sessionTitle, locale });
}
```

Replace the existing ternary assignment (`const result = row.notification_type === 'session_cancelled' ? ... : ...;`) with this `let`-based block in the same position in the loop.

- [ ] **Step 6: Skip — already covered**

No new test needed here. Task 4's "inserts exactly one `waitlist_promoted` outbox row" test already fully covers the cron's read-side precondition (a `pending` row with the right `notification_type` existing after a promotion). Adding another one in this task would be a redundant duplicate, not new coverage.

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint src/lib/email/resend.ts src/app/api/cron/process-session-notifications/route.ts tests/email/work-group-waitlist-notification.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/email/resend.ts src/app/api/cron/process-session-notifications/route.ts tests/email/work-group-waitlist-notification.test.ts
git commit -m "feat: send email notification on waitlist promotion"
```

---

### Task 6: Participant UI — browse page join/leave + my-agenda waitlisted section

**Files:**
- Modify: `src/app/[locale]/(participant)/(shell)/my-agenda/browse/page.tsx`
- Modify: `src/app/[locale]/(participant)/(shell)/my-agenda/booking-button.tsx`
- Modify: `src/app/[locale]/(participant)/(shell)/my-agenda/actions.ts`
- Modify: `src/app/[locale]/(participant)/(shell)/my-agenda/page.tsx`
- Modify: `src/app/[locale]/(participant)/(shell)/my-agenda/agenda-day.tsx`
- Modify: `src/components/ui/badge.tsx`

- [ ] **Step 1: Add the `waitlisted` Badge variant**

In `src/components/ui/badge.tsx`, add to `BadgeVariant` and `VARIANT_CLASSES`:

```typescript
type BadgeVariant = 'mandatory' | 'elective' | 'cancelled' | 'sessionCancelled' | 'waitlisted' | 'changed' | 'pending' | 'neutral';

// ...
// Gold outline, matching `pending`'s "awaiting action" family but kept
// visually distinct since it sits next to a "Leave waitlist" action
// rather than a passive status.
waitlisted: 'border border-turquoise text-turquoise bg-transparent dark:border-blue-400 dark:text-blue-300',
```

(Pick the exact class values during implementation by checking what reads clearly against both the mobile card and desktop table backgrounds already in use — the above is a starting point, not a fixed requirement, as long as it's visually distinct from `sessionCancelled`, `pending`, and `cancelled`.)

- [ ] **Step 2: Add `joinWaitlist`/`leaveWaitlist` server actions**

In `actions.ts`, add two functions mirroring `bookSession`/`cancelBooking`'s exact structure (auth check, resolve `application.id`, call the RPC, map `error` to `{ error: error.message }`):

```typescript
type WaitlistResult = { waitlistId?: string; error?: string };

export async function joinWaitlist(sessionId: string): Promise<WaitlistResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { data: app } = await supabase
    .from('applications')
    .select('id')
    .eq('applicant_id', user.id)
    .eq('status', 'accepted')
    .maybeSingle();

  if (!app) return { error: 'No accepted application found.' };

  const { data, error } = await supabase.rpc('join_waitlist', {
    p_application_id: app.id,
    p_session_id: sessionId,
  });

  if (error) return { error: error.message };
  return { waitlistId: data as string };
}

export async function leaveWaitlist(sessionId: string): Promise<CancelResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { data: app } = await supabase
    .from('applications')
    .select('id')
    .eq('applicant_id', user.id)
    .eq('status', 'accepted')
    .maybeSingle();

  if (!app) return { error: 'No accepted application found.' };

  const { error } = await supabase.rpc('leave_waitlist', {
    p_application_id: app.id,
    p_session_id: sessionId,
  });

  if (error) return { error: error.message };
  return {};
}
```

- [ ] **Step 3: Add `WaitlistButton` to `booking-button.tsx`**

Add a new component following `BookButton`'s exact structure (local `isPending`/`error` state, `useTransition`, same button sizing/spacing):

```tsx
type WaitlistButtonProps = {
  sessionId: string;
  isWaitlisted: boolean;
};

export function WaitlistButton({ sessionId, isWaitlisted: initialWaitlisted }: WaitlistButtonProps) {
  const [waitlisted, setWaitlisted] = useState(initialWaitlisted);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (waitlisted) {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-sm font-medium text-turquoise dark:text-blue-300">On waitlist</span>
        <button
          disabled={isPending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await leaveWaitlist(sessionId);
              if (result.error) setError(result.error);
              else setWaitlisted(false);
            });
          }}
          className="text-xs text-charcoal/50 underline hover:text-red-600 disabled:opacity-50 dark:text-gray-500"
        >
          {isPending ? 'Leaving…' : 'Leave waitlist'}
        </button>
        {error && <p className="max-w-[160px] text-right text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={isPending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await joinWaitlist(sessionId);
            if (result.error) setError(result.error);
            else setWaitlisted(true);
          });
        }}
      >
        {isPending ? 'Joining…' : 'Join waitlist'}
      </Button>
      {error && <p className="max-w-[160px] text-right text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
```

Import `joinWaitlist`/`leaveWaitlist` from `./actions` alongside the existing `bookSession`/`cancelBooking` import.

- [ ] **Step 4: Update `browse/page.tsx`'s query and rendering**

Add `session_types ( enable_waitlist )` to the `sessions` select (joining through `session_type_id`, which exists on `sessions` but isn't currently selected — confirm the exact join syntax Supabase expects for a nested select through a FK not otherwise selected). Add a query for the participant's own `session_waitlist` rows:

```typescript
const { data: myWaitlistRows } = await supabase
  .from('session_waitlist')
  .select('session_id')
  .eq('application_id', application.id)
  .eq('status', 'waiting');

const myWaitlistedIds = new Set((myWaitlistRows ?? []).map((w) => w.session_id));
```

In the render loop, replace the `BookButton` branch for the full+not-already-booked case: when `isFull` and the session's `session_types.enable_waitlist` is true, render `<WaitlistButton sessionId={s.id} isWaitlisted={myWaitlistedIds.has(s.id)} />` instead of `<BookButton isFull={true} .../>`. When `isFull` and `enable_waitlist` is false, keep the existing `BookButton` (which already renders the "Full" pill for `isFull`).

- [ ] **Step 5: Update `/my-agenda`'s query and add the waitlisted section**

In `page.tsx`, add a query for the participant's waiting `session_waitlist` rows joined to session details (title, time, room — same shape as the existing `bookings` query), and pass them to `AgendaDay` or a new small section above/within the day grouping.

In `agenda-day.tsx`, add a `waitlistEntries` prop (or extend `bookings` with a synthetic status if that proves simpler — use judgment, but keep `Booking.status`'s type-safety property from 4c intact, don't widen it back to `string`) and render each with the `waitlisted` Badge variant plus a "Leave waitlist" button (reusing `WaitlistButton`'s leave-only rendering, or a small inline button calling `leaveWaitlist` directly — whichever keeps `agenda-day.tsx` simplest given its existing structure).

- [ ] **Step 6: Manual browser verification**

Start the dev server. As a participant with an accepted application: find or create (via the admin UI from Task 1) a waitlist-enabled session type, create a session of that type with capacity 1 via the admin agenda UI, book it as one participant, then as a second participant visit `/my-agenda/browse` and confirm "Join waitlist" appears, click it, confirm it becomes "On waitlist" / "Leave waitlist", visit `/my-agenda` and confirm the waitlisted entry appears, click "Leave waitlist", confirm it disappears from both pages.

Then test promotion end-to-end: re-join the waitlist as the second participant, cancel the first participant's booking via `/my-agenda`, and confirm the second participant's `/my-agenda` now shows an active booking for that session (not waitlisted) on a subsequent page load.

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint src/app/[locale]/\(participant\)/\(shell\)/my-agenda/ src/components/ui/badge.tsx`.

- [ ] **Step 8: Commit**

```bash
git add src/app/[locale]/\(participant\)/\(shell\)/my-agenda/ src/components/ui/badge.tsx
git commit -m "feat: add waitlist join/leave UI to browse and my-agenda pages"
```

---

### Task 7: RLS lockdown tests + full sweep

**Files:**
- Modify: `tests/agenda/work-group-waitlist-live.test.ts`

- [ ] **Step 1: Write the RLS lockdown test**

Add to `tests/agenda/work-group-waitlist-live.test.ts`:

```typescript
describe('session_waitlist RLS', () => {
  it('a participant cannot SELECT another participant\'s waitlist row', async () => {
    // applicant A joins a waitlist; sign in as applicant B (a different
    // real participant client, not service-role); SELECT session_waitlist
    // filtered to A's row id; assert the result is empty (RLS-filtered,
    // not a thrown error)
  });

  it('a participant cannot write to session_waitlist directly, bypassing the RPCs', async () => {
    // sign in as a real participant client; attempt a direct .insert()
    // into session_waitlist; assert it errors (no INSERT policy exists)
  });
});
```

- [ ] **Step 2: Run the full new test file**

Run: `npx vitest run tests/agenda/work-group-waitlist-live.test.ts tests/email/work-group-waitlist-notification.test.ts`

Expected: all tests PASS.

- [ ] **Step 3: Full relevant-suite run**

Run: `npx vitest run tests/agenda tests/email tests/booking` (mirrors 4c's Task 7 scope) as a general "nothing else in the shared schema broke" sweep. Pay particular attention to `tests/agenda/session-lifecycle-notifications-live.test.ts` specifically — it directly exercises `cancel_booking()` (including its already-cancelled rejection check, in the "rejects an attempt to cancel an already-session_cancelled booking" test), so it's the one existing suite that can actually catch a regression in the non-promotion path Task 4 preserved. (`booking-allocation-conflict-live.test.ts` only exercises `book_session()`, which Task 4 never touches — running it is still worthwhile as part of the general sweep, but it proves nothing about `cancel_booking`'s promotion addition specifically.)

- [ ] **Step 4: Full typecheck and lint**

Run: `npx tsc --noEmit` (compare any output against master's pre-existing baseline the way 4c's Task 7 did — don't treat unrelated pre-existing errors as this branch's problem, but do verify via `git diff master -- <file>` that any file showing errors was actually untouched by this branch before dismissing them) and `npx eslint src/ tests/agenda/work-group-waitlist-live.test.ts tests/email/work-group-waitlist-notification.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add tests/agenda/work-group-waitlist-live.test.ts
git commit -m "test: add session_waitlist RLS lockdown coverage"
```

- [ ] **Step 6: Dispatch a final whole-branch code-reviewer subagent**

Covering the full diff against `master`, cross-referencing the spec, with particular attention to: does every write path to `sessions`/`session_bookings` that could free up a seat actually go through `cancel_booking` (confirming no-op for staff-cancellation is correct and intentional, not a missed path); is the FIFO/conflict/cross-waitlist-cleanup logic in the migration exactly consistent with the spec's pseudocode; does the UI correctly distinguish the three states (bookable, full-no-waitlist, full-with-waitlist) in both `browse` and `my-agenda`.

- [ ] **Step 7: Proceed to `superpowers:finishing-a-development-branch`**

Push, create a PR (reusing the title/body pattern from 4c's PR #9), await merge, clean up the worktree and branch — matching the exact pattern used for 4a/4b/4c.
