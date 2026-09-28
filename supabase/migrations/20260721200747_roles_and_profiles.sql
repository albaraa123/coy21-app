-- roles_and_profiles.sql
create type user_role as enum (
  'participant',
  'super_admin',
  'registration_admission_manager',
  'agenda_allocation_manager',
  'communications_attendance_manager'
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'participant',
  full_name text not null,
  email text not null,
  created_at timestamptz not null default now()
);

create function handle_new_user() returns trigger as $$
begin
  insert into profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
