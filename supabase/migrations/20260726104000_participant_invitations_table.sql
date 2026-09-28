-- participant_invitations_table.sql
create table participant_invitations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  imported_email text not null,
  invited_user_id uuid references profiles(id),

  status text not null default 'not_sent',
  sent_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,
  last_error text,
  sent_by uuid references profiles(id),
  resend_count int not null default 0,

  constraint participant_invitations_status_valid check (status in (
    'not_sent', 'sending', 'sent', 'accepted', 'expired', 'revoked', 'failed'
  )),
  constraint participant_invitations_one_per_application unique (application_id)
);

create index participant_invitations_invited_user_idx on participant_invitations (invited_user_id);
