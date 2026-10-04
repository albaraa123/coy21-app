'use server';

import { createClient } from '@/lib/supabase/server';

type BookResult = { bookingId?: string; error?: string };
type CancelResult = { error?: string };

/**
 * Book a session for the current participant.
 * Delegates all business logic (deadline, capacity, conflict) to the
 * book_session DB function (SECURITY DEFINER).
 */
export async function bookSession(sessionId: string): Promise<BookResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  // Resolve the caller's application id
  const { data: app } = await supabase
    .from('applications')
    .select('id')
    .eq('applicant_id', user.id)
    .eq('status', 'accepted')
    .maybeSingle();

  if (!app) return { error: 'No accepted application found.' };

  const { data, error } = await supabase.rpc('book_session', {
    p_application_id: app.id,
    p_session_id: sessionId,
  });

  if (error) return { error: error.message };
  return { bookingId: data as string };
}

/**
 * Cancel an existing active booking.
 * Deadline enforcement is inside the cancel_booking DB function.
 */
export async function cancelBooking(bookingId: string): Promise<CancelResult> {
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

  const { error } = await supabase.rpc('cancel_booking', {
    p_booking_id: bookingId,
    p_application_id: app.id,
  });

  if (error) return { error: error.message };
  return {};
}

type WaitlistResult = { waitlistId?: string; error?: string };

/**
 * Join the waitlist for a full session.
 * Delegates capacity/eligibility checks to the join_waitlist DB function
 * (SECURITY DEFINER).
 */
export async function joinWaitlist(sessionId: string): Promise<WaitlistResult> {
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

  const { data, error } = await supabase.rpc('join_waitlist', {
    p_application_id: app.id,
    p_session_id: sessionId,
  });

  if (error) return { error: error.message };
  return { waitlistId: data as string };
}

/**
 * Leave an existing waitlist entry.
 */
export async function leaveWaitlist(sessionId: string): Promise<CancelResult> {
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

  const { error } = await supabase.rpc('leave_waitlist', {
    p_application_id: app.id,
    p_session_id: sessionId,
  });

  if (error) return { error: error.message };
  return {};
}
