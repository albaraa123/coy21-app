import { getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import { LocalInfoManager } from './local-info-manager';

export default async function AdminLocalInfoPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  // 2026-09-29 staff role consolidation: was a hand-rolled
  // ['super_admin', 'participants_communications_manager'].includes(...)
  // check — participants_communications_manager no longer exists as an
  // assignable role (migrated to 'staff'), so this was silently locking
  // out every staff account until fixed. See
  // docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md.
  if (!profile || !isStaffRole(profile.role)) {
    notFound();
  }

  const [{ data: sections }, { data: images }] = await Promise.all([
    service
      .from('local_info_sections')
      .select('id, title, sort_order, is_active, local_info_items(id, label, value, sort_order)')
      .order('sort_order', { ascending: true }),
    service
      .from('local_info_images')
      .select('id, section_id, caption, storage_url, sort_order')
      .order('sort_order', { ascending: true }),
  ]);

  return (
    <div className="p-4 md:p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">Local Info Hub</h1>
        <p className="mt-1 text-sm text-charcoal/60 dark:text-gray-400">
          Manage the sections, items, and images shown to participants on the Local Info page.
        </p>
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-400">
          <strong>Before editing:</strong> make sure you have run migration <code>20260825200000_local_info.sql</code> in your Supabase SQL editor, and created a public storage bucket named <code>local-info</code>.
        </div>
      </div>
      <LocalInfoManager
        sections={(sections ?? []) as Parameters<typeof LocalInfoManager>[0]['sections']}
        images={images ?? []}
      />
    </div>
  );
}
