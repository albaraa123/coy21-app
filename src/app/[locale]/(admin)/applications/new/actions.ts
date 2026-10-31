'use server';

import { z } from 'zod';
import { requireSuperAdmin } from '@/lib/auth/require-super-admin';

// Same 5 values as public.participant_type (20260822000000_coy21_attendee_codes.sql).
const PARTICIPANT_TYPES = ['delegate', 'volunteer', 'knowledge_partner', 'youngo', 'speaker'] as const;

const createApplicationSchema = z.object({
  fullName: z.string().trim().min(2),
  email: z.string().trim().toLowerCase().email(),
  participantType: z.enum(PARTICIPANT_TYPES),
  phone: z.string().trim().optional(),
  country: z.string().trim().optional(),
  nationality: z.string().trim().optional(),
  organization: z.string().trim().optional(),
});

export async function createParticipantApplication(input: z.infer<typeof createApplicationSchema>) {
  const { service } = await requireSuperAdmin();
  const parsed = createApplicationSchema.parse(input);

  // Reject a duplicate email before creating a second application for the
  // same person -- checks both an unclaimed row's imported_email and a
  // claimed row's linked profiles.email (the two places an application's
  // email can live; see this file's existing applicant_id/imported_email
  // comment below).
  const { data: existingImported } = await service
    .from('applications')
    .select('id')
    .eq('imported_email', parsed.email)
    .limit(1)
    .maybeSingle();
  if (existingImported) {
    throw new Error('An application with this email already exists');
  }
  const { data: existingClaimed } = await service
    .from('applications')
    .select('id, profiles!applications_applicant_id_fkey!inner(email)')
    .eq('profiles.email', parsed.email)
    .limit(1)
    .maybeSingle();
  if (existingClaimed) {
    throw new Error('An application with this email already exists');
  }

  // Same numbering scheme the import pipeline uses
  // (apply_import_row_transactional) -- a type-coded sequence, not a
  // manually-typed value, so this form never lets the admin pick one.
  const { data: applicationNumber, error: numberError } = await service.rpc('next_application_number', {
    p_type: parsed.participantType,
  });
  if (numberError || !applicationNumber) {
    throw new Error(numberError?.message ?? 'Failed to generate an application number');
  }

  // status: 'accepted' (not 'draft') -- an admin manually adding someone
  // has, by construction, already decided to accept them. This also
  // matters functionally: the application detail page
  // (applications/[id]/page.tsx) excludes status='draft' rows outright
  // (.neq('status', 'draft')), so a draft row created here would 404
  // immediately after the redirect below.
  //
  // applicant_id is left unset (null) -- exactly like an imported row
  // before it's claimed. The existing invitation system
  // (src/lib/import/invitation.ts's sendInvitation, already wired into
  // this application's detail page) is what lets the new participant
  // claim it and get a real account; this action does not send an
  // invitation itself.
  const { data: created, error: insertError } = await service
    .from('applications')
    .insert({
      application_number: applicationNumber,
      full_name: parsed.fullName,
      imported_email: parsed.email,
      participant_type: parsed.participantType,
      status: 'accepted',
      phone: parsed.phone || null,
      country: parsed.country || null,
      nationality: parsed.nationality || null,
      organization: parsed.organization || null,
    })
    .select('id')
    .single();
  if (insertError || !created) {
    throw new Error(insertError?.message ?? 'Failed to create application');
  }

  return { id: created.id };
}
