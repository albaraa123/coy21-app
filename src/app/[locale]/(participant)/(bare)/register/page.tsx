import { getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { isSelfRegistrationEnabled } from '@/lib/feature-flags';
import RegistrationForm from './registration-form';

export default async function RegisterPage() {
  if (!isSelfRegistrationEnabled()) {
    notFound();
  }

  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const { data: existing } = await supabase
    .from('applications')
    .select('*')
    .eq('applicant_id', user.id)
    .maybeSingle();

  if (existing && existing.status !== 'draft') {
    redirect({ href: '/my-application', locale });
  }

  let draft = existing;
  if (!draft) {
    const { data: created, error } = await supabase
      .from('applications')
      .insert({ applicant_id: user.id, status: 'draft' })
      .select('*')
      .single();
    if (error) throw error;
    draft = created;
  }

  return <RegistrationForm draft={draft} />;
}
