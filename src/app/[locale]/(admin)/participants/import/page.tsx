// src/app/[locale]/(admin)/participants/import/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isParticipantsCommunicationsStaffRole } from '@/lib/validation/participants-communications';
import UploadForm from './upload-form';

export default async function ImportParticipantsPage() {
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
  if (!profile || !(isAgendaStaffRole(profile.role) || isParticipantsCommunicationsStaffRole(profile.role))) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: 'participants.import.upload' });

  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
      <div>
        <Link href="/participants" className="text-sm font-medium text-turquoise hover:underline">
          {t('backLabel')}
        </Link>
        <h1 className="mt-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      </div>
      <UploadForm />
    </div>
  );
}
