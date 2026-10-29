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
import { isLunchEligible, isCoffeeEligible } from '@/lib/cafeteria/eligibility';
import MyQrClient from './my-qr-client';
import { MountReveal } from '@/components/motion/mount-reveal';

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

  // getMyQrState and the two Cafeteria-QR-card reads below (profiles,
  // applications) have no dependency on each other, so they run
  // concurrently. The cafeteria_credentials lookup further down DOES
  // depend on `application`'s result (it needs to know whether to look
  // up by application_id or profile_id), so it stays sequential after
  // this resolves.
  const [state, { data: profile }, { data: application }] = await Promise.all([
    getMyQrState({ userId: user.id, service }),
    service.from('profiles').select('role').eq('id', user.id).maybeSingle(),
    service
      .from('applications')
      .select('id, participant_type, status, attendance_confirmation')
      .eq('applicant_id', user.id)
      .maybeSingle(),
  ]);

  const t = await getTranslations({ locale, namespace: 'myQr' });

  // The QR image is rendered server-side ONLY when a payload actually
  // exists — never speculatively, never for any other state.
  const qrImageDataUri = state.kind === 'QR_AVAILABLE' ? await renderQrDataUri(state.qrPayload) : null;

  // isLunchEligible — the single source of truth for lunch eligibility
  // per the design spec — is fed from its own independent lookup above,
  // never re-derived from the attendance state. getMyQrState's own
  // ParticipantQrState union deliberately doesn't expose raw
  // participant_type/status/attendance_confirmation/role fields (it's
  // scoped to the attendance-QR eligibility rule only).
  // isCoffeeEligible is a strict superset of isLunchEligible (adds only
  // the speaker case) -- widening the card's gate to this means nobody
  // currently shown the card loses visibility; it only ever gains one
  // more case (speakers, who are coffee-eligible but not lunch-eligible).
  const isCafeteriaEligible = isCoffeeEligible(application, profile);
  // Separately track lunch eligibility too, so the client component can
  // pick the right instruction copy (lunch-capable vs. coffee-only).
  const isLunchCapable = isLunchEligible(application, profile);

  // If eligible, also check for an existing cafeteria credential so a
  // returning visit can redisplay the stored QR image immediately,
  // without requiring another button click — mirrors how qrImageDataUri
  // above is already available on first load for the attendance QR.
  // Keyed by application_id when the caller has an application (a
  // participant), else by profile_id (staff) — matches the schema's
  // one-owner constraint and credential-issuance.ts's own lookup shape.
  let initialCafeteriaCredential: { qrImageDataUri: string } | null = null;
  if (isCafeteriaEligible) {
    const ownerFilter: { application_id: string } | { profile_id: string } = application
      ? { application_id: application.id }
      : { profile_id: user.id };
    const { data: existingCredential } =
      'application_id' in ownerFilter
        ? await service.from('cafeteria_credentials').select('qr_image_data_uri').eq('application_id', ownerFilter.application_id).maybeSingle()
        : await service.from('cafeteria_credentials').select('qr_image_data_uri').eq('profile_id', ownerFilter.profile_id).maybeSingle();
    if (existingCredential) {
      initialCafeteriaCredential = { qrImageDataUri: existingCredential.qr_image_data_uri };
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6 md:p-10">
      <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      <MountReveal delayMs={0}>
        <MyQrClient
          initialState={state}
          initialQrImageDataUri={qrImageDataUri}
          isCafeteriaEligible={isCafeteriaEligible}
          isLunchCapable={isLunchCapable}
          initialCafeteriaCredential={initialCafeteriaCredential}
        />
      </MountReveal>
    </div>
  );
}
