-- status_history_and_email_log.sql
create table application_status_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  old_status application_status,
  new_status application_status not null,
  changed_by uuid references profiles(id),
  note text,
  created_at timestamptz not null default now()
);

create table email_log (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  template text not null,
  status text not null,
  sent_at timestamptz not null default now()
);
