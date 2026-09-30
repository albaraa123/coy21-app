// src/app/[locale]/(admin)/settings/actions.ts
'use server';

import { requireSuperAdmin } from '@/lib/auth/require-super-admin';
import { revalidatePath } from 'next/cache';

const DISABLE_CONFIRMATION_PHRASE = 'DISABLE';

// revalidatePath target matches this codebase's established convention
// for (admin) Server Actions (see local-info-hub/actions.ts,
// content/local-info/actions.ts, communications/local-info-actions.ts,
// reports/local-info/actions.ts): a concrete locale-prefixed path, not
// the route-group/layout form.
const SETTINGS_PATH = '/en/admin/settings';

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

  const { error } = await service
    .from('email_settings')
    .update({ sandbox_recipient_email: trimmed, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('id', true);

  if (error) return { error: error.message };
  revalidatePath(SETTINGS_PATH);
  return { error: null };
}

export async function enableSandboxMode(): Promise<{ error: string | null }> {
  const { service, userId } = await requireSuperAdmin();
  const { error } = await service
    .from('email_settings')
    .update({ sandbox_enabled: true, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('id', true);

  if (error) return { error: error.message };
  revalidatePath(SETTINGS_PATH);
  return { error: null };
}

export async function disableSandboxMode(confirmationText: string): Promise<{ error: string | null }> {
  const { service, userId } = await requireSuperAdmin();
  if (confirmationText !== DISABLE_CONFIRMATION_PHRASE) {
    return { error: `You must type exactly "${DISABLE_CONFIRMATION_PHRASE}" to confirm.` };
  }

  const { error } = await service
    .from('email_settings')
    .update({ sandbox_enabled: false, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('id', true);

  if (error) return { error: error.message };
  revalidatePath(SETTINGS_PATH);
  return { error: null };
}
