-- schedule_change_detection_triggers.sql

-- Records a deduplicated change event for a session — nothing else. No
-- participant fan-out, no schedule_publication_items writes, no revision
-- creation happen here or anywhere in this migration. This is deliberate:
-- per the approved design, only a server-side orchestrator (Task 8) may
-- mark items stale/pending_review, and only the publication engine
-- (Tasks 9-10) may ever create/activate a revision — never a trigger.
-- ON CONFLICT DO NOTHING against the unprocessed-event dedup index means a
-- session_people delete-and-reinsert operation (two row-level trigger
-- firings) collapses to one unprocessed event, never two, and never an
-- event recorded from an incomplete intermediate state.
create function record_schedule_change_event(p_session_id uuid, p_change_type text) returns void as $$
begin
  insert into schedule_change_events (session_id, change_type)
  values (p_session_id, p_change_type)
  on conflict (session_id, change_type) where processed_at is null do nothing;
end;
$$ language plpgsql set search_path = public, pg_temp;

create function sessions_record_change_event() returns trigger as $$
begin
  if new.start_time is distinct from old.start_time
     or new.end_time is distinct from old.end_time
     or new.room_id is distinct from old.room_id
  then
    perform record_schedule_change_event(new.id, 'time_or_room');
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform record_schedule_change_event(new.id, 'cancelled');
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_change_detection
  after update on sessions
  for each row
  execute function sessions_record_change_event();

create function session_people_record_change_event() returns trigger as $$
declare
  v_session_id uuid;
begin
  v_session_id := coalesce(new.session_id, old.session_id);
  perform record_schedule_change_event(v_session_id, 'speakers');
  return coalesce(new, old);
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger session_people_change_detection
  after insert or update or delete on session_people
  for each row
  execute function session_people_record_change_event();
