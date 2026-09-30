import { getResendConfig } from './resend-config';
import { fetchEmailSettings, sendEmailGuarded } from './send-guarded';

export async function sendRegistrationConfirmationEmail(params: {
  to: string;
  fullName: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const subject =
    params.locale === 'ar'
      ? `ØªÙ… Ø§Ø³ØªÙ„Ø§Ù… Ø·Ù„Ø¨ Ø§Ù„ØªØ³Ø¬ÙŠÙ„`
      : `Registration Received`;

  const body =
    params.locale === 'ar'
      ? `Ù…Ø±Ø­Ø¨Ø§Ù‹ ${params.fullName}ØŒ\n\nØªÙ… Ø§Ø³ØªÙ„Ø§Ù… Ø·Ù„Ø¨ ØªØ³Ø¬ÙŠÙ„Ùƒ Ø¨Ù†Ø¬Ø§Ø­. ÙŠØ±Ø¬Ù‰ Ø§Ù„Ø¹Ù„Ù… Ø£Ù† Ø§Ø³ØªÙ„Ø§Ù… Ø§Ù„Ø·Ù„Ø¨ Ù„Ø§ ÙŠØ¹Ù†ÙŠ Ø§Ù„Ù‚Ø¨ÙˆÙ„ Ø§Ù„Ù†Ù‡Ø§Ø¦ÙŠ ÙÙŠ Ø§Ù„Ù…Ø¤ØªÙ…Ø±ØŒ ÙˆØ³ÙŠØªÙ… Ø§Ù„ØªÙˆØ§ØµÙ„ Ù…Ø¹Ùƒ Ø¨Ø¹Ø¯ Ø§Ù†ØªÙ‡Ø§Ø¡ ÙØ±ÙŠÙ‚ Ø§Ù„Ù…Ø¤ØªÙ…Ø± Ù…Ù† Ù…Ø±Ø§Ø¬Ø¹Ø© Ø§Ù„Ø·Ù„Ø¨Ø§Øª.`
      : `Hello ${params.fullName},\n\nYour registration application has been received. Please note that receipt does not constitute final admission â€” we will contact you once the review team has finished processing applications.`;

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}

// Login-details email for an admin-controlled account-provisioning action
// (design doc section 14/15). Bilingual in a single message â€” both Arabic
// and English sections in one send â€” per the approved spec, not a
// per-locale choice. Callers are responsible for only invoking this for a
// participant whose account currently uses the approved temporary password
// (account_status in ('account_created', 'password_change_required')) â€”
// this function has no way to verify that itself; the bulk-action layer
// excludes ineligible rows before ever calling this.
//
// Never includes passport, medical, allocation-answer, or any other
// personal data â€” only name, username (email), the temporary password
// (present only in this outgoing message, never persisted), login URL, and
// support contact.
export async function sendLoginDetailsEmail(params: {
  to: string;
  fullName: string;
  temporaryPassword: string;
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const loginUrl = `${config.appUrl}/log-in`;
  const subject = 'ØªÙ… Ø¥Ù†Ø´Ø§Ø¡ Ø­Ø³Ø§Ø¨Ùƒ ÙÙŠ COY21 Türkiye 2026 / Your COY21 Türkiye 2026 account has been created';

  const text = [
    `Ù…Ø±Ø­Ø¨Ù‹Ø§ ${params.fullName}ØŒ`,
    '',
    'ØªÙ… Ø¥Ù†Ø´Ø§Ø¡ Ø­Ø³Ø§Ø¨Ùƒ ÙÙŠ Ù…Ù†ØµØ© COY21 Türkiye 2026.',
    '',
    `Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…: ${params.to}`,
    `ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ø§Ù„Ù…Ø¤Ù‚ØªØ©: ${params.temporaryPassword}`,
    `Ø±Ø§Ø¨Ø· ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„: ${loginUrl}`,
    '',
    'Ø³ÙŠÙØ·Ù„Ø¨ Ù…Ù†Ùƒ ØªØºÙŠÙŠØ± ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ø¹Ù†Ø¯ Ø£ÙˆÙ„ ØªØ³Ø¬ÙŠÙ„ Ø¯Ø®ÙˆÙ„. Ù„Ù† ØªØªÙ…ÙƒÙ† Ù…Ù† Ø§Ù„ÙˆØµÙˆÙ„ Ø¥Ù„Ù‰ Ù…Ù„ÙÙƒ ÙˆØ¬Ø¯ÙˆÙ„Ùƒ Ø§Ù„Ø´Ø®ØµÙŠ Ù‚Ø¨Ù„ Ø¥ÙƒÙ…Ø§Ù„ ØªØºÙŠÙŠØ± ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±.',
    '',
    `Ù„Ù„Ø¯Ø¹Ù…: ${config.supportEmail}`,
    '',
    '----------------------------------------',
    '',
    `Hello ${params.fullName},`,
    '',
    'Your COY21 Türkiye 2026 platform account has been created.',
    '',
    `Username: ${params.to}`,
    `Temporary password: ${params.temporaryPassword}`,
    `Login: ${loginUrl}`,
    '',
    'You will be required to change your password when you first log in. Access to your participant profile and personal schedule will remain restricted until this step is completed.',
    '',
    `Support: ${config.supportEmail}`,
  ].join('\n');

  const html = buildLoginDetailsHtml({
    fullName: params.fullName,
    username: params.to,
    temporaryPassword: params.temporaryPassword,
    loginUrl,
    supportEmail: config.supportEmail,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text,
    html,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}

export async function sendClassificationChangeNotificationEmail(params: {
  to: string;
  fullName: string;
  newApplicationNumber: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const subject =
    params.locale === 'ar'
      ? `تم تحديث رمز مشاركتك - ${params.newApplicationNumber}`
      : `Your attendee code has been updated - ${params.newApplicationNumber}`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nتم تحديث تصنيف مشاركتك، ونتيجة لذلك تم إصدار رمز مشاركة جديد لك: ${params.newApplicationNumber}. الرمز السابق لم يعد صالحاً. إذا كان لديك رمز QR سابق، يرجى استخدام النسخة المحدّثة من حسابك.\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nYour participation classification has been updated, and as a result a new attendee code has been issued: ${params.newApplicationNumber}. Your previous code is no longer valid. If you had a QR code, please use the updated one from your account.\n\nIf you have any questions, please contact us.`;

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}

// Escapes the handful of characters that matter for safe HTML text-node
// interpolation. Every interpolated value here is either a participant's
// own name/email (never expected to contain markup, but escaped
// defensively since it is admin/import-sourced data, not something this
// code fully controls the shape of) or a URL/constant this codebase itself
// produces.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildLoginDetailsHtml(params: {
  fullName: string;
  username: string;
  temporaryPassword: string;
  loginUrl: string;
  supportEmail: string;
}): string {
  const name = escapeHtml(params.fullName);
  const username = escapeHtml(params.username);
  const password = escapeHtml(params.temporaryPassword);
  const loginUrl = escapeHtml(params.loginUrl);
  const supportEmail = escapeHtml(params.supportEmail);

  // Table-based layout (not flexbox/grid) and inline styles throughout â€”
  // the only layout approach that renders consistently across email
  // clients (notably Outlook's Word-based rendering engine). max-width +
  // width:100% on the outer table is what makes this responsive on mobile
  // clients without a separate mobile stylesheet.
  return `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>COY21 Türkiye 2026</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f5f3ef;font-family:Tahoma,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f3ef;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="background-color:#0f2a2e;padding:20px 24px;text-align:center;">
                <span style="color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">COY21 Türkiye 2026</span>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;" dir="rtl">
                <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;">Ù…Ø±Ø­Ø¨Ù‹Ø§ ${name}ØŒ</p>
                <p style="margin:0 0 16px;font-size:14px;color:#333333;line-height:1.6;">ØªÙ… Ø¥Ù†Ø´Ø§Ø¡ Ø­Ø³Ø§Ø¨Ùƒ ÙÙŠ Ù…Ù†ØµØ© COY21 Türkiye 2026.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f3ef;border-radius:6px;margin:0 0 16px;">
                  <tr>
                    <td style="padding:16px;">
                      <p style="margin:0 0 8px;font-size:13px;color:#666666;">Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…</p>
                      <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;font-weight:bold;">${username}</p>
                      <p style="margin:0 0 8px;font-size:13px;color:#666666;">ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ø§Ù„Ù…Ø¤Ù‚ØªØ©</p>
                      <p style="margin:0;font-size:15px;color:#1a1a1a;font-weight:bold;font-family:monospace;">${password}</p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
                  <tr>
                    <td style="border-radius:6px;background-color:#c9a227;">
                      <a href="${loginUrl}" style="display:inline-block;padding:12px 28px;font-size:14px;color:#0f2a2e;font-weight:bold;text-decoration:none;">ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 16px;font-size:13px;color:#666666;line-height:1.6;">Ø³ÙŠÙØ·Ù„Ø¨ Ù…Ù†Ùƒ ØªØºÙŠÙŠØ± ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ø¹Ù†Ø¯ Ø£ÙˆÙ„ ØªØ³Ø¬ÙŠÙ„ Ø¯Ø®ÙˆÙ„. Ù„Ù† ØªØªÙ…ÙƒÙ† Ù…Ù† Ø§Ù„ÙˆØµÙˆÙ„ Ø¥Ù„Ù‰ Ù…Ù„ÙÙƒ ÙˆØ¬Ø¯ÙˆÙ„Ùƒ Ø§Ù„Ø´Ø®ØµÙŠ Ù‚Ø¨Ù„ Ø¥ÙƒÙ…Ø§Ù„ ØªØºÙŠÙŠØ± ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±.</p>
                <p style="margin:0;font-size:13px;color:#666666;">Ù„Ù„Ø¯Ø¹Ù…: <a href="mailto:${supportEmail}" style="color:#0f2a2e;">${supportEmail}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 24px;border-top:1px solid #eeeeee;" dir="ltr">
                <div style="padding-top:20px;">
                  <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;">Hello ${name},</p>
                  <p style="margin:0 0 16px;font-size:14px;color:#333333;line-height:1.6;">Your COY21 Türkiye 2026 platform account has been created.</p>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f3ef;border-radius:6px;margin:0 0 16px;">
                    <tr>
                      <td style="padding:16px;">
                        <p style="margin:0 0 8px;font-size:13px;color:#666666;">Username</p>
                        <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;font-weight:bold;">${username}</p>
                        <p style="margin:0 0 8px;font-size:13px;color:#666666;">Temporary password</p>
                        <p style="margin:0;font-size:15px;color:#1a1a1a;font-weight:bold;font-family:monospace;">${password}</p>
                      </td>
                    </tr>
                  </table>
                  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
                    <tr>
                      <td style="border-radius:6px;background-color:#c9a227;">
                        <a href="${loginUrl}" style="display:inline-block;padding:12px 28px;font-size:14px;color:#0f2a2e;font-weight:bold;text-decoration:none;">Log in</a>
                      </td>
                    </tr>
                  </table>
                  <p style="margin:0 0 16px;font-size:13px;color:#666666;line-height:1.6;">You will be required to change your password when you first log in. Access to your participant profile and personal schedule will remain restricted until this step is completed.</p>
                  <p style="margin:0;font-size:13px;color:#666666;">Support: <a href="mailto:${supportEmail}" style="color:#0f2a2e;">${supportEmail}</a></p>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

