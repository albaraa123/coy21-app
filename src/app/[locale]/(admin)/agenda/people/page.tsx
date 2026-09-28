// src/app/[locale]/(admin)/agenda/people/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import PersonManager from './person-manager';

export default async function PeoplePage() {
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

  // Unlike the other 5 reference-entity pages, this page genuinely needs the
  // service-role client for its data queries, not just the role gate above:
  // the "linked platform account" picker in PersonManager lists *other*
  // users' profiles rows (id, full_name) so staff can link a `people` record
  // to any platform account, not just their own. profiles RLS
  // (profiles_select_own / profiles_select_super_admin, see
  // supabase/migrations/20260721212035_rls_policies.sql) only lets a caller
  // read their own profile row — under the session client this list would
  // silently come back empty/single-row for an agenda_allocation_manager
  // caller even though the role check above has already authorized them,
  // same failure mode Phase 2 documented for applications' joined profiles.
  // Verified directly against the live database. `people` itself doesn't
  // need the service-role client (people_staff_all grants staff-wide read,
  // like rooms/tracks/etc.), but it's queried with the same client here for
  // simplicity since the page already needs it for the profiles list.
  const { data: people } = await service
    .from('people')
    .select(
      'id, full_name_ar, full_name_en, title_ar, title_en, organization_ar, organization_en, bio_ar, bio_en, photo_path, email, phone, linked_profile_id, is_active, is_public'
    )
    .order('full_name_en', { ascending: true });

  const { data: profileOptions } = await service
    .from('profiles')
    .select('id, full_name')
    .order('full_name', { ascending: true });

  const t = await getTranslations({ locale, namespace: 'agenda.people' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-4 text-lg font-semibold text-charcoal dark:text-gray-100 md:mb-6">{t('title')}</h1>
      <PersonManager people={people ?? []} profileOptions={profileOptions ?? []} />
    </div>
  );
}
