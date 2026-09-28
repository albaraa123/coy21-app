-- import_staging_tables.sql
create table import_mapping_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  header_signature text not null,
  original_headers jsonb not null,
  mappings jsonb not null,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  version int not null default 1
);

create index import_mapping_templates_signature_idx on import_mapping_templates (header_signature);

create table import_batches (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid not null references profiles(id),
  original_filename text not null,
  file_checksum text not null,
  storage_path text not null,
  sheet_name text,
  row_count int,
  mapping_template_id uuid references import_mapping_templates(id),

  status text not null default 'uploaded',
  valid_count int not null default 0,
  warning_count int not null default 0,
  error_count int not null default 0,
  duplicate_count int not null default 0,
  inserted_count int not null default 0,
  updated_count int not null default 0,
  skipped_count int not null default 0,

  auto_process_downstream boolean not null default false,
  auto_process_cluster_k int,
  downstream_status text,

  processing_lock_token uuid,
  processing_lock_expires_at timestamptz,
  next_chunk_offset int not null default 0,

  failure_reason text,
  uploaded_at timestamptz not null default now(),
  confirmed_at timestamptz,
  completed_at timestamptz,

  constraint import_batches_status_valid check (status in (
    'uploaded', 'analyzing', 'awaiting_mapping', 'validating', 'ready_to_import',
    'importing', 'imported', 'processing_features', 'clustering', 'allocating',
    'completed', 'completed_with_warnings', 'failed', 'rolled_back'
  )),
  constraint import_batches_auto_process_k_required check (
    not auto_process_downstream or auto_process_cluster_k is not null
  ),
  constraint import_batches_cluster_k_positive check (auto_process_cluster_k is null or auto_process_cluster_k > 0)
);

create table import_column_mappings (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references import_batches(id) on delete cascade,
  source_column_index int not null,
  source_column_header text not null,
  target_kind text not null,
  target_key text,
  confidence numeric,
  is_manual_override boolean not null default false,

  constraint import_column_mappings_target_kind_valid check (target_kind in ('core_field', 'known_answer', 'generic_answer', 'ignored')),
  constraint import_column_mappings_confidence_range check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint import_column_mappings_unique unique (import_batch_id, source_column_index)
);

create table import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references import_batches(id) on delete cascade,
  excel_row_number int not null,
  row_fingerprint text not null,
  raw_row jsonb not null,
  normalized_row jsonb,

  validation_status text not null default 'pending',
  warnings jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  duplicate_status text,
  duplicate_of_row_id uuid references import_rows(id),

  destination_application_id uuid references applications(id),
  action_taken text,

  previous_application_snapshot jsonb,
  previous_answers_snapshot jsonb,

  constraint import_rows_validation_status_valid check (validation_status in ('pending', 'valid', 'warning', 'invalid')),
  constraint import_rows_duplicate_status_valid check (duplicate_status is null or duplicate_status in ('duplicate_in_file', 'existing_unclaimed', 'existing_claimed', 'blocked_downstream')),
  constraint import_rows_action_taken_valid check (action_taken is null or action_taken in ('inserted', 'updated', 'skipped_unchanged', 'skipped_error', 'blocked')),
  constraint import_rows_unique_row unique (import_batch_id, excel_row_number)
);

create index import_rows_batch_idx on import_rows (import_batch_id);
create index import_rows_fingerprint_idx on import_rows (row_fingerprint);
