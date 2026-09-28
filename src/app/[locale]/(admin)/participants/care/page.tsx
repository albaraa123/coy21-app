// src/app/[locale]/(admin)/participants/care/page.tsx
//
// Phase 8.2 — Participant Care Staff Screen. Mirrors
// attendance/admissions/page.tsx's exact shape: inline auth + role gate
// (participant_care_staff / super_admin only, via
// isParticipantCareStaffRole), then hands off to a client component that
// does its own search/fetch/save via ./actions.ts. No pre-fetched list —
// same reasoning as the admissions console: the working set isn't known
// until staff search.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isParticipantCareStaffRole } from '@/lib/validation/participant-care';
import { notFound } from 'next/navigation';
import ParticipantCareConsole from './participant-care-console';

export default async function ParticipantCarePage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !isParticipantCareStaffRole(profile.role)) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: 'participantCare' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      <p className="mb-4 text-sm text-charcoal/70 dark:text-gray-400 md:mb-6">{t('description')}</p>
      <ParticipantCareConsole />
    </div>
  );
}
