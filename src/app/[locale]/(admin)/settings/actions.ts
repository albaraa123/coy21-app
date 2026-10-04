// src/app/[locale]/(admin)/settings/actions.ts
'use server';

import { requireSuperAdmin } from '@/lib/auth/require-super-admin';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import type { Database } from '@/types/database';

const DISABLE_CONFIRMATION_PHRASE = 'DISABLE';

// revalidatePath target matches this codebase's established convention
// for (admin) Server Actions (see local-info-hub/actions.ts,
// content/local-info/actions.ts, communications/local-info-actions.ts,
// reports/local-info/actions.ts): a concrete locale-prefixed path, not
// the route-group/layout form.
const SETTINGS_PATH = '/en/admin/settings';

type EmailSettingsPatch = Partial<
  Pick<Database['public']['Tables']['email_settings']['Update'], 'sandbox_enabled' | 'sandbox_recipient_email'>
>;

// All 3 actions below share this same table/filter/error-shape/revalidate
// pattern — factored out so the three call sites can't silently drift
// (e.g. one forgetting updated_by) as this file evolves.
async function applyEmailSettingsUpdate(
  service: ReturnType<typeof createServiceRoleClient>,
  userId: string,
  patch: EmailSettingsPatch
): Promise<{ error: string | null }> {
  const { error } = await service
    .from('email_settings')
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('id', true);

  if (error) return { error: error.message };
  revalidatePath(SETTINGS_PATH);
  return { error: null };
}

export async function updateSandboxRecipient(email: string): Promise<{ error: string | null }> {
  const { service, userId } = await requireSuperAdmin();
  const trimmed = email.trim();
  if (trimmed.length === 0) {
    return { error: 'Recipient email cannot be empty' };
  }
  // Minimal shape check only — this is an internal operator-configured
  // address, not user-facing input requiring exhaustive validation.
  if (!trimmed.includes('@')) {
    return { error: 'Enter a valid email address' };
  }

  return applyEmailSettingsUpdate(service, userId, { sandbox_recipient_email: trimmed });
}

export async function enableSandboxMode(): Promise<{ error: string | null }> {
  const { service, userId } = await requireSuperAdmin();
  return applyEmailSettingsUpdate(service, userId, { sandbox_enabled: true });
}

export async function disableSandboxMode(confirmationText: string): Promise<{ error: string | null }> {
  const { service, userId } = await requireSuperAdmin();
  if (confirmationText !== DISABLE_CONFIRMATION_PHRASE) {
    return { error: `You must type exactly "${DISABLE_CONFIRMATION_PHRASE}" to confirm.` };
  }

  return applyEmailSettingsUpdate(service, userId, { sandbox_enabled: false });
}

async function applyConferenceSettingsUpdate(
  service: ReturnType<typeof createServiceRoleClient>,
  userId: string,
  patch: { global_booking_deadline: string | null }
): Promise<{ error: string | null }> {
  const { error } = await service
    .from('conference_settings')
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('id', true);

  if (error) return { error: error.message };
  revalidatePath(SETTINGS_PATH);
  return { error: null };
}

export async function setGlobalBookingDeadline(deadlineIso: string): Promise<{ error: string | null }> {
  const { service, userId } = await requireSuperAdmin();
  return applyConferenceSettingsUpdate(service, userId, { global_booking_deadline: deadlineIso });
}

export async function clearGlobalBookingDeadline(): Promise<{ error: string | null }> {
  const { service, userId } = await requireSuperAdmin();
  return applyConferenceSettingsUpdate(service, userId, { global_booking_deadline: null });
}
