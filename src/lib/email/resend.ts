import { getResendConfig } from './resend-config';
import { fetchEmailSettings, sendEmailGuarded } from './send-guarded';
import { formatConferenceTime, formatConferenceDate } from '@/lib/datetime/conference-time';
import { buildBrandedEmailHtml } from './html-template';

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

  const html = buildBrandedEmailHtml({
    locale: params.locale,
    heading: subject,
    paragraphs: body.split('\n\n'),
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    html,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}

// Login-details email for an admin-controlled account-provisioning action
// (design doc section 14/15). English-only as of 2026-10-26 per explicit
// product decision (was bilingual Arabic+English in one message before
// that) -- same single-locale shape as every other export in this file
// now. Callers are responsible for only invoking this for a participant
// whose account currently uses the approved temporary password
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
  const subject = 'Your COY21 Türkiye 2026 account has been created';

  const text = [
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

  const html = buildBrandedEmailHtml({
    locale: 'en',
    heading: 'Your account has been created',
    paragraphs: [
      `Hello ${params.fullName},`,
      `Your COY21 Türkiye 2026 platform account has been created.\n\nUsername: ${params.to}\nTemporary password: ${params.temporaryPassword}\nLogin: ${loginUrl}`,
      'You will be required to change your password when you first log in. Access to your participant profile and personal schedule will remain restricted until this step is completed.',
      `Support: ${config.supportEmail}`,
    ],
    cta: { label: 'Log in', url: loginUrl },
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
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

// Richer, role-aware welcome email for bulk-provisioned staff/super_admin
// accounts (COY21 YOUNGO volunteer cohort, Nov 2026). Distinct from
// sendLoginDetailsEmail above (kept as-is for its existing callers) --
// this one explains what the account can actually do day-to-day instead of
// just handing over credentials, per explicit product request. English-only,
// same reasoning as sendLoginDetailsEmail. Never includes passport, medical,
// or allocation-answer data -- only name, username, temporary password,
// login URL, and support contact, same privacy boundary as every other
// credential email in this file.
export type RoleWelcomeEmailRole = 'staff' | 'super_admin' | 'delegate';

const ROLE_WELCOME_CONTENT: Record<
  RoleWelcomeEmailRole,
  { subject: string; intro: string; whatYouCanDo: string[]; closing: string }
> = {
  staff: {
    subject: 'Welcome to the COY21 Türkiye 2026 volunteer team — your account is ready',
    intro:
      "Thank you for joining the COY21 Türkiye 2026 volunteer team. Your platform account has been created, and you'll be using it throughout the conference (5–7 November, Antalya) to help check participants into sessions and venue entry points.",
    whatYouCanDo: [
      "Log in with the username and temporary password below. You'll be asked to set your own password on first login — this is required before you can do anything else.",
      "Once logged in, you'll see your assigned sessions and/or entry points for each conference day. Your coordinator will confirm your specific assignment (which sessions, which gate, which day) closer to the event.",
      'At the venue, use the scanning screen on your phone to check in participants by scanning the QR code on their badge — a green confirmation means they are cleared, a red one means they are not and should be referred to the help desk.',
      'If a participant has an issue (lost badge, scan error, access question), do not try to resolve it yourself — send them to the registration/help desk.',
    ],
    closing:
      "If you have any trouble logging in or using the scanning screen, contact the support address below before the conference starts so we can sort it out in advance.",
  },
  super_admin: {
    subject: 'Welcome to the COY21 Türkiye 2026 organizing team — your account is ready',
    intro:
      "Your COY21 Türkiye 2026 platform account has been created with full administrative access, ahead of the conference (5–7 November, Antalya).",
    whatYouCanDo: [
      "Log in with the username and temporary password below. You'll be asked to set your own password on first login — this is required before you can access anything else.",
      'With this account you can manage participant applications, staff accounts, session assignments, attendance, and the other administrative areas of the platform.',
      'Please treat this access as sensitive — it reaches participant data and can change how check-in and scheduling work live during the conference.',
    ],
    closing: 'If anything looks wrong or you need a walkthrough of any admin area, reach out on the support address below.',
  },
  delegate: {
    subject: 'Welcome to COY21 Türkiye 2026 — your account is ready',
    intro:
      "Your registration for COY21 Türkiye 2026 (5–7 November, Antalya) has been confirmed, and your participant account is ready.",
    whatYouCanDo: [
      "Log in with the username and temporary password below. You'll be asked to set your own password on first login.",
      "The first time you log in, you'll go through a short welcome walkthrough that shows you around the platform — your profile, the session agenda, and your personal QR code.",
      'Your QR code (under "My QR Code" once logged in) is what you use to check into sessions and the venue — keep it accessible on your phone during the conference.',
      'Under "My Agenda" you can browse all sessions and book the ones you want to attend, alongside the mandatory sessions already on your schedule.',
    ],
    closing: 'If you run into any issue logging in or anything looks incorrect on your profile, reach out on the support address below.',
  },
};

export async function sendRoleWelcomeEmail(params: {
  to: string;
  fullName: string;
  temporaryPassword: string;
  role: RoleWelcomeEmailRole;
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;
  const content = ROLE_WELCOME_CONTENT[params.role];

  const loginUrl = `${config.appUrl}/log-in`;
  const subject = content.subject;

  const credentialsBlock = `Username: ${params.to}\nTemporary password: ${params.temporaryPassword}\nLogin: ${loginUrl}`;
  const whatYouCanDoText = content.whatYouCanDo.map((line, i) => `${i + 1}. ${line}`).join('\n');

  const text = [
    `Hello ${params.fullName},`,
    '',
    content.intro,
    '',
    credentialsBlock,
    '',
    whatYouCanDoText,
    '',
    content.closing,
    '',
    `Support: ${config.supportEmail}`,
  ].join('\n');

  const html = buildBrandedEmailHtml({
    locale: 'en',
    heading: 'Welcome — your account is ready',
    paragraphs: [
      `Hello ${params.fullName},`,
      content.intro,
      credentialsBlock,
      whatYouCanDoText,
      content.closing,
      `Support: ${config.supportEmail}`,
    ],
    cta: { label: 'Log in', url: loginUrl },
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
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

  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'تحديث' : 'UPDATED', color: 'gold' },
    heading: subject,
    paragraphs: body.split('\n\n'),
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    html,
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

  // Links to /browse, not /my-agenda: the booking this email is about is
  // gone, so there's nothing left to see on the agenda -- send the
  // participant somewhere with something to act on. Contrast
  // sendWaitlistPromotionNotificationEmail below, which links straight to
  // /my-agenda because that email's whole point is a new booking the
  // participant now has to see.
  const browseUrl = `${config.appUrl}/my-agenda/browse`;

  const subject =
    params.locale === 'ar'
      ? `تم إلغاء الجلسة: ${params.sessionTitle}`
      : `Session cancelled: ${params.sessionTitle}`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nنأسف لإبلاغك بأن الجلسة التي حجزتها "${params.sessionTitle}" تم إلغاؤها. حجزك لهذه الجلسة أُلغي تلقائياً.\n\nيمكنك تصفح الجلسات المتاحة الأخرى وحجز بديل من هنا: ${browseUrl}\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nWe're sorry to let you know that the session you booked, "${params.sessionTitle}", has been cancelled. Your booking for this session has been automatically cancelled.\n\nYou can browse other available sessions and book a replacement here: ${browseUrl}\n\nIf you have any questions, please contact us.`;

  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'ألغيت' : 'CANCELLED', color: 'gold' },
    heading: subject,
    paragraphs: body.split('\n\n'),
    cta: { label: params.locale === 'ar' ? 'تصفح الجلسات الأخرى' : 'Browse other sessions', url: browseUrl },
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    html,
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

  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'تغيّر الموعد' : 'TIME CHANGED', color: 'gold' },
    heading: subject,
    paragraphs: body.split('\n\n'),
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    html,
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

  // Links to /my-agenda, not /browse: unlike sendSessionCancellationNotificationEmail
  // above (where the booking is gone and browse gives the participant
  // something to act on), this email's whole point is a new confirmed
  // booking the participant now has -- send them straight to see it.
  const agendaUrl = `${config.appUrl}/my-agenda`;

  const subject =
    params.locale === 'ar'
      ? `تمت ترقيتك من قائمة الانتظار: ${params.sessionTitle}`
      : `You're off the waitlist: ${params.sessionTitle}`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nتحرر مقعد في الجلسة "${params.sessionTitle}" وتمت ترقيتك تلقائياً من قائمة الانتظار إلى حجز مؤكد.\n\nيمكنك مراجعة برنامجك من هنا: ${agendaUrl}\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nA seat opened up in "${params.sessionTitle}" and you've been automatically promoted from the waitlist to a confirmed booking.\n\nYou can review your agenda here: ${agendaUrl}\n\nIf you have any questions, please contact us.`;

  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'مؤكّد' : 'CONFIRMED', color: 'green' },
    heading: subject,
    paragraphs: body.split('\n\n'),
    cta: { label: params.locale === 'ar' ? 'مراجعة برنامجي' : 'Review my agenda', url: agendaUrl },
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    html,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}

export async function sendApplicationAcceptedEmail(params: {
  to: string;
  fullName: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const loginUrl = `${config.appUrl}/log-in`;

  const subject =
    params.locale === 'ar'
      ? `تم قبول طلبك في COY21 Türkiye 2026`
      : `Your application to COY21 Türkiye 2026 has been accepted`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nيسعدنا إبلاغك بأن طلبك للمشاركة في COY21 Türkiye 2026 قد تم قبوله.\n\nيمكنك تسجيل الدخول إلى حسابك من هنا: ${loginUrl}\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nWe're pleased to let you know that your application to COY21 Türkiye 2026 has been accepted.\n\nYou can log in to your account here: ${loginUrl}\n\nIf you have any questions, please contact us.`;

  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'تم القبول' : 'ACCEPTED', color: 'green' },
    heading: subject,
    paragraphs: body.split('\n\n'),
    cta: { label: params.locale === 'ar' ? 'تسجيل الدخول' : 'Log in', url: loginUrl },
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    html,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}

export async function sendApplicationRejectedEmail(params: {
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
      ? `تحديث بشأن طلبك في COY21 Türkiye 2026`
      : `An update on your COY21 Türkiye 2026 application`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nنأسف لإبلاغك بأنه لم يتم قبول طلبك للمشاركة في COY21 Türkiye 2026 هذه المرة.\n\nنشكرك على اهتمامك ووقتك، ونتمنى لك التوفيق في مشاركاتك القادمة.\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nWe're sorry to let you know that your application to COY21 Türkiye 2026 was not accepted this time.\n\nThank you for your interest and your time -- we wish you the best with your future engagements.\n\nIf you have any questions, please contact us.`;

  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'تحديث على الطلب' : 'APPLICATION UPDATE', color: 'red' },
    heading: subject,
    paragraphs: body.split('\n\n'),
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    html,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}

export async function sendBookingConfirmedEmail(params: {
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

  // Links to /my-agenda, matching sendWaitlistPromotionNotificationEmail's
  // reasoning above: this email's whole point is a new confirmed booking
  // the participant now has -- send them straight to see it.
  const agendaUrl = `${config.appUrl}/my-agenda`;

  const subject =
    params.locale === 'ar'
      ? `تم تأكيد حجزك: ${params.sessionTitle}`
      : `Your booking is confirmed: ${params.sessionTitle}`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nتم تأكيد حجزك في الجلسة "${params.sessionTitle}".\n\nيمكنك مراجعة برنامجك من هنا: ${agendaUrl}\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nYour booking for "${params.sessionTitle}" has been confirmed.\n\nYou can review your agenda here: ${agendaUrl}\n\nIf you have any questions, please contact us.`;

  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'مؤكّد' : 'CONFIRMED', color: 'green' },
    heading: subject,
    paragraphs: body.split('\n\n'),
    cta: { label: params.locale === 'ar' ? 'مراجعة برنامجي' : 'Review my agenda', url: agendaUrl },
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    html,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}

// Sub-project 6, Task 6: these two functions give session-reminders/route.ts
// and travel-reminders/route.ts's notification content (title + free-text
// body, both already locale-resolved by their own producer routes, which
// still own their respective time-window/no-travel-leg queries) a real
// dispatch path through the unified process-notifications cron. params.body
// is the producer route's own locale-resolved body text (e.g. room/time for
// a session reminder, or the reminder explainer for a travel reminder) --
// this function does not re-derive locale-specific copy itself, unlike
// every other export in this file, because the row's own title/body were
// already built with the correct locale by the producer route at
// create_notification-call time (see session-reminders/route.ts and
// travel-reminders/route.ts). Still routed through sendEmailGuarded like
// every other send in this file.
export async function sendSessionReminderEmail(params: {
  to: string;
  fullName: string;
  title: string;
  body: string | null;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }

  const greeting = params.locale === 'ar' ? `مرحباً ${params.fullName}،` : `Hello ${params.fullName},`;
  const text = [greeting, '', params.title, ...(params.body ? ['', params.body] : [])].join('\n');

  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'تذكير' : 'REMINDER', color: 'blue' },
    heading: params.title,
    paragraphs: params.body ? [params.body] : [params.title],
    logoUrl: `${configResult.config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: configResult.config.apiKey,
    from: configResult.config.fromEmail,
    replyTo: configResult.config.replyToEmail,
    to: params.to,
    subject: params.title,
    text,
    html,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}

export async function sendTravelReminderEmail(params: {
  to: string;
  fullName: string;
  title: string;
  body: string | null;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }

  const greeting = params.locale === 'ar' ? `مرحباً ${params.fullName}،` : `Hello ${params.fullName},`;
  const text = [greeting, '', params.body ?? params.title].join('\n');

  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'إجراء مطلوب' : 'ACTION NEEDED', color: 'blue' },
    heading: params.title,
    paragraphs: params.body ? [params.body] : [params.title],
    logoUrl: `${configResult.config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: configResult.config.apiKey,
    from: configResult.config.fromEmail,
    replyTo: configResult.config.replyToEmail,
    to: params.to,
    subject: params.title,
    text,
    html,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}

export async function sendAnnouncementEmail(params: {
  to: string;
  fullName: string;
  title: string;
  body: string | null;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const subject =
    params.locale === 'ar'
      ? `إعلان من COY21 Türkiye 2026: ${params.title}`
      : `Announcement from COY21 Türkiye 2026: ${params.title}`;

  // params.body is the free-text announcement body (optional -- a staff
  // announcement can be title-only), distinct from this function's own
  // outer `body` variable name used by every other export in this file;
  // named bodyText here to avoid shadowing confusion while still matching
  // the established subject/body-ternary shape.
  const bodyText =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\n${params.title}${params.body ? `\n\n${params.body}` : ''}\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\n${params.title}${params.body ? `\n\n${params.body}` : ''}\n\nIf you have any questions, please contact us.`;

  const html = buildBrandedEmailHtml({
    locale: params.locale,
    heading: subject,
    paragraphs: bodyText.split('\n\n'),
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: bodyText,
    html,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}


