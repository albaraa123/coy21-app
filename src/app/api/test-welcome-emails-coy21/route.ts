import { sendRoleWelcomeEmail } from '@/lib/email/resend';

// Temporary test route — sends one sample welcome email per role to the
// configured sandbox recipient (email_settings.sandbox_enabled gates the
// real recipient, confirmed ON before this route was ever deployed).
// Removed once the preview is confirmed.
const SAMPLE_PASSWORD_PLACEHOLDER = 'sample-temp-password-123';

export async function GET() {
  const results = [];

  results.push(
    await sendRoleWelcomeEmail({
      to: 'staff-sample@example.com',
      fullName: 'Ayşe Yılmaz',
      temporaryPassword: SAMPLE_PASSWORD_PLACEHOLDER,
      role: 'staff',
    })
  );

  results.push(
    await sendRoleWelcomeEmail({
      to: 'admin-sample@example.com',
      fullName: 'Ali Şerif',
      temporaryPassword: SAMPLE_PASSWORD_PLACEHOLDER,
      role: 'super_admin',
    })
  );

  results.push(
    await sendRoleWelcomeEmail({
      to: 'delegate-sample@example.com',
      fullName: 'Fatima Al-Rashid',
      temporaryPassword: SAMPLE_PASSWORD_PLACEHOLDER,
      role: 'delegate',
    })
  );

  return Response.json({ results });
}
