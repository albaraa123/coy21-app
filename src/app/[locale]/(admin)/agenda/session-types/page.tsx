// src/app/[locale]/(admin)/agenda/session-types/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import SessionTypeManager from './session-type-manager';

export default async function SessionTypesPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !(isAgendaStaffRole(profile.role) || isProgramAttendanceStaffRole(profile.role))) {
    notFound();
  }

  // Same reasoning as rooms/page.tsx: `session_types_staff_all` grants any
  // agenda staff caller unrestricted read access to every `session_types` row
  // (no per-row owner check), and this query doesn't touch `profiles`, so the
  // session client is sufficient — verified directly against the live database.
  const { data: sessionTypes } = await supabase
    .from('session_types')
    .select('id, code, name_ar, name_en, is_active')
    .order('code', { ascending: true });

  const t = await getTranslations({ locale, namespace: 'agenda.sessionTypes' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-4 text-lg font-semibold text-charcoal dark:text-gray-100 md:mb-6">{t('title')}</h1>
      <SessionTypeManager sessionTypes={sessionTypes ?? []} />
    </div>
  );
}
