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
