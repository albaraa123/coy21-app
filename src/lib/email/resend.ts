import { getResendConfig } from './resend-config';
import { fetchEmailSettings, sendEmailGuarded } from './send-guarded';
import { formatConferenceTime, formatConferenceDate } from '@/lib/datetime/conference-time';

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
      ? `تم استلام طلب التسجيل`
      : `Registration Received`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nتم استلام طلب تسجيلك بنجاح. يرجى العلم أن استلام الطلب لا يعني القبول النهائي في المؤتمر، وسيتم التواصل معك بعد انتهاء فريق المؤتمر من مراجعة الطلبات.`
      : `Hello ${params.fullName},\n\nYour registration application has been received. Please note that receipt does not constitute final admission — we will contact you once the review team has finished processing applications.`;

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
// (design doc section 14/15). Bilingual in a single message — both Arabic
// and English sections in one send — per the approved spec, not a
// per-locale choice. Callers are responsible for only invoking this for a
// participant whose account currently uses the approved temporary password
// (account_status in ('account_created', 'password_change_required')) —
// this function has no way to verify that itself; the bulk-action layer
// excludes ineligible rows before ever calling this.
//
// Never includes passport, medical, allocation-answer, or any other
// personal data — only name, username (email), the temporary password
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
  const subject = 'تم إنشاء حسابك في COY21 Türkiye 2026 / Your COY21 Türkiye 2026 account has been created';

  const text = [
    `مرحبًا ${params.fullName}،`,
    '',
    'تم إنشاء حسابك في منصة COY21 Türkiye 2026.',
    '',
    `اسم المستخدم: ${params.to}`,
    `كلمة المرور المؤقتة: ${params.temporaryPassword}`,
    `رابط تسجيل الدخول: ${loginUrl}`,
    '',
    'سيُطلب منك تغيير كلمة المرور عند أول تسجيل دخول. لن تتمكن من الوصول إلى ملفك وجدولك الشخصي قبل إكمال تغيير كلمة المرور.',
    '',
    `للدعم: ${config.supportEmail}`,
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

export async function sendSessionCancellationNotificationEmail(params: {
  to: string;
  fullName: string;
  sessionTitle: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const browseUrl = `${config.appUrl}/my-agenda/browse`;

  const subject =
    params.locale === 'ar'
      ? `تم إلغاء الجلسة: ${params.sessionTitle}`
      : `Session cancelled: ${params.sessionTitle}`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nنأسف لإبلاغك بأن الجلسة التي حجزتها "${params.sessionTitle}" تم إلغاؤها. حجزك لهذه الجلسة أُلغي تلقائياً.\n\nيمكنك تصفح الجلسات المتاحة الأخرى وحجز بديل من هنا: ${browseUrl}\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nWe're sorry to let you know that the session you booked, "${params.sessionTitle}", has been cancelled. Your booking for this session has been automatically cancelled.\n\nYou can browse other available sessions and book a replacement here: ${browseUrl}\n\nIf you have any questions, please contact us.`;

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

export async function sendSessionRescheduleNotificationEmail(params: {
  to: string;
  fullName: string;
  sessionTitle: string;
  oldStartTime: string;
  newStartTime: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const oldTimeFormatted = `${formatConferenceDate(params.oldStartTime, params.locale)} ${formatConferenceTime(params.oldStartTime, params.locale)}`;
  const newTimeFormatted = `${formatConferenceDate(params.newStartTime, params.locale)} ${formatConferenceTime(params.newStartTime, params.locale)}`;

  const subject =
    params.locale === 'ar'
      ? `تغيّر موعد الجلسة: ${params.sessionTitle}`
      : `Session time changed: ${params.sessionTitle}`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nتغيّر موعد الجلسة التي حجزتها "${params.sessionTitle}".\n\nالموعد السابق: ${oldTimeFormatted}\nالموعد الجديد: ${newTimeFormatted}\n\nحجزك لا يزال سارياً على الموعد الجديد تلقائياً، ولا حاجة لإعادة الحجز. إذا تعارض الموعد الجديد مع حجز آخر لديك، يرجى مراجعة برنامجك.\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nThe session you booked, "${params.sessionTitle}", has had its time changed.\n\nPrevious time: ${oldTimeFormatted}\nNew time: ${newTimeFormatted}\n\nYour booking remains valid for the new time automatically -- no need to re-book. If the new time conflicts with another of your bookings, please review your agenda.\n\nIf you have any questions, please contact us.`;

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

export async function sendWaitlistPromotionNotificationEmail(params: {
  to: string;
  fullName: string;
  sessionTitle: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const agendaUrl = `${config.appUrl}/my-agenda`;

  const subject =
    params.locale === 'ar'
      ? `تمت ترقيتك من قائمة الانتظار: ${params.sessionTitle}`
      : `You're off the waitlist: ${params.sessionTitle}`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nتحرر مقعد في الجلسة "${params.sessionTitle}" وتمت ترقيتك تلقائياً من قائمة الانتظار إلى حجز مؤكد.\n\nيمكنك مراجعة برنامجك من هنا: ${agendaUrl}\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nA seat opened up in "${params.sessionTitle}" and you've been automatically promoted from the waitlist to a confirmed booking.\n\nYou can review your agenda here: ${agendaUrl}\n\nIf you have any questions, please contact us.`;

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

  // Table-based layout (not flexbox/grid) and inline styles throughout —
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
                <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;">مرحبًا ${name}،</p>
                <p style="margin:0 0 16px;font-size:14px;color:#333333;line-height:1.6;">تم إنشاء حسابك في منصة COY21 Türkiye 2026.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f3ef;border-radius:6px;margin:0 0 16px;">
                  <tr>
                    <td style="padding:16px;">
                      <p style="margin:0 0 8px;font-size:13px;color:#666666;">اسم المستخدم</p>
                      <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;font-weight:bold;">${username}</p>
                      <p style="margin:0 0 8px;font-size:13px;color:#666666;">كلمة المرور المؤقتة</p>
                      <p style="margin:0;font-size:15px;color:#1a1a1a;font-weight:bold;font-family:monospace;">${password}</p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
                  <tr>
                    <td style="border-radius:6px;background-color:#c9a227;">
                      <a href="${loginUrl}" style="display:inline-block;padding:12px 28px;font-size:14px;color:#0f2a2e;font-weight:bold;text-decoration:none;">تسجيل الدخول</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 16px;font-size:13px;color:#666666;line-height:1.6;">سيُطلب منك تغيير كلمة المرور عند أول تسجيل دخول. لن تتمكن من الوصول إلى ملفك وجدولك الشخصي قبل إكمال تغيير كلمة المرور.</p>
                <p style="margin:0;font-size:13px;color:#666666;">للدعم: <a href="mailto:${supportEmail}" style="color:#0f2a2e;">${supportEmail}</a></p>
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

