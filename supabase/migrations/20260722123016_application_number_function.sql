-- application_number_function.sql
-- Sequence-backed application number generator. Wrapping nextval() in a SQL
-- function lets the server action call it via rpc() and get an atomic,
-- race-free increment (a count(*)-based scheme would race under concurrent
-- submits).
create function next_application_number() returns text as $$
  select 'RCOY-2026-' || lpad(nextval('application_number_seq')::text, 5, '0');
$$ language sql;
