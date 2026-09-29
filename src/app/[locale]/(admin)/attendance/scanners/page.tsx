// src/app/[locale]/(admin)/attendance/scanners/page.tsx
//
// Phase 7F — scanner assignment management. Mirrors agenda/rooms/page.tsx's
// exact shape: service-role client only for the profiles-touching reads
// (the caller's own role-gate lookup, and scanner_user_id -> full_name/email
// display — profiles RLS only allows self-reads, same reasoning
// scanner-assignment-context.ts's own doc comment gives). scanner_assignments
// itself has a manager-scoped RLS policy already
// (scanner_assignments_manager_all), so either client would work for that
// table specifically, but the service-role client is used throughout here
// for consistency with the joined profiles/sessions/rooms reads in the same
// query.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import ScannerAssignmentManager from './scanner-assignment-manager';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function ScannerAssignmentsPage() {
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
  if (!profile || !isStaffRole(profile.role)) {
    notFound();
  }

  // scanner_device accounts only, so the "assign to" picker in the UI can
  // never target a non-scanner account — same allow-list discipline as
  // assertScannerTarget in actions.ts, just applied to the read side.
  const { data: scanners } = await service
    .from('profiles')
    .select('id, full_name, email')
    .eq('role', 'scanner_device')
    .order('full_name', { ascending: true });

  const { data: assignments } = await service
    .from('scanner_assignments')
    .select('id, scanner_user_id, session_id, room_id, is_active, assigned_at, sessions(id, title_ar, title_en, status, room_id), rooms(id, code, name_ar, name_en)')
    .order('assigned_at', { ascending: false });

  const { data: sessions } = await service
    .from('sessions')
    .select('id, title_ar, title_en, status, room_id, start_time, end_time')
    .eq('status', 'confirmed')
    .order('start_time', { ascending: true });

  const { data: rooms } = await service.from('rooms').select('id, code, name_ar, name_en').eq('is_active', true).order('code', { ascending: true });

  const t = await getTranslations({ locale, namespace: 'scannerAssignments' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-4 text-lg font-semibold text-charcoal dark:text-gray-100 md:mb-6">{t('title')}</h1>
      <ScannerAssignmentManager scanners={scanners ?? []} assignments={assignments ?? []} sessions={sessions ?? []} rooms={rooms ?? []} />
    </div>
  );
}
