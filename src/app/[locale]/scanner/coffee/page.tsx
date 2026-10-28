// src/app/[locale]/scanner/coffee/page.tsx
//
// Nested under src/app/[locale]/scanner/layout.tsx -- inherits its
// kiosk-style chrome automatically, no new layout needed. Auth mirrors
// src/app/[locale]/scanner/cafeteria/page.tsx's own pattern exactly
// (inline isScannerDeviceRole check, renderable ErrorState -- NOT
// requireScannerDeviceCaller(), which throws and fits the API routes'
// contract, not a page's).
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isScannerDeviceRole } from '@/lib/validation/scanner-device';
import { ErrorState } from '@/components/states/error-state';
import { CafeteriaCoffeeScannerClient } from '@/components/scanner/cafeteria-coffee-scanner-client';

export default async function CafeteriaCoffeeScannerPage() {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: 'scanner' });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).maybeSingle();

  if (!isScannerDeviceRole(profile?.role)) {
    return <ErrorState title={t('states.unauthorized.title')} description={t('states.unauthorized.description')} />;
  }

  return <CafeteriaCoffeeScannerClient />;
}
