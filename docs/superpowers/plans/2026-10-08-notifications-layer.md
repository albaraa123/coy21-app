# Notifications Layer (Sub-Project 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the narrow `session_notification_outbox` pattern with a unified `notifications` table that drives both an in-app notification bell (Realtime, participant shell only) and a single per-minute email cron, covering 9 event channels including 3 brand-new ones (application accepted/rejected, booking confirmed) and a staff-only broadcast announcement.

**Architecture:** One new `notifications` table + `notification_broadcast_reads` companion table, written exclusively through `security definer` RPCs (`create_notification`, `create_announcement`, `mark_notification_read`). A broadcast-via-trigger Realtime pattern (mirroring sub-project 5a's `ops_dashboard_snapshot` precedent) pushes live updates to a new `NotificationBell` client component in `Topbar`. A single new cron (`process-notifications`, 1-minute schedule) replaces `process-session-notifications` and absorbs email dispatch for `session-reminders`/`travel-reminders`, which are modified to become row-producers instead of direct senders. `session_notification_outbox` is left untouched as a frozen archive.

**Tech Stack:** Next.js 16 (App Router, Route Handlers, Server Actions), Supabase (Postgres, Realtime broadcast, RLS), Resend (email), Vercel Cron, Vitest (TDD).

**Ground truth sources for every code sketch below:** `docs/superpowers/specs/2026-10-08-notifications-layer-design.md` (the approved spec, read in full before starting any task) and direct reads of `src/app/api/cron/process-session-notifications/route.ts`, `src/app/api/cron/session-reminders/route.ts`, `src/app/api/cron/travel-reminders/route.ts`, `src/lib/email/resend.ts`, `supabase/migrations/20260721202027_applications_table.sql`, `vercel.json`, `src/app/[locale]/(admin)/applications/[id]/actions.ts`, `src/components/shell/topbar.tsx` — every one of these was read in full during plan-writing; re-read them yourself before touching them, don't trust this plan's paraphrase over the live file.

**Known gap, inherited into this plan, not solved by it:** there is NO established pattern anywhere in this codebase for testing a cron Route Handler's `GET` function directly (confirmed: zero such tests exist for any of the 4 current crons). This plan follows the existing convention — test the underlying DB-level producer/trigger logic thoroughly (live tests), and verify the cron route's email-dispatch loop via a mocked-dependencies unit test (new pattern, Task 6) rather than inventing a live-HTTP cron test with no precedent.

---

### Task 0: `notifications` + `notification_broadcast_reads` tables, RLS, constraint

**Files:**
- Create: `supabase/migrations/20261008010000_notifications_table.sql`
- Test: `tests/attendance/notifications-schema-live.test.ts` (new — live test file; this codebase's convention for a brand-new table's schema/constraint/RLS behavior, matching the pattern of e.g. `tests/attendance/scan-qr-idempotency-live.test.ts`)

No code dependency on other tasks; must land first since everything else references this table.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20261008010000_notifications_table.sql
--
-- Sub-project 6 (notifications layer): the unified notifications table,
-- replacing session_notification_outbox (20261004010000_session_lifecycle_notifications.sql)
-- for all NEW notification writes going forward. session_notification_outbox
-- itself is left entirely unmodified -- a frozen pre-cutover archive, no new
-- writes, no deletion, no retroactive migration. See
-- docs/superpowers/specs/2026-10-08-notifications-layer-design.md for the
-- full design rationale.

create type notification_channel as enum (
  'application_accepted', 'application_rejected',
  'booking_confirmed',
  'session_cancelled', 'session_rescheduled', 'waitlist_promoted',
  'session_reminder', 'travel_reminder',
  'announcement'
);
create type notification_status as enum ('pending', 'sent', 'failed');

create table notifications (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid references applications(id) on delete cascade,
  is_broadcast    boolean not null default false,
  channel         notification_channel not null,
  title           text not null,
  body            text,
  link_path       text,
  session_id      uuid references sessions(id) on delete set null,
  old_start_time  timestamptz,
  new_start_time  timestamptz,
  email_status    notification_status not null default 'pending',
  error_message   text,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  constraint notifications_broadcast_application_id_check
    check ((is_broadcast and application_id is null) or (not is_broadcast and application_id is not null))
);

create index notifications_pending_idx on notifications (created_at) where email_status = 'pending';
create index notifications_application_feed_idx on notifications (application_id, created_at desc) where not is_broadcast;

alter table notifications enable row level security;

create policy notifications_own_select on notifications
  for select to authenticated
  using (not is_broadcast and application_id in (
    select id from applications where applicant_id = auth.uid()
  ));

create policy notifications_broadcast_select on notifications
  for select to authenticated
  using (is_broadcast = true);

-- No insert/update/delete policy -- every write goes through the
-- security definer create_notification/create_announcement RPCs (Task 1),
-- enforced by GRANT discipline (revoked from public/anon below), the same
-- pattern session_notification_outbox already established.
revoke all on notifications from public, anon, authenticated;
grant select on notifications to authenticated;
grant all on notifications to service_role;

create table notification_broadcast_reads (
  notification_id uuid not null references notifications(id) on delete cascade,
  application_id  uuid not null references applications(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, application_id)
);

alter table notification_broadcast_reads enable row level security;

create policy notification_broadcast_reads_own_select on notification_broadcast_reads
  for select to authenticated
  using (application_id in (select id from applications where applicant_id = auth.uid()));

-- No insert policy -- rows are created exclusively via mark_notification_read
-- (Task 1), not direct client insert, so a participant cannot mark another
-- participant's copy of a broadcast as read.
revoke all on notification_broadcast_reads from public, anon, authenticated;
grant select on notification_broadcast_reads to authenticated;
grant all on notification_broadcast_reads to service_role;
```

- [ ] **Step 2: Apply the migration live**

Convention established across sub-projects 1-5b: `supabase db push` is known-broken on a pre-existing FK bug in an unrelated older migration (see this project's own notes). Use the documented workaround:
```bash
npx supabase db query --linked --file supabase/migrations/20261008010000_notifications_table.sql
```
Confirm the CLI is linked to the REAL COY21 project (`vfwcbkjvinbtcntwjrzq`) before running this — check `.env.local`'s `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_PROJECT_REF` and `supabase/.temp/project-ref` in this worktree match `vfwcbkjvinbtcntwjrzq`, NOT any other project ref. If they don't match, run `npx supabase link --project-ref vfwcbkjvinbtcntwjrzq` first.

- [ ] **Step 3: Verify live via direct `pg_proc`/`information_schema` query, not just absence of error**

```bash
cat > /tmp/verify_notif_schema.sql << 'EOF'
select table_name, column_name, data_type from information_schema.columns
where table_name in ('notifications', 'notification_broadcast_reads')
order by table_name, ordinal_position;
EOF
npx supabase db query --linked --file /tmp/verify_notif_schema.sql
```
Expected: both tables' full column lists appear, matching the migration above exactly.

- [ ] **Step 4: Write the failing live test**

```typescript
// tests/attendance/notifications-schema-live.test.ts
//
// Sub-project 6 (notifications layer), Task 0: live schema/constraint/RLS
// tests for the new notifications + notification_broadcast_reads tables.
// Follows this codebase's established live-test convention: real Supabase
// Auth users, runId-suffixed fixture identifiers (per this project's own
// documented fixture-leak issue), service-role admin client for setup,
// anon/authenticated clients for RLS assertions.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const notificationIds: string[] = [];

async function createApplicant(label: string) {
  const { data: user, error } = await admin.auth.admin.createUser({
    email: `notif-schema-${runId}-${label}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error || !user.user) throw new Error(`Failed to create ${label}: ${error?.message}`);
  applicantUserIds.push(user.user.id);
  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: user.user.id, status: 'accepted' })
    .select('id')
    .single();
  if (appError || !app) throw new Error(`Failed to create application for ${label}: ${appError?.message}`);
  applicationIds.push(app.id);
  return { userId: user.user.id, applicationId: app.id };
}

afterAll(async () => {
  await admin.from('notification_broadcast_reads').delete().in('notification_id', notificationIds);
  await admin.from('notifications').delete().in('id', notificationIds);
  await admin.from('applications').delete().in('id', applicationIds);
  await Promise.allSettled(applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe('notifications table — schema, constraint, RLS', () => {
  it('rejects a broadcast row with a non-null application_id', async () => {
    const { applicationId } = await createApplicant('constraint-a');
    const { error } = await admin.from('notifications').insert({
      is_broadcast: true,
      application_id: applicationId,
      channel: 'announcement',
      title: 'Test',
    } as never);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/notifications_broadcast_application_id_check/);
  });

  it('rejects a non-broadcast row with a null application_id', async () => {
    const { error } = await admin.from('notifications').insert({
      is_broadcast: false,
      application_id: null,
      channel: 'booking_confirmed',
      title: 'Test',
    } as never);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/notifications_broadcast_application_id_check/);
  });

  it('a participant cannot select another participant\'s personal notification row', async () => {
    const { applicationId: appA } = await createApplicant('rls-a');
    const { userId: userB } = await createApplicant('rls-b');

    const { data: row } = await admin
      .from('notifications')
      .insert({ is_broadcast: false, application_id: appA, channel: 'booking_confirmed', title: 'A\'s notification' } as never)
      .select('id')
      .single();
    notificationIds.push((row as { id: string }).id);

    const clientB = createClient<Database>(URL, ANON_KEY);
    await clientB.auth.signInWithPassword({ email: `notif-schema-${runId}-rls-b@test.local`, password: 'password123' });
    const { data: seenByB } = await clientB.from('notifications').select('id').eq('id', (row as { id: string }).id);
    expect(seenByB).toHaveLength(0);
    void userB;
  });

  it('every authenticated participant can select a broadcast row', async () => {
    const { userId } = await createApplicant('rls-broadcast');
    const { data: row } = await admin
      .from('notifications')
      .insert({ is_broadcast: true, application_id: null, channel: 'announcement', title: 'Broadcast test' } as never)
      .select('id')
      .single();
    notificationIds.push((row as { id: string }).id);

    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: `notif-schema-${runId}-rls-broadcast@test.local`, password: 'password123' });
    const { data: seen } = await client.from('notifications').select('id').eq('id', (row as { id: string }).id);
    expect(seen).toHaveLength(1);
    void userId;
  });

  it('a direct client-side insert is rejected (no insert policy; GRANT-level lockout)', async () => {
    const { userId, applicationId } = await createApplicant('no-direct-insert');
    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: `notif-schema-${runId}-no-direct-insert@test.local`, password: 'password123' });
    const { error } = await client.from('notifications').insert({
      is_broadcast: false, application_id: applicationId, channel: 'booking_confirmed', title: 'Should fail',
    } as never);
    expect(error).not.toBeNull();
    void userId;
  });
});
```

- [ ] **Step 5: Run the tests, verify they pass**

```bash
npx vitest run tests/attendance/notifications-schema-live.test.ts
```

- [ ] **Step 6: Regenerate database types, typecheck, lint, commit**

```bash
npx supabase gen types typescript --project-id vfwcbkjvinbtcntwjrzq > src/types/database.ts
npx tsc --noEmit
npx eslint supabase/migrations/20261008010000_notifications_table.sql tests/attendance/notifications-schema-live.test.ts src/types/database.ts
git add supabase/migrations/20261008010000_notifications_table.sql tests/attendance/notifications-schema-live.test.ts src/types/database.ts
git commit -m "feat: add unified notifications + notification_broadcast_reads tables"
```

---

### Task 1: Writer RPCs — `create_notification`, `create_announcement`, `mark_notification_read`

**Files:**
- Create: `supabase/migrations/20261008020000_notification_writer_rpcs.sql`
- Test: `tests/attendance/notification-rpcs-live.test.ts`

Depends on Task 0 (the table must exist).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20261008020000_notification_writer_rpcs.sql
--
-- Sub-project 6, Task 1: the three security definer writer RPCs for the
-- notifications table. create_notification itself is security definer so
-- it can write to notifications regardless of its caller's own privileges
-- -- its CALLERS do not need to be security definer themselves (Postgres
-- runs a security definer function with the definer's own rights no
-- matter what context calls it). Specifically: enforce_session_lifecycle_
-- booking_sync() and promote_next_waitlist_candidate() (Task 3) are NOT
-- security definer today and must NOT be changed to become so just to
-- call this -- that would be an unrelated, unnecessary privilege
-- escalation. See the design spec's "Writer RPCs" section for the full
-- trust-boundary reasoning per caller.

create function create_notification(
  p_application_id  uuid,
  p_channel         notification_channel,
  p_title           text,
  p_body            text default null,
  p_link_path       text default null,
  p_session_id      uuid default null,
  p_old_start_time  timestamptz default null,
  p_new_start_time  timestamptz default null
) returns notifications
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row notifications;
begin
  insert into notifications (
    application_id, is_broadcast, channel, title, body, link_path,
    session_id, old_start_time, new_start_time
  ) values (
    p_application_id, false, p_channel, p_title, p_body, p_link_path,
    p_session_id, p_old_start_time, p_new_start_time
  )
  returning * into v_row;
  return v_row;
end;
$$;

-- No PUBLIC/anon/authenticated grant -- callable only by service_role
-- (direct RPC callers using the service-role client) or by other
-- security definer functions that call it internally. Participants never
-- call this directly.
revoke all on function create_notification(uuid, notification_channel, text, text, text, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function create_notification(uuid, notification_channel, text, text, text, uuid, timestamptz, timestamptz) to service_role;

create function create_announcement(p_title text, p_body text default null) returns notifications
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row notifications;
begin
  -- coalesce(is_staff(), false): is_staff() returns NULL (not false) for
  -- an anonymous caller (no profiles row keyed on auth.uid()) -- a bare
  -- `if not is_staff()` would silently never fire for that caller. Same
  -- NULL-bypass pattern this codebase has already hit and fixed twice
  -- (ops_dashboard_snapshot(), admit_walk_in()). No separate
  -- `or auth.role() = 'service_role'` carve-out here, unlike
  -- ops_dashboard_snapshot() -- this RPC is intended to be called only
  -- from a real staff session via the admin announcement page (Task 5),
  -- never from a service-role context or a live test fixture pretending
  -- to be staff without a real profiles row. If that assumption changes,
  -- add the carve-out explicitly and update this comment plus Testing
  -- Requirement 9's live test.
  if not coalesce(is_staff(), false) then
    raise exception 'Not authorized';
  end if;

  insert into notifications (application_id, is_broadcast, channel, title, body)
  values (null, true, 'announcement', p_title, p_body)
  returning * into v_row;
  return v_row;
end;
$$;

grant execute on function create_announcement(text, text) to authenticated;
revoke execute on function create_announcement(text, text) from public, anon;

create function mark_notification_read(p_notification_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row notifications;
  v_caller_application_id uuid;
begin
  select * into v_row from notifications where id = p_notification_id;
  if v_row.id is null then
    raise exception 'Notification not found';
  end if;

  select id into v_caller_application_id from applications where applicant_id = auth.uid();

  if v_row.is_broadcast then
    if v_caller_application_id is null then
      raise exception 'Not authorized';
    end if;
    insert into notification_broadcast_reads (notification_id, application_id)
    values (p_notification_id, v_caller_application_id)
    on conflict (notification_id, application_id) do nothing;
  else
    if v_row.application_id is distinct from v_caller_application_id or v_caller_application_id is null then
      raise exception 'Not authorized';
    end if;
    update notifications set read_at = coalesce(read_at, now()) where id = p_notification_id;
  end if;
end;
$$;

grant execute on function mark_notification_read(uuid) to authenticated;
revoke execute on function mark_notification_read(uuid) from public, anon;
```

- [ ] **Step 2: Apply live**

```bash
npx supabase db query --linked --file supabase/migrations/20261008020000_notification_writer_rpcs.sql
```

- [ ] **Step 3: Verify live via direct `pg_proc` query**

```bash
cat > /tmp/verify_notif_rpcs.sql << 'EOF'
select proname, pg_get_function_arguments(oid) from pg_proc
where proname in ('create_notification', 'create_announcement', 'mark_notification_read')
order by proname;
EOF
npx supabase db query --linked --file /tmp/verify_notif_rpcs.sql
```

- [ ] **Step 4: Write the failing live tests**

```typescript
// tests/attendance/notification-rpcs-live.test.ts
//
// Sub-project 6, Task 1: live tests for create_notification,
// create_announcement, mark_notification_read.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const notificationIds: string[] = [];

async function createApplicant(label: string, role: 'participant' | 'staff' = 'participant') {
  const { data: user, error } = await admin.auth.admin.createUser({
    email: `notif-rpc-${runId}-${label}@test.local`, password: 'password123', email_confirm: true,
  });
  if (error || !user.user) throw new Error(`Failed to create ${label}: ${error?.message}`);
  applicantUserIds.push(user.user.id);
  if (role === 'staff') {
    await admin.from('profiles').update({ role: 'staff' }).eq('id', user.user.id);
    return { userId: user.user.id, applicationId: null as string | null };
  }
  const { data: app, error: appError } = await admin
    .from('applications').insert({ applicant_id: user.user.id, status: 'accepted' }).select('id').single();
  if (appError || !app) throw new Error(`Failed to create application for ${label}: ${appError?.message}`);
  applicationIds.push(app.id);
  return { userId: user.user.id, applicationId: app.id as string };
}

afterAll(async () => {
  await admin.from('notification_broadcast_reads').delete().in('notification_id', notificationIds);
  await admin.from('notifications').delete().in('id', notificationIds);
  await admin.from('applications').delete().in('id', applicationIds);
  await Promise.allSettled(applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe('create_notification', () => {
  it('inserts exactly one personal row with the given channel/title', async () => {
    const { applicationId } = await createApplicant('create-notif');
    const { data, error } = await admin.rpc('create_notification' as never, {
      p_application_id: applicationId, p_channel: 'booking_confirmed', p_title: 'Your booking is confirmed',
    } as never);
    expect(error).toBeNull();
    const row = data as unknown as { id: string; is_broadcast: boolean; application_id: string };
    notificationIds.push(row.id);
    expect(row.is_broadcast).toBe(false);
    expect(row.application_id).toBe(applicationId);
  });
});

describe('create_announcement', () => {
  it('a staff caller inserts exactly one is_broadcast=true row', async () => {
    const { userId } = await createApplicant('announce-staff', 'staff');
    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: `notif-rpc-${runId}-announce-staff@test.local`, password: 'password123' });
    const { data, error } = await client.rpc('create_announcement' as never, { p_title: 'Welcome!', p_body: 'See you soon' } as never);
    expect(error).toBeNull();
    const row = data as unknown as { id: string; is_broadcast: boolean; application_id: string | null };
    notificationIds.push(row.id);
    expect(row.is_broadcast).toBe(true);
    expect(row.application_id).toBeNull();
    void userId;
  });

  it('a non-staff participant is rejected with Not authorized', async () => {
    const { userId } = await createApplicant('announce-participant');
    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: `notif-rpc-${runId}-announce-participant@test.local`, password: 'password123' });
    const { error } = await client.rpc('create_announcement' as never, { p_title: 'Should fail' } as never);
    expect(error).not.toBeNull();
    expect(error!.message).toContain('Not authorized');
    void userId;
  });

  it('an anonymous (unauthenticated) caller is rejected (coalesce(is_staff(), false) NULL-bypass guard)', async () => {
    const anonClient = createClient<Database>(URL, ANON_KEY);
    const { error } = await anonClient.rpc('create_announcement' as never, { p_title: 'Should fail' } as never);
    expect(error).not.toBeNull();
  });
});

describe('mark_notification_read', () => {
  it('marks the caller\'s own personal notification read', async () => {
    const { userId, applicationId } = await createApplicant('mark-read-own');
    const { data: row } = await admin.from('notifications').insert({
      is_broadcast: false, application_id: applicationId, channel: 'booking_confirmed', title: 'Test',
    } as never).select('id').single();
    const notifId = (row as { id: string }).id;
    notificationIds.push(notifId);

    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: `notif-rpc-${runId}-mark-read-own@test.local`, password: 'password123' });
    const { error } = await client.rpc('mark_notification_read' as never, { p_notification_id: notifId } as never);
    expect(error).toBeNull();

    const { data: after } = await admin.from('notifications').select('read_at').eq('id', notifId).single();
    expect((after as { read_at: string | null }).read_at).not.toBeNull();
    void userId;
  });

  it('rejects marking another participant\'s personal notification as read', async () => {
    const { applicationId: appA } = await createApplicant('mark-read-a');
    const { userId: userB } = await createApplicant('mark-read-b');
    const { data: row } = await admin.from('notifications').insert({
      is_broadcast: false, application_id: appA, channel: 'booking_confirmed', title: 'A\'s notification',
    } as never).select('id').single();
    const notifId = (row as { id: string }).id;
    notificationIds.push(notifId);

    const clientB = createClient<Database>(URL, ANON_KEY);
    await clientB.auth.signInWithPassword({ email: `notif-rpc-${runId}-mark-read-b@test.local`, password: 'password123' });
    const { error } = await clientB.rpc('mark_notification_read' as never, { p_notification_id: notifId } as never);
    expect(error).not.toBeNull();

    const { data: after } = await admin.from('notifications').select('read_at').eq('id', notifId).single();
    expect((after as { read_at: string | null }).read_at).toBeNull();
    void userB;
  });

  it('a broadcast read inserts into notification_broadcast_reads keyed to the caller, not a shared read_at', async () => {
    const { userId } = await createApplicant('mark-read-broadcast');
    const { data: row } = await admin.from('notifications').insert({
      is_broadcast: true, application_id: null, channel: 'announcement', title: 'Broadcast',
    } as never).select('id').single();
    const notifId = (row as { id: string }).id;
    notificationIds.push(notifId);

    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: `notif-rpc-${runId}-mark-read-broadcast@test.local`, password: 'password123' });
    const { error } = await client.rpc('mark_notification_read' as never, { p_notification_id: notifId } as never);
    expect(error).toBeNull();

    const { data: readRow } = await admin.from('notification_broadcast_reads').select('application_id').eq('notification_id', notifId).single();
    expect(readRow).not.toBeNull();
    void userId;
  });
});
```

- [ ] **Step 5: Run the tests, verify they pass**

```bash
npx vitest run tests/attendance/notification-rpcs-live.test.ts
```

- [ ] **Step 6: Regenerate types, typecheck, lint, commit**

```bash
npx supabase gen types typescript --project-id vfwcbkjvinbtcntwjrzq > src/types/database.ts
npx tsc --noEmit
npx eslint supabase/migrations/20261008020000_notification_writer_rpcs.sql tests/attendance/notification-rpcs-live.test.ts src/types/database.ts
git add supabase/migrations/20261008020000_notification_writer_rpcs.sql tests/attendance/notification-rpcs-live.test.ts src/types/database.ts
git commit -m "feat: add create_notification/create_announcement/mark_notification_read RPCs"
```

---

### Task 2: Realtime broadcast trigger + RLS policies

**Files:**
- Create: `supabase/migrations/20261008030000_notifications_realtime_broadcast.sql`
- Test: `tests/attendance/notifications-realtime-live.test.ts`

Depends on Task 0 only (triggers on the `notifications` table itself). Mirrors `supabase/migrations/20261006071000_ops_dashboard_snapshot.sql`'s broadcast-via-trigger pattern exactly — read that file in full before writing this one, don't re-derive the pattern from memory.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20261008030000_notifications_realtime_broadcast.sql
--
-- Sub-project 6, Task 2: Realtime broadcast-via-trigger for the
-- notifications table, mirroring sub-project 5a's established pattern
-- (20261006071000_ops_dashboard_snapshot.sql) exactly. Two channel
-- shapes: a single shared 'notifications-broadcast' topic for
-- is_broadcast rows, and a per-applicant 'notifications-<application_id>'
-- topic for personal rows -- each participant subscribes only to their
-- own personal topic plus the one shared broadcast topic.

create or replace function notify_participant_notification() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.is_broadcast then
    perform realtime.send(
      jsonb_build_object('id', new.id), 'change', 'notifications-broadcast', true
    );
  else
    perform realtime.send(
      jsonb_build_object('id', new.id), 'change',
      'notifications-' || new.application_id::text, true
    );
  end if;
  return new;
end;
$$;

create trigger notifications_notify_participant
  after insert on notifications
  for each row execute function notify_participant_notification();

-- Postgres has no `create policy if not exists` -- drop then create,
-- same pattern 5a's migration established.
drop policy if exists notifications_broadcast_channel_select on realtime.messages;
create policy notifications_broadcast_channel_select on realtime.messages
  for select to authenticated
  using (extension = 'broadcast' and realtime.topic() = 'notifications-broadcast');

drop policy if exists notifications_personal_channel_select on realtime.messages;
create policy notifications_personal_channel_select on realtime.messages
  for select to authenticated
  using (
    extension = 'broadcast'
    and realtime.topic() = 'notifications-' || (
      select id::text from applications where applicant_id = auth.uid() limit 1
    )
  );
  -- This policy's correctness relies on applications_one_per_applicant
  -- (20260721202027_applications_table.sql), a single-column unique index
  -- on applicant_id with no `where` clause -- confirmed structurally
  -- guaranteed, not just usually true. If that uniqueness is ever
  -- relaxed, this `limit 1` would silently pick an arbitrary application.
```

- [ ] **Step 2: Apply live, verify via direct trigger/policy query**

```bash
npx supabase db query --linked --file supabase/migrations/20261008030000_notifications_realtime_broadcast.sql

cat > /tmp/verify_notif_realtime.sql << 'EOF'
select tgname, tgrelid::regclass from pg_trigger where tgname = 'notifications_notify_participant';
select policyname from pg_policies where tablename = 'messages' and schemaname = 'realtime' and policyname like 'notifications%';
EOF
npx supabase db query --linked --file /tmp/verify_notif_realtime.sql
```

- [ ] **Step 3: Write the failing live test**

This cannot easily assert on the actual Realtime broadcast delivery itself in a server-side Vitest test (no WebSocket client subscription infrastructure exists in this test suite today) — test the trigger FIRES without error and the row still inserts correctly, which is what sub-project 5a's own live tests do for the identical pattern (check `tests/attendance/ops-dashboard-*.test.ts` if any exist for the exact established scope of what's tested here vs. left to manual/client verification).

