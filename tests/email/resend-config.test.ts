// tests/email/resend-config.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getResendConfig, getWebhookSecret } from '@/lib/email/resend-config';

const ENV_KEYS = ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'RESEND_REPLY_TO_EMAIL', 'RESEND_WEBHOOK_SECRET', 'APP_URL', 'NEXT_PUBLIC_SITE_URL', 'PARTICIPANT_SUPPORT_EMAIL'] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('getResendConfig', () => {
  it('fails safely (no throw) and lists every missing variable when nothing is configured', () => {
    const result = getResendConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain('RESEND_API_KEY');
      expect(result.missing).toContain('RESEND_FROM_EMAIL');
      expect(result.missing).toContain('PARTICIPANT_SUPPORT_EMAIL');
      expect(result.missing).toContain('APP_URL');
    }
  });

  it('succeeds once all required variables are set', () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'RCOY MENA 2026 <participants@rcoymena.org>';
    process.env.PARTICIPANT_SUPPORT_EMAIL = 'support@rcoymena.org';
    process.env.APP_URL = 'https://example.com';

    const result = getResendConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.apiKey).toBe('re_test_key');
      expect(result.config.fromEmail).toBe('RCOY MENA 2026 <participants@rcoymena.org>');
      expect(result.config.appUrl).toBe('https://example.com');
      // RESEND_REPLY_TO_EMAIL unset -> falls back to support email.
      expect(result.config.replyToEmail).toBe('support@rcoymena.org');
    }
  });

  it('uses RESEND_REPLY_TO_EMAIL when explicitly set, not the support-email fallback', () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'RCOY MENA 2026 <participants@rcoymena.org>';
    process.env.PARTICIPANT_SUPPORT_EMAIL = 'support@rcoymena.org';
    process.env.APP_URL = 'https://example.com';
    process.env.RESEND_REPLY_TO_EMAIL = 'replies@rcoymena.org';

    const result = getResendConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.replyToEmail).toBe('replies@rcoymena.org');
    }
  });

  it('falls back to NEXT_PUBLIC_SITE_URL when APP_URL is unset', () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'RCOY MENA 2026 <participants@rcoymena.org>';
    process.env.PARTICIPANT_SUPPORT_EMAIL = 'support@rcoymena.org';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://fallback.example.com';

    const result = getResendConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.appUrl).toBe('https://fallback.example.com');
    }
  });
});

describe('getWebhookSecret', () => {
  it('returns null when unset (fail closed for the webhook route)', () => {
    expect(getWebhookSecret()).toBeNull();
  });

  it('returns the configured secret when set', () => {
    process.env.RESEND_WEBHOOK_SECRET = 'whsec_test';
    expect(getWebhookSecret()).toBe('whsec_test');
  });
});
