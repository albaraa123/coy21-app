import { getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import StaffManager from './staff-manager';

export const metadata = { title: 'Staff Management' };

export default async function StaffPage() {
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

  const { data: staff } = await service
    .from('profiles')
    .select('id, full_name, email, role, created_at')
    .neq('role', 'participant')
    .neq('role', 'scanner_device')
    .order('role', { ascending: true });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-1 text-lg font-semibold text-charcoal">Staff Management</h1>
      <p className="mb-6 text-sm text-charcoal/60">Manage staff accounts and their roles. Only super admins can make changes.</p>
      <StaffManager staff={staff ?? []} />
    </div>
  );
}
