'use server';

import { createClient } from '@/lib/supabase/server';

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
