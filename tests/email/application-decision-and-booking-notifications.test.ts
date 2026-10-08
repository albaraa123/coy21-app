// tests/email/application-decision-and-booking-notifications.test.ts
//
// Sub-project 6, Task 4: tests for sendApplicationAcceptedEmail,
// sendApplicationRejectedEmail, sendBookingConfirmedEmail,
// sendAnnouncementEmail -- new exports in src/lib/email/resend.ts.
// Mirrors tests/email/session-lifecycle-notifications.test.ts's exact
// mocking pattern (mock the Resend SDK class + fetchEmailSettings).
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
  process.env.RESEND_FROM_EMAIL = 'RCOY MENA 2026 <participants@rcoymena.org>';
  process.env.APP_URL = 'https://example.com';
  process.env.PARTICIPANT_SUPPORT_EMAIL = 'support@rcoymena.org';
  delete process.env.RESEND_REPLY_TO_EMAIL;
  sendMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('sendApplicationAcceptedEmail', () => {
  it('sends an English acceptance email', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendApplicationAcceptedEmail } = await import('@/lib/email/resend');

    const result = await sendApplicationAcceptedEmail({
      to: 'participant@example.com',
      fullName: 'Test Participant',
      locale: 'en',
    });

    expect(result.id).toBe('email_1');
    expect(result.error).toBeNull();
    const call = sendMock.mock.calls[0][0];
    expect(call.to).toBe('participant@example.com');
    expect(call.text).toContain('Test Participant');
  });

  it('sends Arabic subject/body when locale is ar', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendApplicationAcceptedEmail } = await import('@/lib/email/resend');

    await sendApplicationAcceptedEmail({
      to: 'participant@example.com',
      fullName: 'مشارك',
      locale: 'ar',
    });

    const call = sendMock.mock.calls[0][0];
    const arabicBlock = /[؀-ۿ]/;
    expect(call.subject).toMatch(arabicBlock);
    expect(call.text).toMatch(arabicBlock);
  });

  it('fails safely when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendApplicationAcceptedEmail } = await import('@/lib/email/resend');

    const result = await sendApplicationAcceptedEmail({
      to: 'a@example.com',
      fullName: 'A',
      locale: 'en',
    });

    expect(result.id).toBeNull();
    expect(result.error).toContain('RESEND_API_KEY');
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('sendApplicationRejectedEmail', () => {
  it('sends an English rejection email', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendApplicationRejectedEmail } = await import('@/lib/email/resend');

    const result = await sendApplicationRejectedEmail({
      to: 'participant@example.com',
      fullName: 'Test Participant',
      locale: 'en',
    });

    expect(result.id).toBe('email_1');
    expect(result.error).toBeNull();
    const call = sendMock.mock.calls[0][0];
    expect(call.to).toBe('participant@example.com');
    expect(call.text).toContain('Test Participant');
  });

  it('sends Arabic subject/body when locale is ar', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendApplicationRejectedEmail } = await import('@/lib/email/resend');

    await sendApplicationRejectedEmail({
      to: 'participant@example.com',
      fullName: 'مشارك',
      locale: 'ar',
    });

    const call = sendMock.mock.calls[0][0];
    const arabicBlock = /[؀-ۿ]/;
    expect(call.subject).toMatch(arabicBlock);
    expect(call.text).toMatch(arabicBlock);
  });

  it('fails safely when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendApplicationRejectedEmail } = await import('@/lib/email/resend');

    const result = await sendApplicationRejectedEmail({
      to: 'a@example.com',
      fullName: 'A',
      locale: 'en',
    });

    expect(result.id).toBeNull();
    expect(result.error).toContain('RESEND_API_KEY');
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('sendBookingConfirmedEmail', () => {
  it('sends an English booking-confirmed email with the session title and a /my-agenda link', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendBookingConfirmedEmail } = await import('@/lib/email/resend');

    const result = await sendBookingConfirmedEmail({
      to: 'participant@example.com',
      fullName: 'Test Participant',
      sessionTitle: 'Intro to Climate Policy',
      locale: 'en',
    });

    expect(result.id).toBe('email_1');
    expect(result.error).toBeNull();
    const call = sendMock.mock.calls[0][0];
    expect(call.to).toBe('participant@example.com');
    expect(call.subject).toContain('Intro to Climate Policy');
    expect(call.text).toContain('Intro to Climate Policy');
    expect(call.text).toContain('https://example.com/my-agenda');
  });

  it('sends Arabic subject/body when locale is ar', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendBookingConfirmedEmail } = await import('@/lib/email/resend');

    await sendBookingConfirmedEmail({
      to: 'participant@example.com',
      fullName: 'مشارك',
      sessionTitle: 'جلسة اختبار',
      locale: 'ar',
    });

    const call = sendMock.mock.calls[0][0];
    const arabicBlock = /[؀-ۿ]/;
    expect(call.subject).toMatch(arabicBlock);
    expect(call.text).toMatch(arabicBlock);
  });

  it('fails safely when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendBookingConfirmedEmail } = await import('@/lib/email/resend');

    const result = await sendBookingConfirmedEmail({
      to: 'a@example.com',
      fullName: 'A',
      sessionTitle: 'S',
      locale: 'en',
    });

    expect(result.id).toBeNull();
    expect(result.error).toContain('RESEND_API_KEY');
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('sendAnnouncementEmail', () => {
  it('sends an English announcement email with the given title and body', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendAnnouncementEmail } = await import('@/lib/email/resend');

    const result = await sendAnnouncementEmail({
      to: 'participant@example.com',
      fullName: 'Test Participant',
      title: 'Venue change',
      body: 'The closing ceremony has moved to Hall B.',
      locale: 'en',
    });

    expect(result.id).toBe('email_1');
    expect(result.error).toBeNull();
    const call = sendMock.mock.calls[0][0];
    expect(call.to).toBe('participant@example.com');
    expect(call.subject).toContain('Venue change');
    expect(call.text).toContain('Venue change');
    expect(call.text).toContain('The closing ceremony has moved to Hall B.');
  });

  it('sends Arabic subject/body when locale is ar, and handles a null body', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendAnnouncementEmail } = await import('@/lib/email/resend');

    const result = await sendAnnouncementEmail({
      to: 'participant@example.com',
      fullName: 'مشارك',
      title: 'إعلان',
      body: null,
      locale: 'ar',
    });

    expect(result.error).toBeNull();
    const call = sendMock.mock.calls[0][0];
    const arabicBlock = /[؀-ۿ]/;
    expect(call.subject).toMatch(arabicBlock);
    expect(call.text).toMatch(arabicBlock);
  });

  it('fails safely when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendAnnouncementEmail } = await import('@/lib/email/resend');

    const result = await sendAnnouncementEmail({
      to: 'a@example.com',
      fullName: 'A',
      title: 'T',
      body: 'B',
      locale: 'en',
    });

    expect(result.id).toBeNull();
    expect(result.error).toContain('RESEND_API_KEY');
    expect(sendMock).not.toHaveBeenCalled();
  });
});
