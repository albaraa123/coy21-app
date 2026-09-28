'use server';

import { createClient } from '@/lib/supabase/server';
import type { Database } from '@/types/database';

type LegType = Database['public']['Enums']['travel_leg_type'];

export type TravelLegInput = {
  leg_type: LegType;
  flight_number: string;
  departure_airport: string;
  arrival_airport: string;
  departure_datetime: string;
  arrival_datetime: string;
  notes: string;
};

export async function saveTravelLeg(
  legId: string | null,
  input: TravelLegInput
): Promise<{ id?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { data: app } = await supabase
    .from('applications')
    .select('id')
    .eq('applicant_id', user.id)
    .eq('status', 'accepted')
    .maybeSingle();
  if (!app) return { error: 'No accepted application found.' };

  const payload = {
    application_id: app.id,
    leg_type: input.leg_type,
    flight_number: input.flight_number || null,
    departure_airport: input.departure_airport || null,
    arrival_airport: input.arrival_airport || null,
    departure_datetime: input.departure_datetime || null,
    arrival_datetime: input.arrival_datetime || null,
    notes: input.notes || null,
  };

  if (legId) {
    const { error } = await supabase
      .from('travel_legs')
      .update(payload)
      .eq('id', legId)
      .eq('application_id', app.id);
    if (error) return { error: error.message };
    return { id: legId };
  } else {
    const { data, error } = await supabase
      .from('travel_legs')
      .insert(payload)
      .select('id')
      .single();
    if (error) return { error: error.message };
    return { id: data.id };
  }
}

export async function deleteTravelLeg(legId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { data: app } = await supabase
    .from('applications')
    .select('id')
    .eq('applicant_id', user.id)
    .eq('status', 'accepted')
    .maybeSingle();
  if (!app) return { error: 'No accepted application found.' };

  const { error } = await supabase
    .from('travel_legs')
    .delete()
    .eq('id', legId)
    .eq('application_id', app.id);

  if (error) return { error: error.message };
  return {};
}
