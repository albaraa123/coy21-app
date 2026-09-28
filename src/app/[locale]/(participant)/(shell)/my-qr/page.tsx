// src/app/[locale]/(participant)/(shell)/my-qr/page.tsx
//
// Participant QR Experience. Server Component: authenticates the caller
// (via the shared (shell)/layout.tsx redirect-if-unauthenticated gate,
// re-confirmed here per this codebase's established "each page still
// checks its own data access" convention — see my-application/page.tsx's
// identical shape), then loads the caller's OWN current QR state via
// getMyQrState (participant-qr.ts) — never a client-supplied
// application/user id. Renders the QR image server-side (qr-image.ts) so
// the raw canonical payload string never crosses into client-rendered
// DOM text.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getMyQrState } from '@/lib/attendance/participant-qr';
import { renderQrDataUri } from '@/lib/attendance/qr-image';
import MyQrClient from './my-qr-client';

export default async function MyQrPage() {
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
  const state = await getMyQrState({ userId: user.id, service });

  const t = await getTranslations({ locale, namespace: 'myQr' });

  // The QR image is rendered server-side ONLY when a payload actually
  // exists — never speculatively, never for any other state.
  const qrImageDataUri = state.kind === 'QR_AVAILABLE' ? await renderQrDataUri(state.qrPayload) : null;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6 md:p-10">
      <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      <MyQrClient initialState={state} initialQrImageDataUri={qrImageDataUri} />
    </div>
  );
}
