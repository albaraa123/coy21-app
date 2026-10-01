-- 20261002000000_sessions_day_match_europe_istanbul.sql
--
-- Switches enforce_session_day_match() from Asia/Muscat to Europe/Istanbul,
-- matching the conference's actual location (Antalya, Türkiye). Turkey
-- observes a fixed UTC+3 offset year-round (no DST since 2016), and
-- Postgres ships its own IANA tzdata, so 'Europe/Istanbul' is valid and
-- correct directly in AT TIME ZONE here (this is unrelated to the
-- JavaScript-side 'Asia/Istanbul' bug fixed in application code separately
-- — that was an invalid IANA string; this is a valid one, just the wrong
-- city, being corrected).
--
-- The exception message text is NOT changed — it is pattern-matched
-- elsewhere (see supabase/migrations/20260723030000_document_trigger_cross_references.sql's
-- comment on this function for the full contract).
create or replace function enforce_session_day_match() returns trigger as $$
declare
  v_conference_date date;
  v_start_date date;
  v_end_date date;
begin
  select conference_date into v_conference_date from conference_days where id = new.conference_day_id;
  if v_conference_date is null then
    raise exception 'conference_day_id % does not exist', new.conference_day_id;
  end if;

  v_start_date := (new.start_time at time zone 'Europe/Istanbul')::date;
  v_end_date := (new.end_time at time zone 'Europe/Istanbul')::date;

  if v_start_date <> v_end_date then
    raise exception 'Session cannot span across midnight into a different conference day (start: %, end: %)', v_start_date, v_end_date;
  end if;

  if v_start_date <> v_conference_date then
    raise exception 'Session start/end time (%) does not match its conference day (%)', v_start_date, v_conference_date;
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function enforce_session_day_match() is 'Fires on sessions insert/update of start_time, end_time, conference_day_id. Enforces that a session''s start/end time (converted to Europe/Istanbul) falls on the same calendar date as its conference_day_id''s conference_date, and does not cross midnight. Contract: the raise exception message "Session start/end time (%) does not match its conference day (%)" contains the substring ''does not match its conference day'', which Task 12''s translateSessionWriteError() (src/app/[locale]/(admin)/agenda/sessions/[id]/actions.ts) matches via error.message.includes(''does not match its conference day'') to produce a friendly UI error. Do not reword this message without updating that function too.';
