// src/app/api/webhooks/resend/route.ts
//
// Production Resend webhook endpoint (design doc section 14/15, §8).
// Receives delivery-lifecycle events (delivered/bounced/failed) for the
// login-details emails sent from /participants/accounts and updates the
// matching participant_account_provisioning row.
//
// Signature verification uses the installed Resend SDK's own
// Webhooks.verify() (resend@6.18.0, confirmed against
// node_modules/resend/dist/index.d.mts before writing this file — it
// takes { payload, headers, webhookSecret } and returns the parsed,
// TYPED event, throwing on an invalid/missing signature). Resend delivers
// webhooks via Svix, so signature verification and the svix-id header
// (used below for idempotency) follow Svix's standard webhook contract,
// not a hand-rolled HMAC check.
import { Resend } from 'resend';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getWebhookSecret } from '@/lib/email/resend-config';

// Route handlers in this Next.js version receive a real Request — payload
// must be read as raw text (not parsed JSON) because Webhooks.verify()
// needs the EXACT byte-for-byte body to check the signature against; a
// parse-then-restringify round trip can alter whitespace and break
// verification.
export async function POST(request: Request): Promise<Response> {
  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) {
    // Fail clearly and safely: an unconfigured secret must reject every
    // webhook request, never silently accept an unverified event.
    console.error('resend webhook: RESEND_WEBHOOK_SECRET is not configured');
    return new Response(JSON.stringify({ error: 'Webhook not configured' }), { status: 503 });
  }

  const payload = await request.text();

  // The SDK's Webhooks.verify() expects the 3 Svix signature headers as a
  // plain { id, timestamp, signature } object (confirmed against
  // node_modules/resend/dist/index.d.mts's own Headers interface — this is
  // NOT the DOM Headers type despite the name), not the raw Request
  // headers object. A request missing any of the three is never a validly
  // signed webhook.
  const svixIdHeader = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  const svixSignature = request.headers.get('svix-signature');
  if (!svixIdHeader || !svixTimestamp || !svixSignature) {
    return new Response(JSON.stringify({ error: 'Missing signature headers' }), { status: 401 });
  }

  let event;
  try {
    // A bare `new Resend()` here (not the lazy getResendClient from
    // resend.ts) is deliberate: Webhooks.verify() is a pure signature/
    // payload check that needs no real API key to function correctly. The
    // SDK's constructor still throws on a falsy key ("Missing API key"),
    // confirmed directly — so a non-empty placeholder is passed rather
    // than pulling in the send-path's real API-key requirement for a code
    // path that never sends anything.
    const resend = new Resend('webhook_verify_only');
    event = resend.webhooks.verify({
      payload,
      headers: { id: svixIdHeader, timestamp: svixTimestamp, signature: svixSignature },
      webhookSecret,
    });
  } catch (err) {
    console.error('resend webhook: signature verification failed', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
  }

  // Idempotency: Svix stamps every delivery attempt (including retries of
  // the SAME logical event) with the same svix-id header. Recording it in
  // resend_webhook_events and checking first makes duplicate delivery a
  // safe, detected no-op rather than a double-applied state transition.
  const service = createServiceRoleClient();

  const { error: insertError } = await service
    .from('resend_webhook_events')
    .insert({ svix_id: svixIdHeader, event_type: event.type, resend_email_id: 'email_id' in event.data ? event.data.email_id : null });
  if (insertError) {
    // A unique-constraint violation on svix_id means this exact delivery
    // attempt was already processed — acknowledge with 200 so Svix stops
    // retrying, without touching the provisioning row a second time.
    if (insertError.code === '23505') {
      return new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200 });
    }
    console.error('resend webhook: failed to record event for idempotency', insertError.message);
    // Fall through and still process the event — losing the idempotency
    // record is not a reason to drop a real delivery/bounce update.
  }

  // Only email.* events carry an email_id we can correlate to a
  // provisioning row; other event types (contact.*, domain.*) are
  // acknowledged and ignored.
  if (!('email_id' in event.data)) {
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }

  const emailId = event.data.email_id;
  const nowIso = new Date().toISOString();

  switch (event.type) {
    case 'email.delivered': {
      await service
        .from('participant_account_provisioning')
        .update({ email_status: 'delivered', delivered_at: nowIso })
        .eq('resend_email_id', emailId);
      break;
    }
    case 'email.bounced': {
      const bounce = 'bounce' in event.data ? event.data.bounce : null;
      await service
        .from('participant_account_provisioning')
        .update({
          email_status: 'bounced',
          bounced_at: nowIso,
          last_error_code: bounce?.type ?? 'bounced',
          // Resend's own bounce.message is already a safe, user-facing
          // summary (not a raw driver exception) — safe to store directly.
          last_error_message: bounce?.message ?? 'Email bounced',
        })
        .eq('resend_email_id', emailId);
      break;
    }
    case 'email.failed': {
      const failed = 'failed' in event.data ? event.data.failed : null;
      await service
        .from('participant_account_provisioning')
        .update({
          email_status: 'failed',
          last_error_code: 'send_failed',
          last_error_message: failed?.reason ?? 'Email failed to send',
        })
        .eq('resend_email_id', emailId);
      break;
    }
    case 'email.sent': {
      // Confirms the send that emails.send() already recorded as 'sent' —
      // no-op for status (already correct), but useful as a durability
      // signal if a future revision needs to distinguish "API call
      // succeeded" from "Resend confirmed queuing" without a schema change.
      break;
    }
    default:
      // Every other event type (opened, clicked, complained, suppressed,
      // delivery_delayed, scheduled) is acknowledged but not tracked —
      // out of this feature's scope (only delivered/bounced/failed are
      // required per the design).
      break;
  }

  // Never echo participant data (email, name) back in the response —
  // acknowledge only.
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}
