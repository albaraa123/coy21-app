-- RPC used by the reports page to count how many distinct accepted participants
-- have submitted at least one travel leg.
create or replace function count_distinct_travellers()
returns bigint
language sql
security definer
stable
as $$
  select count(distinct tl.application_id)
  from travel_legs tl
  join applications a on a.id = tl.application_id
  where a.status = 'accepted';
$$;

-- Only allow staff/service-role calls; no direct anon access needed.
revoke execute on function count_distinct_travellers() from public;
grant execute on function count_distinct_travellers() to service_role;
