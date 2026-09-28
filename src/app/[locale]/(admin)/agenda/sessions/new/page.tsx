// src/app/[locale]/(admin)/agenda/sessions/new/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import SessionCreateForm from './session-create-form';

export default async function NewSessionPage() {
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

  const [{ data: days }, { data: tracks }, { data: sessionTypes }, { data: rooms }] = await Promise.all([
    supabase.from('conference_days').select('id, label_en').order('display_order', { ascending: true }),
    supabase.from('tracks').select('id, name_en').order('name_en', { ascending: true }),
    supabase.from('session_types').select('id, name_en').order('name_en', { ascending: true }),
    supabase.from('rooms').select('id, name_en').order('name_en', { ascending: true }),
  ]);

  const t = await getTranslations({ locale, namespace: 'agenda.sessions' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-4 text-lg font-semibold text-charcoal dark:text-gray-100 md:mb-6">{t('detail.create.title')}</h1>
      <SessionCreateForm
        days={days ?? []}
        tracks={tracks ?? []}
        sessionTypes={sessionTypes ?? []}
        rooms={rooms ?? []}
      />
    </div>
  );
}
