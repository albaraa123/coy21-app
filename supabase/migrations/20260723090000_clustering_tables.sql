-- clustering_tables.sql
create table clustering_runs (
  id uuid primary key default gen_random_uuid(),
  feature_extraction_run_id uuid not null references feature_extraction_runs(id),
  k int not null,
  random_seed int not null,
  status text not null,
  run_at timestamptz not null default now(),
  run_by uuid not null references profiles(id),

  constraint clustering_runs_k_positive check (k > 0),
  constraint clustering_runs_status_valid check (status in ('completed', 'failed'))
);

create table clusters (
  id uuid primary key default gen_random_uuid(),
  clustering_run_id uuid not null references clustering_runs(id) on delete cascade,
  label text,
  centroid jsonb not null,
  member_count int not null default 0
);

create table cluster_memberships (
  id uuid primary key default gen_random_uuid(),
  cluster_id uuid not null references clusters(id) on delete cascade,
  application_id uuid not null references applications(id),
  distance_to_centroid numeric not null,

  constraint cluster_memberships_unique unique (cluster_id, application_id)
);

create index clustering_runs_feature_run_idx on clustering_runs (feature_extraction_run_id);
create index clusters_clustering_run_idx on clusters (clustering_run_id);
create index cluster_memberships_cluster_idx on cluster_memberships (cluster_id);
create index cluster_memberships_application_idx on cluster_memberships (application_id);
