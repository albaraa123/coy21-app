-- 20261025000300_sync_profile_email_on_confirm.sql
--
-- supabase.auth.updateUser({ email }) triggers Supabase's own
-- confirmation-email flow. With double_confirm_changes = true (verified
-- on the live project before this migration was written -- see this
-- migration's own commit message), auth.users.email only updates AFTER
-- the user clicks the confirmation link, not optimistically. This
-- trigger syncs profiles.email from auth.users.email only when that
-- real, post-confirmation update happens -- profiles.email never shows
-- an unconfirmed email.
create or replace function sync_profile_email_on_confirm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles set email = new.email where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_confirmed on auth.users;
create trigger on_auth_user_email_confirmed
  after update of email on auth.users
  for each row
  execute function sync_profile_email_on_confirm();
