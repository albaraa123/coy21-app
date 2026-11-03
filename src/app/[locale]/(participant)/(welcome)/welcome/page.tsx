// src/app/[locale]/(participant)/(bare)/welcome/page.tsx
//
// Reached via (participant)/(shell)/layout.tsx's server-side redirect
// (has_completed_onboarding = false) -- same gate shape as
// change-password/page.tsx's must_change_password redirect. Minimal
// auth check here ("is someone signed in"), same reasoning as that file's
// own header comment: the real gate already lives in the shell layout,
// this page only needs to not render for a fully signed-out visitor who
// somehow navigates here directly.
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { WelcomeWalkthrough } from './walkthrough-client';

export default async function WelcomePage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  return <WelcomeWalkthrough />;
}
