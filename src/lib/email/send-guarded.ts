// src/lib/email/send-guarded.ts
//
// The sole permitted callers of resend.emails.send(...) in this codebase
// (excluding src/app/api/webhooks/resend/route.ts's unrelated
// new Resend('webhook_verify_only') construction, used only for webhook
// signature verification, never for sending). See
// docs/superpowers/specs/2026-09-30-email-sandbox-mode-design.md for the
// full design and the review history behind the fetchEmailSettings/
// sendEmailGuarded split — do not collapse them into one self-fetching
// function; that reintroduces a real N-database-round-trip bug for
// sendBulkEmail's and both cron routes' send loops (see part 2 of the
// spec for the exact reasoning).
import { Resend } from 'resend';
import { createServiceRoleClient } from '@/lib/supabase/server';

export interface EmailSettings {
  sandboxEnabled: boolean;
  sandboxRecipientEmail: string | null;
}

// Uses the service-role client, matching every one of this feature's 5
// send call sites (Server Actions and cron routes, none of which act on
// behalf of an end-user browser session at the point they send email).
// The email_settings table's RLS SELECT policy (staff-readable) is not
// actually exercised by this read path — it exists as defense-in-depth
// for a future direct-client read (e.g. a client component checking
// sandbox state without going through a Server Action), not as what
// makes this function safe to call. Safety here comes from every caller
// already being server-only and independently authorized (staff/
// super_admin server actions, or Bearer-token-gated cron routes).
export async function fetchEmailSettings(): Promise<EmailSettings> {
  const service = createServiceRoleClient();
  const { data } = await service.from('email_settings').select('sandbox_enabled, sandbox_recipient_email').eq('id', true).single();
  return {
    sandboxEnabled: data?.sandbox_enabled ?? true, // fail toward sandbox-on if the row is somehow unreadable
    sandboxRecipientEmail: data?.sandbox_recipient_email ?? null,
  };
}

// Cached on first call and reused for the life of the process, regardless
// of which caller's apiKey triggered creation. Safe today because every
// caller resolves apiKey from the same single getResendConfig() source —
// this app has one Resend account, never multiple keys/tenants in one
// process. Revisit if that ever changes.
let resendClient: Resend | null = null;
function getResendClient(apiKey: string): Resend {
  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }
  return resendClient;
}

const SANDBOX_TEXT_PREFIX = (original: string) =>
  `[SANDBOX MODE — this email was NOT sent to the real recipient]\nOriginal recipient: ${original}\n---\n\n`;

const SANDBOX_HTML_PREFIX = (original: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff3cd;border:1px solid #ffe69c;border-radius:6px;margin-bottom:16px;"><tr><td style="padding:12px 16px;"><p style="margin:0;font-size:13px;color:#664d03;font-weight:bold;">SANDBOX MODE — this email was NOT sent to the real recipient</p><p style="margin:4px 0 0;font-size:13px;color:#664d03;">Original recipient: ${original}</p></td></tr></table>`;

export async function sendEmailGuarded(params: {
  settings: EmailSettings;
  apiKey: string;
  from: string;
  replyTo: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  originalRecipientDescription: string;
}): Promise<{ id: string | null; error: string | null }> {
  const { settings, apiKey, from, replyTo, subject, text, html, originalRecipientDescription } = params;

  let to = params.to;
  let finalText = text;
  let finalHtml = html;

  if (settings.sandboxEnabled) {
    if (!settings.sandboxRecipientEmail) {
      return { id: null, error: 'Sandbox mode is enabled but no recipient email is configured. Set one in Settings before any email can be sent.' };
    }
    to = settings.sandboxRecipientEmail;
    finalText = SANDBOX_TEXT_PREFIX(originalRecipientDescription) + text;
    if (html) {
      finalHtml = SANDBOX_HTML_PREFIX(originalRecipientDescription) + html;
    }
  }

  const { data, error } = await getResendClient(apiKey).emails.send({
    from,
    replyTo,
    to,
    subject,
    text: finalText,
    ...(finalHtml ? { html: finalHtml } : {}),
  });

  return { id: data?.id ?? null, error: error ? error.message : null };
}
