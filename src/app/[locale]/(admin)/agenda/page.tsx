// src/app/[locale]/(admin)/agenda/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { isStaffRole } from '@/lib/auth/is-staff-role';

const LINKS = [
  { href: '/agenda/sessions', key: 'sessions' },
  { href: '/agenda/days', key: 'days' },
  { href: '/agenda/tracks', key: 'tracks' },
  { href: '/agenda/session-types', key: 'sessionTypes' },
  { href: '/agenda/rooms', key: 'rooms' },
  { href: '/agenda/people', key: 'people' },
  { href: '/agenda/tags', key: 'tags' },
] as const;

export default async function AgendaOverviewPage() {
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

  const t = await getTranslations({ locale, namespace: 'agenda.overview' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      <p className="mb-4 text-sm text-charcoal/70 dark:text-gray-400 md:mb-6">{t('description')}</p>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {LINKS.map((link) => (
          <li key={link.key}>
            <Link href={link.href} className="block">
              <Card className="h-full transition-colors hover:border-turquoise/60">
                <p className="text-sm font-medium text-charcoal dark:text-gray-100">{t(`links.${link.key}`)}</p>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