```typescript
// tests/attendance/notifications-realtime-live.test.ts
//
// Sub-project 6, Task 2: confirms the broadcast-via-trigger fires without
// error for both personal and broadcast inserts (an AFTER INSERT trigger
// that raised would roll back the whole insert, so a successful insert is
// itself evidence the trigger ran cleanly). Does NOT assert on actual
// WebSocket delivery -- no such test infrastructure exists in this repo
// for the identical 5a pattern either; client-side delivery is verified
// manually/via the bell's own behavior in Task 7.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const notificationIds: string[] = [];

afterAll(async () => {
  await admin.from('notifications').delete().in('id', notificationIds);
  await admin.from('applications').delete().in('id', applicationIds);
  await Promise.allSettled(applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe('notifications realtime broadcast trigger', () => {
  it('a personal-row insert succeeds without the trigger raising', async () => {
    const { data: user } = await admin.auth.admin.createUser({
      email: `notif-realtime-${runId}-personal@test.local`, password: 'password123', email_confirm: true,
    });
    applicantUserIds.push(user!.user!.id);
    const { data: app } = await admin.from('applications').insert({ applicant_id: user!.user!.id, status: 'accepted' }).select('id').single();
    applicationIds.push(app!.id);

    const { data, error } = await admin.from('notifications').insert({
      is_broadcast: false, application_id: app!.id, channel: 'booking_confirmed', title: 'Trigger test',
    } as never).select('id').single();
    expect(error).toBeNull();
    notificationIds.push((data as { id: string }).id);
  });

  it('a broadcast-row insert succeeds without the trigger raising', async () => {
    const { data, error } = await admin.from('notifications').insert({
      is_broadcast: true, application_id: null, channel: 'announcement', title: 'Broadcast trigger test',
    } as never).select('id').single();
    expect(error).toBeNull();
    notificationIds.push((data as { id: string }).id);
  });
});
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/attendance/notifications-realtime-live.test.ts
```

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint supabase/migrations/20261008030000_notifications_realtime_broadcast.sql tests/attendance/notifications-realtime-live.test.ts
git add supabase/migrations/20261008030000_notifications_realtime_broadcast.sql tests/attendance/notifications-realtime-live.test.ts
git commit -m "feat: add Realtime broadcast-via-trigger for notifications"
```

---

### Task 3: Wire the 5 existing-event producers (acceptance/rejection, booking, cancel/reschedule, waitlist)

**Files:**
- Modify: `supabase/migrations/20261003000000_book_session_respects_allocation.sql` — **DO NOT edit this file directly** (it's already applied); instead create a new migration that `create or replace function`s `book_session` with the identical body plus the new insert, per this codebase's own established convention for modifying an existing function (see any prior sub-project's migrations for the pattern: copy the current body verbatim, then apply exactly the described change).
- Create: `supabase/migrations/20261008040000_wire_booking_confirmed_notification.sql`
- Create: `supabase/migrations/20261008050000_wire_session_lifecycle_notifications.sql` (updates `enforce_session_lifecycle_booking_sync()` and `promote_next_waitlist_candidate()` to also write to `notifications`, alongside their existing `session_notification_outbox` writes — NOT replacing them, see Step 1 below)
- Modify: `src/app/[locale]/(admin)/applications/[id]/actions.ts`
- Test: `tests/agenda/booking-confirmed-notification-live.test.ts`
- Test: extend `tests/agenda/session-lifecycle-notifications-live.test.ts` (existing file — add new assertions, don't replace existing ones)
- Test: `tests/attendance/application-decision-notification-live.test.ts`

Depends on Task 1 (`create_notification` must exist).

- [ ] **Step 1: Decide and document — dual-write, not cutover, for the 3 existing event types**

The spec's Event Wiring table says these 3 producers should insert into `notifications` "instead of" `session_notification_outbox`. **This plan deliberately deviates from a literal reading of that and implements a DUAL-write instead** (Step 3's SQL keeps every existing `session_notification_outbox` insert completely unchanged and adds a `notifications` insert alongside it) — specifically because this project's actual migration-apply workflow is a manual, human-triggered `supabase db query --linked --file ...` step, decoupled from the Vercel app-code deploy that ships Task 6's new cron (no CI/CD pipeline exists in this repo to make "deploy together" an atomic, enforceable unit — confirmed: no `.github/workflows/`, no deployment-gating config). A hard cutover would create a real window, of unpredictable length, where cancellation/reschedule/waitlist-promotion emails silently stop if these two tasks' manual steps land out of order — unacceptable this close to the conference. The dual-write makes the actual failure mode benign regardless of ordering: `process-session-notifications` (old cron, draining `session_notification_outbox`) keeps working exactly as it does today for as long as it exists, so these 3 email types never stop sending no matter when Task 6 lands. **The one genuinely risky moment is Task 6 Step 6 (deleting `process-session-notifications/route.ts`)** — do not perform that specific deletion until the new unified cron (Task 6 Step 3) has been confirmed live and actually processing rows (Task 6 Step 8's test passing is necessary but not sufficient — also confirm via a live check, e.g. query `notifications` for recently-`sent` rows, that the new cron has successfully run at least once in production before deleting the old one).

- [ ] **Step 2: `book_session` — add `booking_confirmed` notification**

The body below was fetched directly from the live database via `pg_get_functiondef(oid)` against the real COY21 project (`vfwcbkjvinbtcntwjrzq`) while writing this plan — it is the actual, current, complete function body, not a reconstruction from the original migration file. **Before applying this migration, re-run the same `pg_get_functiondef` query yourself and diff it against the body below** — if anything has changed since this plan was written, use the live version as ground truth and update this migration accordingly, don't trust this plan's copy blindly either.

```sql
-- supabase/migrations/20261008040000_wire_booking_confirmed_notification.sql
--
-- Body below is book_session's full current definition, fetched live via
-- pg_get_functiondef against vfwcbkjvinbtcntwjrzq during plan-writing
-- (2026-10-08) -- everything up to and including the session_bookings
-- insert is UNCHANGED from the current live function; the only addition
-- is the booking_confirmed notification block immediately after it.
drop function if exists book_session(uuid, uuid);

