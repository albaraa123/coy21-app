'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isParticipantsCommunicationsStaffRole } from '@/lib/validation/participants-communications';
import { getResendConfig } from '@/lib/email/resend-config';
import { Resend } from 'resend';

export type AudienceKey =
  | 'all_accepted'
  | 'no_travel'
  | 'no_bookings'
  | 'type_delegate'
  | 'type_volunteer'
  | 'type_kp'
  | 'type_youngo'
  | 'type_speaker';

export type SendResult = {
  sent: number;
  failed: number;
  error?: string;
};

export async function sendBulkEmail(params: {
  audience: AudienceKey;
  subject: string;
  body: string;
}): Promise<SendResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { sent: 0, failed: 0, error: 'Not authenticated' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!isParticipantsCommunicationsStaffRole(profile?.role)) {
    return { sent: 0, failed: 0, error: 'Not authorized' };
  }

  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { sent: 0, failed: 0, error: `Email not configured: ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const service = createServiceRoleClient();

  // Resolve the audience to a list of {full_name, email} rows.
  const recipients = await resolveAudience(service, params.audience);
  if (recipients.length === 0) {
    return { sent: 0, failed: 0, error: 'No recipients found for selected audience' };
  }

  const resend = new Resend(config.apiKey);
  let sent = 0;
  let failed = 0;

  // Send in serial to stay within Resend rate limits.
  // For large audiences (>100) a batch API or queue should be used,
  // but for COY21 operational comms this is sufficient.
  for (const r of recipients) {
    const personalizedBody = params.body.replace(/\{\{name\}\}/g, r.name);
    const { error } = await resend.emails.send({
      from: config.fromEmail,
      replyTo: config.replyToEmail,
      to: r.email,
      subject: params.subject,
      text: personalizedBody,
    });
    if (error) {
      failed++;
    } else {
      sent++;
    }
  }

  return { sent, failed };
}

export async function previewAudienceCount(audience: AudienceKey): Promise<number> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!isParticipantsCommunicationsStaffRole(profile?.role)) return 0;

  const service = createServiceRoleClient();
  const recipients = await resolveAudience(service, audience);
  return recipients.length;
}

// ---------------------------------------------------------------------------
// Audience resolution — returns minimal {name, email} list per audience key.
// All queries run as service role.
// ---------------------------------------------------------------------------

type Recipient = { name: string; email: string };

async function resolveAudience(
  service: ReturnType<typeof createServiceRoleClient>,
  audience: AudienceKey,
): Promise<Recipient[]> {

  if (audience.startsWith('type_')) {
    const typeMap: Record<string, string> = {
      type_delegate: 'delegate',
      type_volunteer: 'volunteer',
      type_kp: 'knowledge_partner',
      type_youngo: 'youngo',
      type_speaker: 'speaker',
    };
    const ptType = typeMap[audience];
    if (!ptType) return [];

    const { data } = await service
      .from('applications')
      .select('participant_type, profiles!applications_applicant_id_fkey(full_name, email)')
      .eq('status', 'accepted')
      .eq('participant_type', ptType as 'delegate' | 'volunteer' | 'knowledge_partner' | 'youngo' | 'speaker');

    return toRecipients(data ?? []);
  }

  if (audience === 'all_accepted') {
    const { data } = await service
      .from('applications')
      .select('profiles!applications_applicant_id_fkey(full_name, email)')
      .eq('status', 'accepted');

    return toRecipients(data ?? []);
  }

  if (audience === 'no_travel') {
    // Accepted participants who have zero travel_legs
    const { data: withTravel } = await service
      .from('travel_legs')
      .select('application_id');

    const withTravelIds = new Set((withTravel ?? []).map((r) => r.application_id));

    const { data } = await service
      .from('applications')
      .select('id, profiles!applications_applicant_id_fkey(full_name, email)')
      .eq('status', 'accepted');

    return toRecipients(
      (data ?? []).filter((r) => !withTravelIds.has(r.id))
    );
  }

  if (audience === 'no_bookings') {
    // Accepted participants who have zero active session bookings
    const { data: withBookings } = await service
      .from('session_bookings')
      .select('application_id')
      .eq('status', 'active');

    const withBookingIds = new Set((withBookings ?? []).map((r) => r.application_id));

    const { data } = await service
      .from('applications')
      .select('id, profiles!applications_applicant_id_fkey(full_name, email)')
      .eq('status', 'accepted');

    return toRecipients(
      (data ?? []).filter((r) => !withBookingIds.has(r.id))
    );
  }

  return [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRecipients(rows: any[]): Recipient[] {
  const out: Recipient[] = [];
  for (const row of rows) {
    const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    if (profile?.email && profile?.full_name) {
      out.push({ name: profile.full_name, email: profile.email });
    }
  }
  return out;
}
