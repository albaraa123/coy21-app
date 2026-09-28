-- resend_delivery_tracking_columns.sql
--
-- Production Resend delivery tracking (design doc section 14/15). Adds the
-- columns needed to correlate a Resend webhook event back to the correct
-- participant_account_provisioning row and to record delivery lifecycle
-- timestamps/failure detail. Additive and non-destructive.
--
-- resend_email_id is the correlation key: Resend's webhook payload includes
-- data.email_id, which matches the id returned by emails.send() at send
-- time -- looking up the provisioning row by this id (not by recipient
-- email, which could theoretically collide across resends) is how the
-- webhook handler finds the right row.
alter table participant_account_provisioning add column resend_email_id text;
alter table participant_account_provisioning add column delivered_at timestamptz;
alter table participant_account_provisioning add column bounced_at timestamptz;
-- last_send_attempt_at is distinct from the existing last_attempt_at
-- (which covers provisioning attempts generally, e.g. account-creation
-- retries) -- this one specifically marks the moment the send API call was
-- made, independent of whether it succeeded.
alter table participant_account_provisioning add column last_send_attempt_at timestamptz;

create index participant_account_provisioning_resend_email_id_idx
  on participant_account_provisioning (resend_email_id)
  where resend_email_id is not null;

comment on column participant_account_provisioning.resend_email_id is
  'Resend''s email id, returned by emails.send() and echoed in every '
  'webhook event for that email. The correlation key the webhook handler '
  'uses to find the right row -- never derived from recipient email alone.';

------------------------------------------------------------------
-- resend_webhook_events -- idempotency ledger for the webhook endpoint.
-- Resend's webhooks are delivered via Svix, which retries on a non-2xx
-- response and stamps every delivery attempt (including retries of the
-- SAME logical event) with the same `svix-id` header. Recording that id
-- here and checking it first is what makes duplicate delivery safe: a
-- retried delivery is detected and short-circuited before any provisioning
-- row is touched a second time.
------------------------------------------------------------------
create table resend_webhook_events (
  svix_id text primary key,
  event_type text not null,
  resend_email_id text,
  received_at timestamptz not null default now()
);

alter table resend_webhook_events enable row level security;
-- No client-facing policy at all: this table is written exclusively by the
-- webhook route handler's service-role client and read by nothing else.
-- Default-deny (RLS enabled, zero policies) matches this schema's existing
-- pattern for service-role-only tables (e.g. audit_logs' insert path).

