// src/app/[locale]/scanner/cafeteria/page.tsx
//
// Nested under src/app/[locale]/scanner/layout.tsx — inherits its
// kiosk-style chrome automatically, no new layout needed. Separate from
// the existing session-scoped /scanner route (not a mode flag on it) —
// see design spec's "UI — Cafeteria Scanner mode" section for why.
//
// Authorization mirrors src/app/[locale]/scanner/page.tsx's own pattern
// exactly (auth.getUser() + isScannerDeviceRole(profile.role), rendered
// as a state rather than thrown) — same reasoning as that page's header
// comment: requireScannerDeviceCaller throws, which fits a 'use server'
// action's error-propagation contract, not a page needing a renderable
// unauthorized state.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isScannerDeviceRole } from '@/lib/validation/scanner-device';
import { ErrorState } from '@/components/states/error-state';
import { CafeteriaScannerClient } from '@/components/scanner/cafeteria-scanner-client';

export default async function CafeteriaScannerPage() {
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

  return <CafeteriaScannerClient />;
}
