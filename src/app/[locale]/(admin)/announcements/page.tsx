import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import AnnouncementForm from './announcement-form';

// Staff-redirect convention matches
// src/app/[locale]/(admin)/applications/[id]/page.tsx exactly: unauthenticated
// -> redirect to /log-in, authenticated-but-not-staff -> notFound() (not a
// redirect -- same reasoning as that page, avoids revealing this route's
// existence to a non-staff caller). The RPC's own coalesce(is_staff(), false)
// guard (create_announcement, Task 1) is the real authorization boundary;
// this page-level check is the established defense-in-depth precedent, not a
// substitute for it.
export default async function AnnouncementsPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !isStaffRole(profile.role)) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: 'announcements' });

  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
      <div>
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      </div>
      <AnnouncementForm />
    </div>
  );
}
