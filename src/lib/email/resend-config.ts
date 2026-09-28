// src/lib/email/resend-config.ts
//
// Production Resend configuration and validation, used by resend.ts (send
// path) and the webhook route handler (verify path). This project has no
// centralized env-validation framework (every other module reads
// process.env.X directly) — this file is scoped narrowly to what Resend
// specifically needs, not a general-purpose env schema, matching the
// existing convention rather than introducing a new one.
export interface ResendConfig {
  apiKey: string;
  fromEmail: string;
  replyToEmail: string;
  webhookSecret: string;
  appUrl: string;
  supportEmail: string;
}

export interface ResendConfigResult {
  ok: true;
  config: ResendConfig;
}

export interface ResendConfigMissing {
  ok: false;
  missing: string[];
}

// Fail clearly and safely, never crash at import time: this function is
// called lazily, at the point a send/webhook-verify is actually attempted
// — never at module load. Missing config produces a typed, checkable
// result the caller reports as a normal (non-throwing) failure, matching
// the lazy-Resend-client discipline already established in resend.ts.
export function getResendConfig(): ResendConfigResult | ResendConfigMissing {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  const supportEmail = process.env.PARTICIPANT_SUPPORT_EMAIL;
  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_SITE_URL;

  const missing: string[] = [];
  if (!apiKey) missing.push('RESEND_API_KEY');
  if (!fromEmail) missing.push('RESEND_FROM_EMAIL');
  if (!supportEmail) missing.push('PARTICIPANT_SUPPORT_EMAIL');
  if (!appUrl) missing.push('APP_URL');

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    config: {
      apiKey: apiKey!,
      fromEmail: fromEmail!,
      // RESEND_REPLY_TO_EMAIL is optional — falls back to the support
      // address, which is always a sensible reply-to for a participant
      // account-created email.
      replyToEmail: process.env.RESEND_REPLY_TO_EMAIL || supportEmail!,
      webhookSecret: process.env.RESEND_WEBHOOK_SECRET || '',
      appUrl: appUrl!,
      supportEmail: supportEmail!,
    },
  };
}

// Separate from getResendConfig's send-path requirements: the webhook
// route needs RESEND_WEBHOOK_SECRET specifically (send doesn't), and an
// unset secret must reject every webhook request rather than silently
// accepting unverified events.
export function getWebhookSecret(): string | null {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  return secret && secret.length > 0 ? secret : null;
}
