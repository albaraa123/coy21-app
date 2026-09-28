-- application_answers_table.sql
create table application_answers (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  question_key text not null,
  question_label text,
  normalized_value text,
  raw_value text not null,
  value_type text not null,
  source text not null default 'import',
  is_sensitive boolean not null default false,
  import_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint application_answers_value_type_valid check (value_type in ('text', 'multiselect', 'boolean', 'number', 'date')),
  constraint application_answers_source_valid check (source in ('import', 'manual')),
  -- One answer per (application, question_key, source): a later import
  -- updates the existing row for the same question_key rather than
  -- inserting a duplicate. See design spec § application_answers.
  constraint application_answers_unique unique (application_id, question_key, source)
);

create index application_answers_application_idx on application_answers (application_id);
create trigger application_answers_set_updated_at before update on application_answers
  for each row execute function extensions.moddatetime('updated_at');
