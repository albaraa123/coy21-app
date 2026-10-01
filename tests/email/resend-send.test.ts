// tests/email/resend-send.test.ts
//
// Mocked Resend SDK coverage (design doc §10: "use mocked Resend calls for
// the stable test suite"). Mocks the 'resend' module at the top level so no
// real network call ever happens — this suite must never send a real
// email.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

// resend.ts now routes its sends through fetchEmailSettings() +
// sendEmailGuarded() (src/lib/email/send-guarded.ts), which reads the
// email_settings table via createServiceRoleClient() — a real Supabase
// client construction that fails in this unit-test environment (no
// NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY configured). This
// suite is only concerned with sendLoginDetailsEmail's own body/subject
// construction, not sandbox routing (that's covered by
// tests/email/send-guarded.test.ts), so fetchEmailSettings is mocked to
// resolve as sandbox-disabled — the real sendEmailGuarded is kept so the
// final resend.emails.send(...) call shape assertions below still hold.
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

describe('sendLoginDetailsEmail', () => {
  it('sends the correct username and temporary password to the intended recipient only', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_123' }, error: null });
    const { sendLoginDetailsEmail } = await import('@/lib/email/resend');

    const result = await sendLoginDetailsEmail({
      to: 'participant@example.com',
      fullName: 'Test Participant',
      temporaryPassword: 'password@123',
    });

    expect(result.id).toBe('email_123');
    expect(result.error).toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    expect(call.to).toBe('participant@example.com');
    expect(call.from).toBe('RCOY MENA 2026 <participants@rcoymena.org>');
    expect(call.text).toContain('participant@example.com'); // username = email
    expect(call.text).toContain('password@123');
    expect(call.html).toContain('participant@example.com');
    expect(call.html).toContain('password@123');
    expect(call.html).toContain('Test Participant');
  });

  it('contains well-formed Arabic text, not mojibake, in both HTML and plain-text bodies', async () => {
    // Regression guard: src/lib/email/resend.ts previously had its Arabic
    // template literals corrupted by CP1252 mis-decoding (mojibake), which
    // was live in production and went uncaught here because no prior test
    // asserted on the actual Arabic content -- only structural properties
    // (length, presence of username/password). A mojibake string contains
    // only Latin-range characters (e.g. "Ù…Ø±Ø­Ø¨Ù‹Ø§" instead of "مرحبًا"),
    // so asserting a real Arabic-block character is present is a cheap,
    // direct way to catch this class of bug from recurring.
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendLoginDetailsEmail } = await import('@/lib/email/resend');

    await sendLoginDetailsEmail({ to: 'a@example.com', fullName: 'A', temporaryPassword: 'password@123' });

    const call = sendMock.mock.calls[0][0];
    const arabicBlock = /[؀-ۿ]/;
    expect(call.text).toMatch(arabicBlock);
    expect(call.html).toMatch(arabicBlock);
    expect(call.subject).toMatch(arabicBlock);
    // The specific greeting word, to confirm it's genuinely readable Arabic
    // and not just an isolated correctly-decoded character amid mojibake.
    expect(call.text).toContain('مرحبًا');
  });

  it('includes both HTML and a plain-text fallback', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendLoginDetailsEmail } = await import('@/lib/email/resend');

    await sendLoginDetailsEmail({ to: 'a@example.com', fullName: 'A', temporaryPassword: 'password@123' });

    const call = sendMock.mock.calls[0][0];
    expect(typeof call.html).toBe('string');
    expect(call.html.length).toBeGreaterThan(0);
    expect(typeof call.text).toBe('string');
    expect(call.text.length).toBeGreaterThan(0);
  });

  it('never includes passport, medical, or allocation data in the email body', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendLoginDetailsEmail } = await import('@/lib/email/resend');

    await sendLoginDetailsEmail({ to: 'a@example.com', fullName: 'A', temporaryPassword: 'password@123' });

    const call = sendMock.mock.calls[0][0];
    const forbidden = ['passport', 'medical', 'allerg', 'track_interests', 'primary_track'];
    for (const word of forbidden) {
      expect(call.html.toLowerCase()).not.toContain(word);
      expect(call.text.toLowerCase()).not.toContain(word);
    }
  });

  it('escapes HTML-significant characters in the recipient name', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendLoginDetailsEmail } = await import('@/lib/email/resend');

    await sendLoginDetailsEmail({ to: 'a@example.com', fullName: '<script>alert(1)</script>', temporaryPassword: 'password@123' });

    const call = sendMock.mock.calls[0][0];
    expect(call.html).not.toContain('<script>alert(1)</script>');
    expect(call.html).toContain('&lt;script&gt;');
  });

  it('fails safely (returns an error, never throws) when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendLoginDetailsEmail } = await import('@/lib/email/resend');

    const result = await sendLoginDetailsEmail({ to: 'a@example.com', fullName: 'A', temporaryPassword: 'password@123' });

    expect(result.id).toBeNull();
    expect(result.error).toContain('RESEND_API_KEY');
    expect(sendMock).not.toHaveBeenCalled(); // never even attempts the API call
  });

  it('reports a per-call error without throwing when Resend returns an error', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'invalid_from_address' } });
    const { sendLoginDetailsEmail } = await import('@/lib/email/resend');

    const result = await sendLoginDetailsEmail({ to: 'a@example.com', fullName: 'A', temporaryPassword: 'password@123' });

    expect(result.id).toBeNull();
    expect(result.error).toBe('invalid_from_address');
  });

  it('sets replyTo to the support email when RESEND_REPLY_TO_EMAIL is unset', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendLoginDetailsEmail } = await import('@/lib/email/resend');

    await sendLoginDetailsEmail({ to: 'a@example.com', fullName: 'A', temporaryPassword: 'password@123' });

    expect(sendMock.mock.calls[0][0].replyTo).toBe('support@rcoymena.org');
  });
});
