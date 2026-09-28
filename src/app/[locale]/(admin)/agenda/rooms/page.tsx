// src/app/[locale]/(admin)/agenda/rooms/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import RoomManager from './room-manager';

export default async function RoomsPage() {
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

  // Unlike Phase 2's applications list (which needs the service-role client to
  // read *other* users' joined `profiles` rows, since profiles RLS only
  // allows self-reads), this query doesn't touch `profiles` at all — it only
  // selects columns of `rooms` itself. The `rooms_staff_all` policy (see
  // supabase/migrations/20260722201600_agenda_reference_rls_policies.sql)
  // grants `current_user_role() in ('agenda_allocation_manager',
  // 'super_admin')` unrestricted access to every row, with no per-row owner
  // check like `profiles_select_own`. So the caller's own session client is
  // sufficient here and is used deliberately (least privilege for this read),
  // verified directly against the live database. The service-role client
  // above is still needed, but only for the role-gate's `profiles` lookup.
  const { data: rooms } = await supabase
    .from('rooms')
    .select('id, code, name_ar, name_en, capacity, location, floor, is_accessible, is_active')
    .order('code', { ascending: true });

  const t = await getTranslations({ locale, namespace: 'agenda.rooms' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-4 text-lg font-semibold text-charcoal dark:text-gray-100 md:mb-6">{t('title')}</h1>
      <RoomManager rooms={rooms ?? []} />
    </div>
  );
}
