// tests/email/untested-notification-functions.test.ts
//
// sendRegistrationConfirmationEmail, sendClassificationChangeNotificationEmail,
// sendSessionReminderEmail, sendTravelReminderEmail had no dedicated test
// coverage before this file (confirmed by a 2026-10-13 spec review's grep
// across tests/email/*). They now carry real HTML-generation logic, so
// "still untested" would be a worse gap than before -- this file closes
// it. Mocking pattern copied verbatim from the other 4 test files in this
// directory (tests/email/resend-send.test.ts etc.) for consistency.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

vi.mock('@/lib/email/send-guarded', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send-guarded')>();
  return {
    ...actual,
    fetchEmailSettings: vi.fn().mockResolvedValue({ sandboxEnabled: false, sandboxRecipientEmail: null }),
  };
});

const ENV_KEYS = ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'RESEND_REPLY_TO_EMAIL', 'APP_URL', 'PARTICIPANT_SUPPORT_EMAIL'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.RESEND_FROM_EMAIL = 'COY21 Türkiye 2026 <participants@example.com>';
  process.env.APP_URL = 'https://example.com';
  process.env.PARTICIPANT_SUPPORT_EMAIL = 'support@example.com';
  delete process.env.RESEND_REPLY_TO_EMAIL;
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: 'email_test' }, error: null });
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('sendRegistrationConfirmationEmail', () => {
  it('sends with both text and html, English', async () => {
    const { sendRegistrationConfirmationEmail } = await import('@/lib/email/resend');
    await sendRegistrationConfirmationEmail({ to: 'a@example.com', fullName: 'Test User', locale: 'en' });

    const call = sendMock.mock.calls[0][0];
    expect(call.subject).toContain('Registration Received');
    expect(typeof call.html).toBe('string');
    expect(call.html.length).toBeGreaterThan(0);
    expect(call.html).toContain('Test User');
  });

  it('sends with both text and html, Arabic', async () => {
    const { sendRegistrationConfirmationEmail } = await import('@/lib/email/resend');
    await sendRegistrationConfirmationEmail({ to: 'a@example.com', fullName: 'مستخدم', locale: 'ar' });

    const call = sendMock.mock.calls[0][0];
    expect(call.html).toMatch(/[؀-ۿ]/);
  });

  it('fails safely (returns an error, never throws) when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendRegistrationConfirmationEmail } = await import('@/lib/email/resend');

    const result = await sendRegistrationConfirmationEmail({ to: 'a@example.com', fullName: 'Test User', locale: 'en' });

    expect(result.id).toBeNull();
    expect(result.error).toContain('RESEND_API_KEY');
  });
});

describe('sendClassificationChangeNotificationEmail', () => {
  it('sends with both text and html, including the new attendee code', async () => {
    const { sendClassificationChangeNotificationEmail } = await import('@/lib/email/resend');
    await sendClassificationChangeNotificationEmail({
      to: 'a@example.com',
      fullName: 'Test User',
      newApplicationNumber: 'COY21-DEL-0042',
      locale: 'en',
    });

    const call = sendMock.mock.calls[0][0];
    expect(call.text).toContain('COY21-DEL-0042');
    expect(call.html).toContain('COY21-DEL-0042');
    expect(call.html).toContain('UPDATED');
  });

  it('sends with both text and html, Arabic', async () => {
    const { sendClassificationChangeNotificationEmail } = await import('@/lib/email/resend');
    await sendClassificationChangeNotificationEmail({
      to: 'a@example.com',
      fullName: 'مستخدم',
      newApplicationNumber: 'COY21-DEL-0042',
      locale: 'ar',
    });

    const call = sendMock.mock.calls[0][0];
    expect(call.html).toMatch(/[؀-ۿ]/);
    expect(call.html).toContain('تحديث');
  });

  it('fails safely (returns an error, never throws) when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendClassificationChangeNotificationEmail } = await import('@/lib/email/resend');

    const result = await sendClassificationChangeNotificationEmail({
      to: 'a@example.com',
      fullName: 'Test User',
      newApplicationNumber: 'COY21-DEL-0042',
      locale: 'en',
    });

    expect(result.id).toBeNull();
    expect(result.error).toContain('RESEND_API_KEY');
  });
});

describe('sendSessionReminderEmail', () => {
  it('sends with both text and html, using the producer-supplied title as the heading', async () => {
    const { sendSessionReminderEmail } = await import('@/lib/email/resend');
    await sendSessionReminderEmail({
      to: 'a@example.com',
      fullName: 'Test User',
      title: 'Reminder: "Opening Ceremony" starts in 30 minutes',
      body: 'Room: Main Hall\nTime: 09:00',
      locale: 'en',
    });

    const call = sendMock.mock.calls[0][0];
    expect(call.html).toContain('Opening Ceremony');
    expect(call.html).toContain('REMINDER');
  });

  it('sends with both text and html, Arabic', async () => {
    const { sendSessionReminderEmail } = await import('@/lib/email/resend');
    await sendSessionReminderEmail({
      to: 'a@example.com',
      fullName: 'مستخدم',
      title: 'تذكير: جلسة حفل الافتتاح تبدأ بعد 30 دقيقة',
      body: 'القاعة: القاعة الرئيسية\nالوقت: 09:00',
      locale: 'ar',
    });

    const call = sendMock.mock.calls[0][0];
    expect(call.html).toMatch(/[؀-ۿ]/);
  });

  it('fails safely (returns an error, never throws) when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendSessionReminderEmail } = await import('@/lib/email/resend');

    const result = await sendSessionReminderEmail({
      to: 'a@example.com',
      fullName: 'Test User',
      title: 'Reminder: "Opening Ceremony" starts in 30 minutes',
      body: 'Room: Main Hall\nTime: 09:00',
      locale: 'en',
    });

    expect(result.id).toBeNull();
    expect(result.error).toContain('RESEND_API_KEY');
  });
});

describe('sendTravelReminderEmail', () => {
  it('sends with both text and html', async () => {
    const { sendTravelReminderEmail } = await import('@/lib/email/resend');
    await sendTravelReminderEmail({
      to: 'a@example.com',
      fullName: 'Test User',
      title: 'Action required: submit your travel details for COY21',
      body: null,
      locale: 'en',
    });

    const call = sendMock.mock.calls[0][0];
    expect(typeof call.html).toBe('string');
    expect(call.html.length).toBeGreaterThan(0);
    expect(call.html).toContain('ACTION NEEDED');
  });

  it('sends with both text and html, Arabic', async () => {
    const { sendTravelReminderEmail } = await import('@/lib/email/resend');
    await sendTravelReminderEmail({
      to: 'a@example.com',
      fullName: 'مستخدم',
      title: 'إجراء مطلوب: يرجى إرسال تفاصيل سفرك لمؤتمر COY21',
      body: null,
      locale: 'ar',
    });

    const call = sendMock.mock.calls[0][0];
    expect(call.html).toMatch(/[؀-ۿ]/);
  });

  it('fails safely (returns an error, never throws) when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendTravelReminderEmail } = await import('@/lib/email/resend');

    const result = await sendTravelReminderEmail({
      to: 'a@example.com',
      fullName: 'Test User',
      title: 'Action required: submit your travel details for COY21',
      body: null,
      locale: 'en',
    });

    expect(result.id).toBeNull();
    expect(result.error).toContain('RESEND_API_KEY');
  });
});
