import { getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import AssignmentManager from './assignment-manager';

export const metadata = { title: 'Staff Assignments' };

export default async function StaffAssignmentsPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'super_admin') {
    notFound();
  }

  const [{ data: staff }, { data: assignments }, { data: rooms }] = await Promise.all([
    service
      .from('profiles')
      .select('id, full_name, email, role')
      .neq('role', 'participant')
      .neq('role', 'scanner_device')
      .order('full_name'),
    service
      .from('staff_assignments')
      .select('id, staff_id, assignment_type, label, notes, starts_at, ends_at, room_id')
      .order('starts_at', { ascending: true }),
    service
      .from('rooms')
      .select('id, code, name_en')
      .eq('is_active', true)
      .order('code'),
  ]);

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-1 text-lg font-semibold text-charcoal">Staff Assignments</h1>
      <p className="mb-6 text-sm text-charcoal/60">Assign staff to gates, rooms, or tasks. Only visible to super admins.</p>
      <AssignmentManager
        staff={staff ?? []}
        assignments={assignments ?? []}
        rooms={rooms ?? []}
      />
    </div>
  );
}
