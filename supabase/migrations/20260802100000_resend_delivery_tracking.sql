-- resend_delivery_tracking.sql
--
-- Production Resend delivery tracking for the Phase C login-details email
-- (docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md,
-- section 14/15). Additive and non-destructive: widens the existing
-- provisioning_email_status enum with delivery-lifecycle values and adds
-- the columns needed to correlate a Resend webhook event back to the
-- correct provisioning row.

------------------------------------------------------------------
-- provisioning_email_status: add 'delivered' and 'bounced'. 'sending' and
-- 'failed' already exist from Phase C; 'not_sent'/'sent' too. New values
-- only ever set by: the send call itself ('sending' immediately before
-- the API call, 'sent' on a successful response) and the webhook handler
-- ('delivered'/'bounced' on the corresponding Resend event).
------------------------------------------------------------------
alter type provisioning_email_status add value 'delivered';
alter type provisioning_email_status add value 'bounced';
