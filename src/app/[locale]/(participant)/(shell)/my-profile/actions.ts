'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

// ---------------------------------------------------------------------------
// Emergency contacts
// ---------------------------------------------------------------------------

export type ContactInput = {
  name: string;
  relationship: string;
  phone: string;
  email?: string;
};

export async function saveEmergencyContact(
  contactId: string | null,
  applicationId: string,
  input: ContactInput,
): Promise<{ id?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  // Verify ownership
  const { data: app } = await supabase
    .from('applications')
    .select('id')
    .eq('id', applicationId)
    .eq('applicant_id', user.id)
    .single();
  if (!app) return { error: 'Not authorized' };

  if (contactId) {
    const { error } = await supabase
      .from('emergency_contacts')
      .update({ name: input.name, relationship: input.relationship, phone: input.phone, email: input.email ?? null })
      .eq('id', contactId)
      .eq('application_id', applicationId);
    if (error) return { error: error.message };
    return { id: contactId };
  } else {
    const { data, error } = await supabase
      .from('emergency_contacts')
      .insert({ application_id: applicationId, name: input.name, relationship: input.relationship, phone: input.phone, email: input.email ?? null })
      .select('id')
      .single();
    if (error) return { error: error.message };
    return { id: data.id };
  }
}

export async function deleteEmergencyContact(
  contactId: string,
  applicationId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  // Verify the applicationId belongs to the calling user before deleting
  const { data: app } = await supabase
    .from('applications')
    .select('id')
    .eq('id', applicationId)
    .eq('applicant_id', user.id)
    .single();
  if (!app) return { error: 'Not authorized' };

  const { error } = await supabase
    .from('emergency_contacts')
    .delete()
    .eq('id', contactId)
    .eq('application_id', applicationId);
  if (error) return { error: error.message };
  return {};
}

// ---------------------------------------------------------------------------
// Identity (Name / Email / Phone / Photo)
// ---------------------------------------------------------------------------

export type IdentityInput = {
  fullName: string;
  email: string;
  phone: string;
  avatarPath: string | null;
};

export async function saveIdentity(input: IdentityInput): Promise<{ error?: string }> {
  if (!input.fullName.trim() || !input.email.trim() || !input.phone.trim() || !input.avatarPath) {
    return { error: 'Name, email, phone, and a profile picture are required.' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  // full_name and avatar_path are plain profiles columns -- write directly.
  const { error: profileError } = await supabase
    .from('profiles')
    .update({ full_name: input.fullName, avatar_path: input.avatarPath, phone: input.phone })
    .eq('id', user.id);
  if (profileError) return { error: profileError.message };

  // Mirror the name onto applications.full_name too -- a SEPARATE column
  // with no trigger or other sync keeping it aligned with profiles.full_name
  // (confirmed: no sync migration touches both, and applications_update_own_draft's
  // RLS policy only lets a participant write to their OWN application while
  // it's still status='draft' -- by the time someone is on My Profile their
  // application is normally already accepted, so the regular `supabase`
  // client above cannot write here; must use service-role). Several surfaces
  // read applications.full_name directly instead of profiles.full_name (QR
  // display, admission lookup, funding, travel ops, notification emails),
  // so without this mirror a name correction on My Profile would silently
  // never reach any of them. Best-effort: a participant with no submitted
  // application yet (no matching row) is not an error -- there's nothing to
  // sync to.
  const service = createServiceRoleClient();
  await service.from('applications').update({ full_name: input.fullName }).eq('applicant_id', user.id);

  // email is NOT written to profiles directly (the grant no longer
  // allows it -- see 20261025000200_narrow_profiles_email_grant.sql).
  // Only call auth.updateUser if the email actually changed, to avoid
  // sending a needless confirmation email on every unrelated save.
  if (input.email.trim() !== user.email) {
    const { error: authError } = await supabase.auth.updateUser({ email: input.email });
    if (authError) return { error: authError.message };
  }

  return {};
}

// ---------------------------------------------------------------------------
// Accommodation
// ---------------------------------------------------------------------------

export type AccommodationInput = {
  hotel_name: string;
  location_note: string;
  room_number: string;
};

export async function saveAccommodation(
  applicationId: string,
  input: AccommodationInput,
): Promise<{ error?: string }> {
  if (!input.hotel_name.trim() || !input.location_note.trim()) {
    return { error: 'Hotel name and location note are required.' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { data: app } = await supabase
    .from('applications')
    .select('id')
    .eq('id', applicationId)
    .eq('applicant_id', user.id)
    .single();
  if (!app) return { error: 'Not authorized' };

  const { error } = await supabase
    .from('application_accommodation')
    .upsert(
      { application_id: applicationId, hotel_name: input.hotel_name || null, location_note: input.location_note || null, room_number: input.room_number || null },
      { onConflict: 'application_id' },
    );
  if (error) return { error: error.message };
  return {};
}
