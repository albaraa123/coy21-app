// tests/email/session-lifecycle-notifications.test.ts
//
// Mocked Resend SDK coverage, following tests/email/resend-send.test.ts's
// established pattern exactly.
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

describe('sendSessionCancellationNotificationEmail', () => {
  it('sends a cancellation email with a link to the browse page, in the requested locale', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendSessionCancellationNotificationEmail } = await import('@/lib/email/resend');

    const result = await sendSessionCancellationNotificationEmail({
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
    expect(call.text).toContain('https://example.com/my-agenda/browse');
  });

  it('sends Arabic subject/body when locale is ar', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendSessionCancellationNotificationEmail } = await import('@/lib/email/resend');

    await sendSessionCancellationNotificationEmail({
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
});

describe('sendSessionRescheduleNotificationEmail', () => {
  it('includes both old and new formatted times', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendSessionRescheduleNotificationEmail } = await import('@/lib/email/resend');

    const result = await sendSessionRescheduleNotificationEmail({
      to: 'participant@example.com',
      fullName: 'Test Participant',
      sessionTitle: 'Intro to Climate Policy',
      oldStartTime: '2026-11-05T09:00:00Z',
      newStartTime: '2026-11-05T11:00:00Z',
      locale: 'en',
    });

    expect(result.id).toBe('email_1');
    const call = sendMock.mock.calls[0][0];
    expect(call.subject).toContain('Intro to Climate Policy');
    expect(call.text).toContain('Previous time:');
    expect(call.text).toContain('New time:');
  });

  it('fails safely when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendSessionRescheduleNotificationEmail } = await import('@/lib/email/resend');

    const result = await sendSessionRescheduleNotificationEmail({
      to: 'a@example.com',
      fullName: 'A',
      sessionTitle: 'S',
      oldStartTime: '2026-11-05T09:00:00Z',
      newStartTime: '2026-11-05T11:00:00Z',
      locale: 'en',
    });

    expect(result.id).toBeNull();
    expect(result.error).toContain('RESEND_API_KEY');
    expect(sendMock).not.toHaveBeenCalled();
  });
});
