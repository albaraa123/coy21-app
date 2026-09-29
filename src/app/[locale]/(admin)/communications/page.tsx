// src/app/[locale]/(admin)/communications/page.tsx
//
// COY21 Phase 6 — Communications page.
// Allows participants_communications_manager and super_admin to send
// targeted emails to participant subsets via Resend.

import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ComposeForm } from './compose-form';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function CommunicationsPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!isStaffRole(profile?.role)) {
    redirect({ href: '/dashboard', locale });
    return;
  }

  return (
    <div className="mx-auto max-w-2xl p-4 md:p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">
          Communications
        </h1>
        <p className="mt-0.5 text-sm text-charcoal/60 dark:text-gray-400">
          Send targeted emails to COY21 participant groups.
        </p>
      </div>

      <Card>
        <ComposeForm />
      </Card>
    </div>
  );
}
