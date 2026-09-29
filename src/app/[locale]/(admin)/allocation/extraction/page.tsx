// src/app/[locale]/(admin)/allocation/extraction/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import RuleManager from './rule-manager';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function ExtractionPage() {
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

  const [{ data: rules }, { data: runs }, { data: tags }] = await Promise.all([
    supabase
      .from('feature_extraction_rules')
      .select('id, version, source_field, match_type, match_value, weight, is_active, tag_id, tags(id, name_en)')
      .order('version', { ascending: false }),
    supabase
      .from('feature_extraction_runs')
      .select('id, rules_version, application_count, run_at')
      .order('run_at', { ascending: false }),
    supabase
      .from('tags')
      .select('id, name_en')
      .eq('is_active', true)
      .order('name_en', { ascending: true }),
  ]);

  const t = await getTranslations({ locale, namespace: 'allocation.extraction' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-4 text-lg font-semibold text-charcoal dark:text-gray-100 md:mb-6">{t('title')}</h1>
      <RuleManager rules={rules ?? []} runs={runs ?? []} tags={tags ?? []} />
    </div>
  );
}
