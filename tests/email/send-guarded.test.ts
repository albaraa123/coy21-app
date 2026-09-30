// tests/email/send-guarded.test.ts
//
// Mocked Resend SDK coverage, same convention as tests/email/resend-send.test.ts
// (never sends a real email). Also mocks the Supabase service-role client's
// email_settings read, since fetchEmailSettings() is the function under test
// for the settings-reading half.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

describe('sendEmailGuarded', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ data: { id: 'email_123' }, error: null });
  });

  const baseParams = {
    apiKey: 're_test',
    from: 'COY21 <no-reply@example.com>',
    replyTo: 'support@example.com',
    to: 'real-recipient@example.com',
    subject: 'Test subject',
    text: 'Test body',
    originalRecipientDescription: 'Jane Doe <real-recipient@example.com>',
  };

  it('sends unmodified to the real recipient when sandbox is disabled', async () => {
    const { sendEmailGuarded } = await import('@/lib/email/send-guarded');
    const result = await sendEmailGuarded({
      ...baseParams,
      settings: { sandboxEnabled: false, sandboxRecipientEmail: null },
    });

    expect(result.id).toBe('email_123');
    expect(result.error).toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe('real-recipient@example.com');
    expect(sendMock.mock.calls[0][0].text).toBe('Test body'); // not prefixed
  });

  it('blocks sending entirely when sandbox is enabled with no recipient configured', async () => {
    const { sendEmailGuarded } = await import('@/lib/email/send-guarded');
    const result = await sendEmailGuarded({
      ...baseParams,
      settings: { sandboxEnabled: true, sandboxRecipientEmail: null },
    });

    expect(result.id).toBeNull();
    expect(result.error).toContain('no recipient email is configured');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('redirects to the sandbox recipient and embeds the original recipient when sandbox is enabled with a recipient set', async () => {
    const { sendEmailGuarded } = await import('@/lib/email/send-guarded');
    const result = await sendEmailGuarded({
      ...baseParams,
      settings: { sandboxEnabled: true, sandboxRecipientEmail: 'sandbox-inbox@example.com' },
    });

    expect(result.id).toBe('email_123');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    expect(call.to).toBe('sandbox-inbox@example.com');
    expect(call.text).toContain('SANDBOX MODE');
    expect(call.text).toContain('Jane Doe <real-recipient@example.com>');
    expect(call.text).toContain('Test body'); // original body still present
  });

  it('prefixes the HTML body too when an html param is given', async () => {
    const { sendEmailGuarded } = await import('@/lib/email/send-guarded');
    await sendEmailGuarded({
      ...baseParams,
      html: '<p>Original HTML</p>',
      settings: { sandboxEnabled: true, sandboxRecipientEmail: 'sandbox-inbox@example.com' },
    });

    const call = sendMock.mock.calls[0][0];
    expect(call.html).toContain('SANDBOX MODE');
    expect(call.html).toContain('Original HTML');
  });

  it('surfaces a Resend API error without throwing, same shape as before', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'invalid_from_address' } });
    const { sendEmailGuarded } = await import('@/lib/email/send-guarded');

    const result = await sendEmailGuarded({
      ...baseParams,
      settings: { sandboxEnabled: false, sandboxRecipientEmail: null },
    });

    expect(result.id).toBeNull();
    expect(result.error).toBe('invalid_from_address');
  });
});
