// src/app/[locale]/(admin)/participants/travel/page.tsx
//
// Phase 8.6 — optional/lightweight Travel Operations screen. Mirrors
// participants/care/page.tsx's exact shape: inline auth + role gate
// (travel_operations_staff / super_admin only, via isTravelOpsStaffRole),
// then hands off to a client component that does its own search/fetch/save
// via ./actions.ts.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isTravelOpsStaffRole } from '@/lib/validation/travel-ops';
import { notFound } from 'next/navigation';
import TravelOpsConsole from './travel-ops-console';

export default async function TravelOpsPage() {
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
  if (!profile || !isTravelOpsStaffRole(profile.role)) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: 'travelOps' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      <p className="mb-4 text-sm text-charcoal/70 dark:text-gray-400 md:mb-6">{t('description')}</p>
      <TravelOpsConsole />
    </div>
  );
}