create or replace function book_session(p_application_id uuid, p_session_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session       sessions%rowtype;
  v_booking_id    uuid;
  v_count         int;
  v_deadline      timestamptz;
  v_preferred_language text;
  v_session_title text;
begin
  -- Caller must own this application
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  -- Lock the session row to prevent race on capacity
  select * into v_session from sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'Session not found';
  end if;
  if v_session.status not in ('published', 'confirmed') then
    raise exception 'Session is not open for booking';
  end if;

  v_deadline := session_effective_deadline(v_session);
  if now() > v_deadline then
    raise exception 'Booking deadline has passed';
  end if;

  -- Capacity check (combined: session_bookings + confirmed allocation_assignments)
  v_count := session_effective_occupied_count(p_session_id);
  if v_count >= v_session.capacity then
    raise exception 'Session is full';
  end if;

  -- Conflict check: any active booking for this participant that overlaps?
  if exists (
    select 1
    from session_bookings sb
    join sessions s on s.id = sb.session_id
    where sb.application_id = p_application_id
      and sb.status = 'active'
      and tstzrange(s.start_time, s.end_time, '[)') &&
          tstzrange(v_session.start_time, v_session.end_time, '[)')
  ) then
    raise exception 'Time conflict with an existing booking';
  end if;

  if exists (
    select 1
    from allocation_assignments aa
    join sessions s on s.id = aa.session_id
    where aa.application_id = p_application_id
      and aa.status = 'confirmed'
      and tstzrange(s.start_time, s.end_time, '[)') &&
          tstzrange(v_session.start_time, v_session.end_time, '[)')
  ) then
    raise exception 'Time conflict with an assigned session';
  end if;

  insert into session_bookings (application_id, session_id)
  values (p_application_id, p_session_id)
  returning id into v_booking_id;

  -- NEW: booking_confirmed notification. Resolve locale + session title
  -- directly here (same defensive ?? 'en' default pattern
  -- process-session-notifications/route.ts already uses, since
  -- preferred_language has no enum/check constraint -- free-text by
  -- convention only).
  select preferred_language into v_preferred_language from applications where id = p_application_id;
  select case when coalesce(v_preferred_language, 'en') = 'ar' then title_ar else title_en end
    into v_session_title from sessions where id = p_session_id;

  perform create_notification(
    p_application_id => p_application_id,
    p_channel => 'booking_confirmed',
    p_title => case when coalesce(v_preferred_language, 'en') = 'ar'
      then 'تم تأكيد حجزك في: ' || coalesce(v_session_title, '')
      else 'Your booking is confirmed: ' || coalesce(v_session_title, '') end,
    p_link_path => '/my-agenda',
    p_session_id => p_session_id
  );

  return v_booking_id;
end;
$$;

grant execute on function book_session(uuid, uuid) to authenticated;
```

- [ ] **Step 3: `enforce_session_lifecycle_booking_sync()` and `promote_next_waitlist_candidate()` — dual-write to `notifications`**

Same principle as Step 2: both bodies below were fetched live via `pg_get_functiondef` during plan-writing (2026-10-08) — re-confirm against the live database before applying, in case either changed since. Both are confirmed NOT `security definer` (plain `language plpgsql set search_path = public, pg_temp`) — do not add `security definer` to either; `create_notification`'s own `security definer` is sufficient (see Task 1's migration comment). Each function's existing `session_notification_outbox` insert(s) are left completely unchanged; a `perform create_notification(...)` call is added immediately alongside each one.

```sql
-- supabase/migrations/20261008050000_wire_session_lifecycle_notifications.sql
--
-- Both bodies below are the full current definitions, fetched live via
-- pg_get_functiondef during plan-writing (2026-10-08). Every existing
-- statement is unchanged; only the new perform create_notification(...)
-- calls are additions.

create or replace function enforce_session_lifecycle_booking_sync() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_candidate record;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    -- Session was just cancelled: mark every active booking as
    -- session_cancelled (distinct from participant-voluntary 'cancelled')
    -- and queue one notification per affected booking. Uses a writable CTE
    -- (UPDATE ... RETURNING feeding INSERT ... SELECT) to capture exactly
    -- the rows this statement updated, rather than a second lookup query
    -- that would need some other way to identify "the rows I just
    -- touched" (e.g. re-matching on cancelled_at = now() -- correct since
    -- now() is stable within one statement/transaction, but an indirect,
    -- easier-to-get-wrong way to express the same thing; the CTE form
    -- below is the one to actually implement, not an alternative to
    -- consider).
    with just_cancelled as (
      update session_bookings
      set status = 'session_cancelled', cancelled_at = now()
      where session_id = new.id and status = 'active'
      returning id, application_id, session_id
    )
    insert into session_notification_outbox (booking_id, application_id, session_id, notification_type)
    select id, application_id, session_id, 'session_cancelled' from just_cancelled;

    -- NEW: dual-write into the unified notifications table too. Loop
    -- rather than a set-based insert, since create_notification resolves
    -- locale/title per application individually (consistent with every
    -- other producer in this sub-project) and is a security definer RPC
    -- call, not a plain insert that a set-based approach could batch.
    for v_candidate in
      select sb.application_id, s.title_ar, s.title_en, a.preferred_language
      from session_bookings sb
      join sessions s on s.id = sb.session_id
      join applications a on a.id = sb.application_id
      where sb.session_id = new.id and sb.status = 'session_cancelled' and sb.cancelled_at = (
        select max(cancelled_at) from session_bookings where session_id = new.id and status = 'session_cancelled'
      )
    loop
      perform create_notification(
        p_application_id => v_candidate.application_id,
        p_channel => 'session_cancelled',
        p_title => case when coalesce(v_candidate.preferred_language, 'en') = 'ar'
          then 'تم إلغاء الجلسة: ' || coalesce(v_candidate.title_ar, v_candidate.title_en, '')
          else 'Session cancelled: ' || coalesce(v_candidate.title_en, v_candidate.title_ar, '') end,
        p_link_path => '/my-agenda/browse',
        p_session_id => new.id
      );
    end loop;

  elsif (new.start_time is distinct from old.start_time or new.end_time is distinct from old.end_time)
        and new.status <> 'cancelled' then
    -- Session's time changed (not a cancellation): bookings stay valid,
    -- queue one reschedule notification per active booking. This SELECT
    -- reads session_bookings without locking it (only the sessions row is
    -- locked for this UPDATE's duration) -- a concurrent book_session()
    -- landing a new active booking right now is correctly swept up (it's
    -- genuinely active at commit), and a concurrent cancel_booking() takes
    -- its own row-level FOR UPDATE lock on that specific booking, so the
    -- worst case is a benign notification-timing race (an extra reschedule
    -- email for a booking cancelled a moment later), never incorrect
    -- session_bookings state.
    insert into session_notification_outbox (booking_id, application_id, session_id, notification_type, old_start_time, new_start_time)
    select id, application_id, session_id, 'session_rescheduled', old.start_time, new.start_time
    from session_bookings
    where session_id = new.id and status = 'active';

    -- NEW: dual-write into notifications.
    for v_candidate in
      select sb.application_id, s.title_ar, s.title_en, a.preferred_language
      from session_bookings sb
      join sessions s on s.id = sb.session_id
      join applications a on a.id = sb.application_id
      where sb.session_id = new.id and sb.status = 'active'
    loop
      perform create_notification(
        p_application_id => v_candidate.application_id,
        p_channel => 'session_rescheduled',
        p_title => case when coalesce(v_candidate.preferred_language, 'en') = 'ar'
          then 'تم تغيير موعد الجلسة: ' || coalesce(v_candidate.title_ar, v_candidate.title_en, '')
          else 'Session rescheduled: ' || coalesce(v_candidate.title_en, v_candidate.title_ar, '') end,
        p_link_path => '/my-agenda',
        p_session_id => new.id,
        p_old_start_time => old.start_time,
        p_new_start_time => new.start_time
      );
    end loop;
  end if;

  return new;
end;
$$;

create or replace function promote_next_waitlist_candidate(p_session_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_session         sessions%rowtype;
  v_candidate       record;
  v_new_booking_id  uuid;
  v_preferred_language text;
begin
  select * into v_session from sessions where id = p_session_id;

  <<promotion>>
  for v_candidate in
    select sw.id, sw.application_id, sw.status
    from session_waitlist sw
    where sw.session_id = p_session_id
      and sw.status = 'waiting'
    order by sw.joined_at asc
    for update of sw
  loop
    -- Defense-in-depth, not closing a distinct gap: Postgres's FOR
    -- UPDATE / EvalPlanQual re-check already excludes a row a
    -- concurrent leave_waitlist withdrew before this loop's lock on
    -- it was granted, so this branch should be unreachable in
    -- practice -- kept as a guard against relying on undocumented
    -- planner behavior staying stable across a future Postgres
    -- version.
    if v_candidate.status is distinct from 'waiting' then
      continue;
    end if;

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
    values (v_candidate.application_id, p_session_id)
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
    values (v_new_booking_id, v_candidate.application_id, p_session_id, 'waitlist_promoted');

    -- NEW: dual-write into notifications.
    select preferred_language into v_preferred_language from applications where id = v_candidate.application_id;
    perform create_notification(
      p_application_id => v_candidate.application_id,
      p_channel => 'waitlist_promoted',
      p_title => case when coalesce(v_preferred_language, 'en') = 'ar'
        then 'تمت ترقيتك من قائمة الانتظار: ' || coalesce(v_session.title_ar, v_session.title_en, '')
        else 'You''ve been promoted from the waitlist: ' || coalesce(v_session.title_en, v_session.title_ar, '') end,
      p_link_path => '/my-agenda',
      p_session_id => p_session_id
    );

    exit promotion;
  end loop;
end;
$$;
```

**Note on the `enforce_session_lifecycle_booking_sync()` cancellation branch's recipient loop**: the existing CTE-based outbox insert (`just_cancelled as (update ... returning ...)`) only exists within that one statement's scope — a second statement cannot re-read a CTE's result set. The added loop above re-derives the same affected-booking set via `sb.status = 'session_cancelled' and sb.cancelled_at = (select max(cancelled_at) ...)`, which is correct given the CTE's `update` just set `cancelled_at = now()` on exactly those rows in the same transaction (so `now()` is stable and this `max()` correctly identifies them), but is a second query doing the work the CTE's `returning` already did once. If this bothers whoever implements it, an equally correct alternative is restructuring the CTE to feed both inserts in one `with` block — either is acceptable; don't spend implementation time on this unless the simpler re-query approach shown above turns out to be wrong in testing (Step 6's test will catch it if so).

- [ ] **Step 4: `updateApplicationStatusForCaller` — add acceptance/rejection notifications**

Modify `src/app/[locale]/(admin)/applications/[id]/actions.ts`. Insert a notification call after the status-update success check (after line ~82's `if (!updatedRows...)` block) and before the `accepted`-only `accept_application_and_issue_number` RPC call, branching on `newStatus`:

```typescript
// Immediately after the optimistic-concurrency success check, before the
// existing `if (newStatus === 'accepted')` block:
if (newStatus === 'accepted' || newStatus === 'rejected') {
  const { data: applicant } = await service
    .from('applications')
    .select('preferred_language')
    .eq('id', applicationId)
    .single();
  const locale = (applicant?.preferred_language as 'ar' | 'en') ?? 'en';
  const title = newStatus === 'accepted'
    ? (locale === 'ar' ? 'تم قبول طلبك!' : 'Your application has been accepted!')
    : (locale === 'ar' ? 'تحديث بخصوص طلبك' : 'Update on your application');
  const { error: notifError } = await service.rpc('create_notification' as never, {
    p_application_id: applicationId,
    p_channel: newStatus === 'accepted' ? 'application_accepted' : 'application_rejected',
    p_title: title,
    p_link_path: newStatus === 'accepted' ? '/my-dashboard' : '/my-application',
  } as never);
  if (notifError) {
    // Do not fail the whole status-change operation over a notification
    // write failure -- the status change itself already succeeded and
    // committed. Log and continue, matching this file's existing
    // tolerance pattern for the application_status_history insert below
    // (re-read that block's actual error handling before implementing
    // this -- match its exact behavior, don't invent a new one).
  }
}
```

**Before implementing this block literally**: re-read the existing `application_status_history` insert's error-handling at the end of the function (lines ~109-118) to confirm whether it throws on failure or logs-and-continues, and match that exact behavior for the new notification call rather than guessing — consistency within one function matters more than this plan's own prose guess.

- [ ] **Step 5: Apply all 3 migrations live, in order**

```bash
npx supabase db query --linked --file supabase/migrations/20261008040000_wire_booking_confirmed_notification.sql
npx supabase db query --linked --file supabase/migrations/20261008050000_wire_session_lifecycle_notifications.sql
```

- [ ] **Step 6: Write the failing tests**

`tests/agenda/booking-confirmed-notification-live.test.ts` — call `book_session` live, assert exactly one `notifications` row with `channel='booking_confirmed'`, correct `application_id`, correct locale title.

Extend `tests/agenda/session-lifecycle-notifications-live.test.ts` — read this existing file in full first (confirmed to exist, tests the trigger at the Postgres level against `session_notification_outbox`). Add new assertions in the SAME test cases (not new separate tests) that, after the existing `session_notification_outbox` assertions, ALSO check a matching `notifications` row now exists with the same `application_id`/`session_id` and the correct `channel`.

`tests/attendance/application-decision-notification-live.test.ts` — call `updateApplicationStatusForCaller` (the `...ForCaller` variant, injecting a caller directly, same pattern this file already establishes for live-testability without a request context) for both `accepted` and `rejected` transitions, assert exactly one `notifications` row each with the correct `channel`/locale-correct `title`.

- [ ] **Step 7: Run all 3, verify pass**

```bash
npx vitest run tests/agenda/booking-confirmed-notification-live.test.ts tests/agenda/session-lifecycle-notifications-live.test.ts tests/attendance/application-decision-notification-live.test.ts
```

- [ ] **Step 8: Regression check**

These migrations modify 3 existing, heavily-tested functions. Run their full existing live coverage:
```bash
npx vitest run tests/agenda/booking-rules-completion-live.test.ts tests/agenda/work-group-waitlist-live.test.ts
```
Both must still pass at their existing counts (30/30 and 17/17 respectively, per this project's own prior verification) — any regression here means the verbatim-copy step in Steps 2-3 introduced a behavioral change, not just an addition.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint supabase/migrations/20261008040000_wire_booking_confirmed_notification.sql supabase/migrations/20261008050000_wire_session_lifecycle_notifications.sql src/app/\[locale\]/\(admin\)/applications/\[id\]/actions.ts tests/agenda/booking-confirmed-notification-live.test.ts tests/agenda/session-lifecycle-notifications-live.test.ts tests/attendance/application-decision-notification-live.test.ts
git add supabase/migrations/20261008040000_wire_booking_confirmed_notification.sql supabase/migrations/20261008050000_wire_session_lifecycle_notifications.sql "src/app/[locale]/(admin)/applications/[id]/actions.ts" tests/agenda/booking-confirmed-notification-live.test.ts tests/agenda/session-lifecycle-notifications-live.test.ts tests/attendance/application-decision-notification-live.test.ts
git commit -m "feat: wire booking_confirmed/application_accepted/application_rejected/session_cancelled/session_rescheduled/waitlist_promoted into notifications table"
```

---

### Task 4: Email functions for the 3 new event types

**Files:**
- Modify: `src/lib/email/resend.ts`
- Test: extend `tests/email/` (new test file, following the exact mocking pattern of the existing `tests/email/session-lifecycle-notifications.test.ts` and `tests/email/work-group-waitlist-notification.test.ts` — read both in full first)

No code dependency on other tasks (can run in parallel with Tasks 0-3, but sequence it after Task 3 in execution since it's lower-risk/simpler and benefits from the notification-title conventions Task 3 establishes).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/email/application-decision-and-booking-notifications.test.ts
//
// Sub-project 6, Task 4: tests for sendApplicationAcceptedEmail,
// sendApplicationRejectedEmail, sendBookingConfirmedEmail,
// sendAnnouncementEmail -- new exports in src/lib/email/resend.ts.
// Mirrors tests/email/session-lifecycle-notifications.test.ts's exact
// mocking pattern (mock the Resend SDK class + fetchEmailSettings).
// [[Read tests/email/session-lifecycle-notifications.test.ts in full
//   before writing this file and copy its exact mock setup structure --
//   do not re-derive the mocking approach from scratch.]]
```

Write 4 new test suites (one per new function), each covering: EN body, AR body, and the "RESEND_API_KEY missing → error, no send attempted" case (matching the existing pattern's 3rd case per function).

- [ ] **Step 2: Run, verify fail** (functions don't exist yet)

- [ ] **Step 3: Implement the 4 new functions in `src/lib/email/resend.ts`**

Follow the exact per-function pattern every existing export uses (own subject/body ternary, `escapeHtml`-safe HTML via the existing module-level `escapeHtml` helper, `fetchEmailSettings()` + `sendEmailGuarded()`, same `Promise<{ id: string | null; error: string | null }>` return shape):

```typescript
export async function sendApplicationAcceptedEmail(params: {
  to: string; fullName: string; locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  // [[same structure as sendSessionCancellationNotificationEmail, lines
  //   151-192 of the current file -- copy its shape, not its content]]
}

export async function sendApplicationRejectedEmail(params: {
  to: string; fullName: string; locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> { /* ... */ }

export async function sendBookingConfirmedEmail(params: {
  to: string; fullName: string; sessionTitle: string; locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> { /* ... */ }

export async function sendAnnouncementEmail(params: {
  to: string; fullName: string; title: string; body: string | null; locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> { /* ... */ }
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run tests/email/application-decision-and-booking-notifications.test.ts
```

- [ ] **Step 5: Regression check**

```bash
npx vitest run tests/email/
```

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint src/lib/email/resend.ts tests/email/application-decision-and-booking-notifications.test.ts
git add src/lib/email/resend.ts tests/email/application-decision-and-booking-notifications.test.ts
git commit -m "feat: add email functions for application accept/reject, booking confirmed, announcement"
```

---

### Task 5: Admin announcement page

**Files:**
- Create: `src/app/[locale]/(admin)/announcements/page.tsx`
- Create: `src/app/[locale]/(admin)/announcements/announcement-form.tsx`
- Create: `src/app/[locale]/(admin)/announcements/actions.ts`
- Modify: `src/messages/en.json`, `src/messages/ar.json` (new `announcements` namespace — confirmed via plan-research that NO existing notification-related i18n keys exist anywhere, so this is entirely new, not an extension)
- Test: `tests/attendance/create-announcement-page-live.test.ts` (tests the Server Action, following `...ForCaller`-injection live-test convention)

Depends on Task 1 (`create_announcement` RPC).

- [ ] **Step 1: Write the failing live test for the Server Action**

```typescript
// tests/attendance/create-announcement-page-live.test.ts
// Follows the *ForCaller injected-caller pattern established elsewhere
// in this codebase for live-testability without a request context.
```
Test: staff caller succeeds and creates exactly one `is_broadcast=true` row; non-staff caller is rejected.

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Write `actions.ts`** (Server Action calling `create_announcement`, following `requireStaffCaller()`'s exact pattern already established in `src/app/[locale]/(admin)/applications/[id]/actions.ts` — import or replicate that helper, don't invent a new staff-check shape)

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Write `page.tsx` + `announcement-form.tsx`**

Minimal: title field, body field, send button. Server Component page gated the same way other admin pages in this codebase are (check an existing admin page under `src/app/[locale]/(admin)/` for the exact staff-redirect convention before inventing one). Client Component form calling the Server Action.

- [ ] **Step 6: Add i18n keys to both `en.json` and `ar.json`**

New `announcements` namespace: page title, title-field label, body-field label, send button, success message.

- [ ] **Step 7: Manual verification note**

No automated test for the page's own rendering (this codebase's established convention — component tests use `renderToStaticMarkup`, which won't exercise a Server Component page with data fetching meaningfully here). State explicitly in the task report that this was not browser-verified, per this project's own standing instruction not to falsely claim UI verification.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint "src/app/[locale]/(admin)/announcements/" tests/attendance/create-announcement-page-live.test.ts
git add "src/app/[locale]/(admin)/announcements/" src/messages/en.json src/messages/ar.json tests/attendance/create-announcement-page-live.test.ts
git commit -m "feat: add staff-only announcement composer page"
```

---

### Task 6: Unified `process-notifications` cron (replaces `process-session-notifications`, absorbs `session-reminders`/`travel-reminders` email dispatch)

**Files:**
- Create: `src/app/api/cron/process-notifications/route.ts`
- Modify: `src/app/api/cron/session-reminders/route.ts`
- Modify: `src/app/api/cron/travel-reminders/route.ts`
- Delete: `src/app/api/cron/process-session-notifications/route.ts` (superseded, but ONLY after the new cron is confirmed live in production — do not delete this file in the same step that creates the new cron; see Step 6's explicit sequencing below and Task 3 Step 1's dual-write rationale)
- Modify: `vercel.json`
- Test: `tests/attendance/process-notifications-cron.test.ts` (new — unit test with mocked dependencies, since NO precedent exists anywhere in this codebase for a live-HTTP cron-route test; confirmed during plan-research)

**This is the highest-risk task in the plan** — it touches 3 existing production cron routes and changes the actual email-sending mechanism for 2 of them. Depends on Tasks 1, 3, 4.

- [ ] **Step 1: Write the failing unit test for `process-notifications`**

Since no cron-route-testing precedent exists, establish one: mock the Supabase service-role client and `sendEmailGuarded`/the new `resend.ts` functions, construct a `NextRequest` with a correct `Authorization: Bearer <CRON_SECRET>` header, call the route's exported `GET` directly (same general shape as `tests/api/*.test.ts` Route Handler tests elsewhere in this codebase, e.g. `tests/api/admit-walk-in-route.test.ts` — read that file's structure first even though it's a different kind of route, for the "import and call GET/POST directly" convention).

Cover: `CRON_SECRET` missing → 500; wrong/missing bearer token → 403; pending non-broadcast row → correct email function dispatched based on `channel`, `email_status` updated to `sent`; pending broadcast row → queries all `accepted` applications, batches sends, marks `sent` with `error_message` summary if any batch member failed; already-`sent`/`failed` rows are never re-processed; **(Testing Requirement 6, explicit case)** mock the recipient query to return a different result on a second call than the first, simulating an applicant whose status changed between row-creation and cron-run — assert the excluded applicant's mocked email-send function is never invoked, confirming the lazy/send-time (not snapshotted-at-creation) evaluation this route's own code comment documents.

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Write `src/app/api/cron/process-notifications/route.ts`**

```typescript
// src/app/api/cron/process-notifications/route.ts
//
// Sub-project 6, Task 6: unified email-dispatch cron, replacing
// process-session-notifications (deleted this task) and absorbing
// session-reminders'/travel-reminders' direct-send logic (both modified
// this task to insert notifications rows instead of sending directly).
// Runs every 1 minute (vercel.json). Same CRON_SECRET Bearer-token guard
// as every other cron in this codebase -- copy isAuthorizedCronRequest
// verbatim from process-session-notifications/route.ts before deleting
// that file.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  sendSessionCancellationNotificationEmail, sendSessionRescheduleNotificationEmail,
  sendWaitlistPromotionNotificationEmail, sendApplicationAcceptedEmail,
  sendApplicationRejectedEmail, sendBookingConfirmedEmail, sendAnnouncementEmail,
} from '@/lib/email/resend';

const BATCH_SIZE = 25;
const BROADCAST_BATCH_SIZE = 10; // mirrors travel-reminders' existing batching

function isAuthorizedCronRequest(req: NextRequest, cronSecret: string): boolean {
  // [[copy verbatim from process-session-notifications/route.ts before deletion]]
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!isAuthorizedCronRequest(req, cronSecret)) return new NextResponse('Forbidden', { status: 403 });

  const service = createServiceRoleClient();
  const { data: rows } = await service
    .from('notifications' as never)
    .select('*')
    .eq('email_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  let sent = 0, failed = 0;

  for (const row of (rows ?? []) as never[]) {
    const r = row as { id: string; is_broadcast: boolean; application_id: string | null; channel: string; title: string; body: string | null; session_id: string | null; old_start_time: string | null; new_start_time: string | null };

    if (r.is_broadcast) {
      // Query recipients AT SEND TIME, not at create_announcement's
      // insert time -- an applicant whose status changes away from
      // 'accepted' in the narrow window between creation and this cron
      // running is correctly excluded (per the design spec's documented
      // lazy-evaluation decision). This is the ONE row that fans out to
      // many emails; still marked sent/failed as a single row afterward.
      const { data: recipients } = await service
        .from('applications').select('id, preferred_language, profiles!applications_applicant_id_fkey(full_name, email)').eq('status', 'accepted');
      let anyFailed = false;
      const list = recipients ?? [];
      for (let i = 0; i < list.length; i += BROADCAST_BATCH_SIZE) {
        const batch = list.slice(i, i + BROADCAST_BATCH_SIZE);
        const results = await Promise.all(batch.map(async (recipient) => {
          const profile = Array.isArray(recipient.profiles) ? recipient.profiles[0] : recipient.profiles;
          if (!profile?.email) return false;
          const locale = (recipient.preferred_language as 'ar' | 'en') ?? 'en';
          const { error } = await sendAnnouncementEmail({ to: profile.email, fullName: profile.full_name ?? '', title: r.title, body: r.body, locale });
          return !error;
        }));
        if (results.some((ok) => !ok)) anyFailed = true;
      }
      await service.from('notifications' as never).update({
        email_status: 'sent', sent_at: new Date().toISOString(),
        error_message: anyFailed ? 'One or more recipients failed; see send logs' : null,
      } as never).eq('id', r.id);
      sent++;
      continue;
    }

    // Personal row -- sequential, matching process-session-notifications'
    // existing concurrency model for this part (not Promise.all; only the
    // broadcast fan-out above uses batched concurrency, intentionally
    // two different models in one route, per the plan's own research notes).
    const { data: app } = await service
      .from('applications').select('preferred_language, profiles!applications_applicant_id_fkey(full_name, email)').eq('id', r.application_id).single();
    const profile = Array.isArray(app?.profiles) ? app.profiles[0] : app?.profiles;
    if (!profile?.email) {
      await service.from('notifications' as never).update({ email_status: 'failed', error_message: 'Missing profile/email' } as never).eq('id', r.id);
      failed++;
      continue;
    }
    const locale = (app?.preferred_language as 'ar' | 'en') ?? 'en';

    let result: { id: string | null; error: string | null };
    switch (r.channel) {
      case 'application_accepted': result = await sendApplicationAcceptedEmail({ to: profile.email, fullName: profile.full_name ?? '', locale }); break;
      case 'application_rejected': result = await sendApplicationRejectedEmail({ to: profile.email, fullName: profile.full_name ?? '', locale }); break;
      case 'booking_confirmed': result = await sendBookingConfirmedEmail({ to: profile.email, fullName: profile.full_name ?? '', sessionTitle: r.title, locale }); break;
      case 'session_cancelled': result = await sendSessionCancellationNotificationEmail({ to: profile.email, fullName: profile.full_name ?? '', sessionTitle: r.title, locale }); break;
      case 'session_rescheduled': result = await sendSessionRescheduleNotificationEmail({ to: profile.email, fullName: profile.full_name ?? '', sessionTitle: r.title, oldStartTime: r.old_start_time!, newStartTime: r.new_start_time!, locale }); break;
      case 'waitlist_promoted': result = await sendWaitlistPromotionNotificationEmail({ to: profile.email, fullName: profile.full_name ?? '', sessionTitle: r.title, locale }); break;
      // session_reminder / travel_reminder: [[Step 4/5 below move these
      //   crons' OWN existing email body construction into this cron --
      //   decide during implementation whether that means new resend.ts
      //   exports (following Task 4's pattern) or inlining the existing
      //   subject/body construction from session-reminders/route.ts and
      //   travel-reminders/route.ts directly here; either is acceptable,
      //   but must not silently drop the existing locale/content logic]]
      default: result = { id: null, error: `Unhandled channel: ${r.channel}` };
    }

    if (result.error) {
      await service.from('notifications' as never).update({ email_status: 'failed', error_message: result.error } as never).eq('id', r.id);
      failed++;
    } else {
      await service.from('notifications' as never).update({ email_status: 'sent', sent_at: new Date().toISOString() } as never).eq('id', r.id);
      sent++;
    }
  }

  return NextResponse.json({ processed: (rows ?? []).length, sent, failed });
}
```

- [ ] **Step 4: Modify `session-reminders/route.ts`** — replace its direct `sendEmailGuarded` call site (the per-recipient inner loop building subject/text/html) with a `create_notification` RPC call (`p_channel: 'session_reminder'`), preserving its exact existing 25-35 minute time-window query and active-booking resolution logic UNCHANGED (only the dispatch mechanism changes, per the design spec and Testing Requirement 8).

- [ ] **Step 5: Modify `travel-reminders/route.ts`** — replace `sendTravelReminder`'s internal `sendEmailGuarded` call with a `create_notification` RPC call (`p_channel: 'travel_reminder'`), preserving the exact existing no-`travel_legs`-row query and the `2026-11-05` cutoff check UNCHANGED, and preserving the existing 10-at-a-time `Promise.all` batching structure (now batching RPC calls instead of email sends — functionally equivalent concurrency shape).

- [ ] **Step 6: Delete `process-session-notifications/route.ts`** — this is the one genuinely risky step in the whole plan (re-read Task 3 Step 1's note in full). Do not perform this deletion until BOTH: (a) the new `process-notifications` cron (Step 3 above) has been applied/deployed and confirmed actually running in production (not just unit-test-passing — verify via a live query, e.g. `select channel, email_status, sent_at from notifications where email_status = 'sent' order by sent_at desc limit 5;` against the live DB, showing recent real sends), AND (b) Task 3's dual-write migrations are confirmed live (this should already be true if Task 3 was executed earlier in plan order, but re-confirm rather than assume). Until both are true, leave `process-session-notifications/route.ts` in place — it costs nothing to leave running briefly alongside the new cron (both reading from different tables, no conflict), and the dual-write means no email type depends on it being removed promptly.

- [ ] **Step 7: Update `vercel.json`**

```json
{
  "crons": [
    { "path": "/api/cron/session-reminders", "schedule": "*/5 * * * *" },
    { "path": "/api/cron/travel-reminders", "schedule": "0 9 * * *" },
    { "path": "/api/cron/process-notifications", "schedule": "* * * * *" },
    { "path": "/api/cron/process-session-no-shows", "schedule": "*/5 * * * *" }
  ]
}
```
(Replaces the `process-session-notifications` entry; `process-session-no-shows` untouched, per spec's scope.)

- [ ] **Step 8: Run the new unit test, verify pass**

```bash
npx vitest run tests/attendance/process-notifications-cron.test.ts
```

- [ ] **Step 9: Full regression check**

```bash
npx vitest run tests/email/ tests/agenda/ tests/attendance/
```

- [ ] **Step 10: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint src/app/api/cron/ vercel.json tests/attendance/process-notifications-cron.test.ts
git add src/app/api/cron/process-notifications src/app/api/cron/session-reminders src/app/api/cron/travel-reminders vercel.json tests/attendance/process-notifications-cron.test.ts
git rm src/app/api/cron/process-session-notifications/route.ts
git commit -m "feat: unify email dispatch into a single per-minute process-notifications cron"
```

---

### Task 7: Notification bell UI (participant shell)

**Files:**
- Create: `src/components/shell/notification-bell.tsx`
- Modify: `src/components/shell/topbar.tsx`
- Modify: `src/app/[locale]/(participant)/(shell)/layout.tsx` (needs to pass the caller's `application_id` down to `Topbar`/`NotificationBell` — `Topbar` currently has no DB access, confirmed during plan-research)
- Test: `src/components/shell/notification-bell.test.tsx` (co-located, following `src/components/scanner/*.test.ts`'s established exception to this codebase's `tests/` mirror convention — this is a Client Component with hook logic, same category)
- Modify: `src/messages/en.json`, `src/messages/ar.json`

Depends on Tasks 0-2 (table, RPCs, Realtime trigger).

- [ ] **Step 1: Write failing tests for the pure/extractable logic first**

Following this codebase's own established pattern (confirmed via `use-network-status.ts`/`use-scan-retry.ts` precedent from sub-project 5b): extract the debounce/fallback-poll timing logic as testable pure/factory functions before writing the stateful hook, since this repo has no `@testing-library/react` and a hook's internals can't be called outside a component render.

```typescript
// src/components/shell/notification-bell.test.ts (co-located, pure-logic
// tests only -- mirrors use-scan-retry.test.ts's pattern exactly)
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement `notification-bell.tsx`**

Client Component. Props: `applicationId: string | null` (null for a staff/non-participant context — though this component is scoped to the participant shell only, so should always be non-null in practice; guard defensively anyway). Subscribes to both `notifications-${applicationId}` and `notifications-broadcast` channels via `supabase.channel(name, { config: { private: true } })`, mirroring `ops-dashboard-client.tsx`'s exact debounce (1.5s) / max-wait (5s) / 30s-fallback-poll structure — read that file in full again before implementing, copy its structure, don't re-derive.

On mount and on triggered refetch: call a query/RPC that joins personal + broadcast rows into one list, resolves read-state. Per the spec's open implementation-plan decision, write this as a new RPC `get_my_notifications()` (simpler to reason about than a client-side two-query join + manual read-state merge, and avoids exposing `notification_broadcast_reads` to direct client select) — this RPC itself belongs in a migration; add it as Step 3a below before the component code that calls it.

- [ ] **Step 3a: Write the `get_my_notifications()` RPC migration**

```sql
-- supabase/migrations/20261008060000_get_my_notifications_rpc.sql
create function get_my_notifications() returns table (
  id uuid, is_broadcast boolean, channel notification_channel, title text, body text,
  link_path text, created_at timestamptz, is_read boolean
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_application_id uuid;
begin
  select id into v_application_id from applications where applicant_id = auth.uid();
  if v_application_id is null then
    raise exception 'Not authorized';
  end if;

  return query
    select n.id, n.is_broadcast, n.channel, n.title, n.body, n.link_path, n.created_at,
      (n.read_at is not null) as is_read
    from notifications n
    where not n.is_broadcast and n.application_id = v_application_id
    union all
    select n.id, n.is_broadcast, n.channel, n.title, n.body, n.link_path, n.created_at,
      (r.notification_id is not null) as is_read
    from notifications n
    left join notification_broadcast_reads r on r.notification_id = n.id and r.application_id = v_application_id
    where n.is_broadcast
    order by created_at desc;
end;
$$;

grant execute on function get_my_notifications() to authenticated;
revoke execute on function get_my_notifications() from public, anon;
```

Apply live, verify, add to this task's test file (a live test asserting the merged/ordered/read-state-correct shape), typecheck/lint, include in this task's commit.

- [ ] **Step 4: Wire `Topbar`/layout to pass `applicationId` through**

Modify `src/app/[locale]/(participant)/(shell)/layout.tsx` to fetch the signed-in user's `application_id` (it already does an auth check per plan-research; add an `applications` query alongside) and pass it as a new prop through to `Topbar`, which passes it to the new `<NotificationBell applicationId={...} />` rendered inside the existing `gap-3` div alongside `<UserMenu>` (per plan-research: `src/components/shell/topbar.tsx` lines 65-67).

- [ ] **Step 5: Add i18n keys** (bell aria-label, empty-state text, mark-all-read button if included — keep minimal per spec's narrow scope)

- [ ] **Step 6: Run tests, verify pass**

```bash
npx vitest run src/components/shell/notification-bell.test.ts
```

- [ ] **Step 7: Manual verification note**

State explicitly that Realtime delivery and visual rendering were not browser-verified (no browser automation in this environment, per this project's own standing practice) — the pure-logic tests and the live RPC test are what's actually been verified; say so plainly rather than implying more.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint src/components/shell/notification-bell.tsx src/components/shell/notification-bell.test.ts src/components/shell/topbar.tsx "src/app/[locale]/(participant)/(shell)/layout.tsx" supabase/migrations/20261008060000_get_my_notifications_rpc.sql
git add src/components/shell/notification-bell.tsx src/components/shell/notification-bell.test.ts src/components/shell/topbar.tsx "src/app/[locale]/(participant)/(shell)/layout.tsx" supabase/migrations/20261008060000_get_my_notifications_rpc.sql src/messages/en.json src/messages/ar.json
git commit -m "feat: add Realtime-driven notification bell to the participant shell"
```

---

### Task 8: Full sweep and final review

**Files:** None new — verification only.

- [ ] **Step 1: Full relevant-suite run**

```bash
npx vitest run tests/attendance tests/agenda tests/email src/components/shell
```

- [ ] **Step 2: Full typecheck and lint, compare against `master`'s baseline**

```bash
npx tsc --noEmit
npx eslint src/ tests/ supabase/
```
Compare any output against `master` via `git diff master -- <file>` before dismissing an error as pre-existing (known baseline: 2 pre-existing errors in `tests/attendance/qr-issuance-reservation.test.ts`/`qr-credentials-lifecycle-trigger.test.ts`, confirmed identical on `master` by this project's own prior verification).

- [ ] **Step 3: Verify `process-session-notifications/route.ts` was only deleted after the new cron was confirmed live**

Per Task 3 Step 1 and Task 6 Step 6: this plan uses a dual-write (not a hard cutover) specifically so there's no ordering constraint between Tasks 3 and 6 that could silently break production emails — the only genuinely risky single action is Task 6 Step 6's deletion. Explicitly confirm in this final review that the deletion happened only after a live query confirmed the new `process-notifications` cron had actually sent at least one real email in production (not just that its unit test passed). State this confirmation clearly in the final report regardless of how execution actually happened.

- [ ] **Step 4: Dispatch a final whole-branch code-reviewer subagent**

Covering the full diff against `master`. In addition to general code quality, explicitly re-verify: does `create_announcement`'s `coalesce(is_staff(), false)` check correctly reject anon (Task 1); do `enforce_session_lifecycle_booking_sync()`/`promote_next_waitlist_candidate()` remain non-`security definer` as intentionally decided (Task 3); does the bell correctly avoid gating on `email_status` anywhere (per the spec's explicit instruction); does the broadcast cron's lazy (send-time) recipient evaluation match the spec's documented decision, not a create-time snapshot.

- [ ] **Step 5: Proceed to `superpowers:finishing-a-development-branch`**

Given the tight pre-conference timeline, prefer "merge back to master locally" over a PR-and-wait flow unless the user specifically wants a PR for visibility — ask explicitly rather than assuming, since this is a judgment call outside this plan's authority to make silently.

---

## Timeline note for whoever executes this plan

8 tasks, each independently committable. Given the ~1-week-to-conference / 3-day-buffer constraint stated at the top of this plan: Tasks 0-2 (schema/RPCs/Realtime) are foundational and low-risk — do these first and fast. Task 6 (the unified cron) is the highest-risk, highest-blast-radius task — do not rush it, and do not skip Step 9's full regression run. Task 7 (the bell UI) is the most "nice to have but lowest functional risk if imperfect" piece — if time runs short, it is the most defensible task to de-scope or simplify further (e.g., ship without the 30s fallback poll, Realtime-only) rather than cutting corners on Task 3 or Task 6's correctness.
