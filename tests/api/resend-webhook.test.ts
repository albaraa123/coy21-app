// tests/api/resend-webhook.test.ts
//
// Live integration coverage for the Resend webhook route (design doc
// section 14/15, §8). Uses `standardwebhooks` directly (the same package
// resend@6.18.0 vendors internally for Webhooks.verify() — confirmed via
// node_modules/resend/dist/index.mjs's own `import { Webhook } from
// "standardwebhooks"`) to generate GENUINELY valid Svix-style signatures
// for the "accepted" test cases, so signature verification is exercised
// for real, not mocked away. Writes to the real Supabase project
// (participant_account_provisioning, resend_webhook_events) — no email is
// ever sent by this suite.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { Webhook } from 'standardwebhooks';
import type { Database } from '@/types/database';
import { POST } from '@/app/api/webhooks/resend/route';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);

// Svix/Standard Webhooks secrets are "whsec_" + base64 — a plain string
// after the prefix fails base64 decoding inside standardwebhooks'
// constructor (confirmed directly against node_modules/standardwebhooks/
// dist/index.js). Using a real base64-encoded value here so the SAME
// signing path production actually uses is exercised for real.
const WEBHOOK_SECRET = `whsec_${Buffer.from('test-secret-for-resend-webhook-tests-32b').toString('base64')}`;
const EMAIL_PREFIX = `resend-webhook-live-${runId}-`;

let applicationId: string;
const resendEmailId = `${EMAIL_PREFIX}email-id`;

function signedRequest(body: unknown, opts: { msgId?: string; secret?: string } = {}): Request {
  const payload = JSON.stringify(body);
  const msgId = opts.msgId ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const timestamp = new Date();
  const wh = new Webhook(opts.secret ?? WEBHOOK_SECRET);
  const signature = wh.sign(msgId, timestamp, payload);

  return new Request('http://localhost/api/webhooks/resend', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': msgId,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': signature,
    },
    body: payload,
  });
}

beforeAll(async () => {
  process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;

  const { data, error } = await admin
    .from('applications')
    .insert({ applicant_id: null, imported_email: `${EMAIL_PREFIX}participant@example.com`, status: 'accepted', full_name: 'Webhook Test Person' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to seed application: ${error?.message}`);
  applicationId = data.id;

  await admin.from('participant_account_provisioning').insert({
    application_id: applicationId,
    normalized_email: `${EMAIL_PREFIX}participant@example.com`,
    account_status: 'password_change_required',
    email_status: 'sent',
    resend_email_id: resendEmailId,
  });
}, 30000);

afterEach(async () => {
  // Each test may advance email_status/timestamps; reset between tests so
  // they don't interfere with each other's assertions.
  await admin
    .from('participant_account_provisioning')
    .update({ email_status: 'sent', delivered_at: null, bounced_at: null, last_error_code: null, last_error_message: null })
    .eq('application_id', applicationId);
  await admin.from('resend_webhook_events').delete().like('svix_id', 'msg_%');
});

afterAll(async () => {
  if (applicationId) await admin.from('applications').delete().eq('id', applicationId);
}, 30000);

describe('POST /api/webhooks/resend — signature verification', () => {
  it('rejects a request with an invalid signature', async () => {
    const wrongSecret = `whsec_${Buffer.from('a-completely-different-secret-value').toString('base64')}`;
    const request = signedRequest({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: resendEmailId } }, { secret: wrongSecret });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it('rejects a request missing the signature headers entirely', async () => {
    const request = new Request('http://localhost/api/webhooks/resend', {
      method: 'POST',
      body: JSON.stringify({ type: 'email.delivered' }),
    });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it('fails safely with 503 when RESEND_WEBHOOK_SECRET is not configured', async () => {
    const original = process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.RESEND_WEBHOOK_SECRET;
    try {
      const request = signedRequest({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: resendEmailId } });
      const response = await POST(request);
      expect(response.status).toBe(503);
    } finally {
      process.env.RESEND_WEBHOOK_SECRET = original;
    }
  });
});

describe('POST /api/webhooks/resend — delivery event handling', () => {
  it('updates the correct provisioning row on a delivered event', async () => {
    const request = signedRequest({
      type: 'email.delivered',
      created_at: new Date().toISOString(),
      data: { email_id: resendEmailId, created_at: new Date().toISOString(), from: 'x@x.com', to: ['y@y.com'], subject: 'test' },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);

    const { data: row } = await admin.from('participant_account_provisioning').select('email_status, delivered_at').eq('application_id', applicationId).single();
    expect(row?.email_status).toBe('delivered');
    expect(row?.delivered_at).toBeTruthy();
  });

  it('updates the correct provisioning row on a bounced event with a safe failure reason', async () => {
    const request = signedRequest({
      type: 'email.bounced',
      created_at: new Date().toISOString(),
      data: {
        email_id: resendEmailId, created_at: new Date().toISOString(), from: 'x@x.com', to: ['y@y.com'], subject: 'test',
        bounce: { message: 'Mailbox does not exist', subType: 'general', type: 'hard' },
      },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);

    const { data: row } = await admin.from('participant_account_provisioning').select('email_status, bounced_at, last_error_message').eq('application_id', applicationId).single();
    expect(row?.email_status).toBe('bounced');
    expect(row?.bounced_at).toBeTruthy();
    expect(row?.last_error_message).toBe('Mailbox does not exist');
  });

  it('updates the correct provisioning row on a failed event', async () => {
    const request = signedRequest({
      type: 'email.failed',
      created_at: new Date().toISOString(),
      data: {
        email_id: resendEmailId, created_at: new Date().toISOString(), from: 'x@x.com', to: ['y@y.com'], subject: 'test',
        failed: { reason: 'Invalid recipient domain' },
      },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);

    const { data: row } = await admin.from('participant_account_provisioning').select('email_status, last_error_message').eq('application_id', applicationId).single();
    expect(row?.email_status).toBe('failed');
    expect(row?.last_error_message).toBe('Invalid recipient domain');
  });

  it('is idempotent: the same svix-id delivered twice only applies the state transition once', async () => {
    const msgId = `msg_dup_${Date.now()}`;
    const body = {
      type: 'email.delivered' as const,
      created_at: new Date().toISOString(),
      data: { email_id: resendEmailId, created_at: new Date().toISOString(), from: 'x@x.com', to: ['y@y.com'], subject: 'test' },
    };

    const first = await POST(signedRequest(body, { msgId }));
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.duplicate).toBeUndefined();

    const second = await POST(signedRequest(body, { msgId }));
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.duplicate).toBe(true);

    const { count } = await admin.from('resend_webhook_events').select('svix_id', { count: 'exact', head: true }).eq('svix_id', msgId);
    expect(count).toBe(1); // recorded exactly once despite 2 deliveries
  });

  it('ignores non-email event types without error', async () => {
    const request = signedRequest({
      type: 'contact.created',
      created_at: new Date().toISOString(),
      data: { id: 'contact_1', email: 'x@x.com', unsubscribed: false },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ignored).toBe(true);
  });

  it('never exposes participant email or name in the response body', async () => {
    const request = signedRequest({
      type: 'email.delivered',
      created_at: new Date().toISOString(),
      data: { email_id: resendEmailId, created_at: new Date().toISOString(), from: 'x@x.com', to: ['participant@example.com'], subject: 'test' },
    });
    const response = await POST(request);
    const text = await response.text();
    expect(text).not.toContain('participant@example.com');
    expect(text).not.toContain('Webhook Test Person');
  });
});
