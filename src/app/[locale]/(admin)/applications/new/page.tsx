import { getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import NewApplicationForm from './new-application-form';

export const metadata = { title: 'Add Participant' };

// super_admin only (not general staff) -- matches staff/page.tsx's exact
// gate pattern, intentionally narrower than isStaffRole, per explicit
// user request to scope this to super_admin specifically.
export default async function NewApplicationPage() {
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

  return (
    <div className="mx-auto max-w-xl p-4 md:p-6">
      <h1 className="mb-1 text-lg font-semibold text-charcoal dark:text-gray-100">Add Participant</h1>
      <p className="mb-6 text-sm text-charcoal/60 dark:text-gray-400">
        Creates a new accepted application with no linked account yet. After creating it, use the
        &quot;Send Invitation&quot; button on its detail page to let the participant claim it and register.
      </p>
      <NewApplicationForm />
    </div>
  );
}
