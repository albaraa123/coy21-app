// src/app/[locale]/(participant)/(shell)/my-profile/page.tsx
//
// COY21 §12 — Extended Participant Profile.
// Emergency contacts + accommodation details.
// Only available to accepted participants.

import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmergencyContactsForm, AccommodationForm, IdentityForm } from './profile-forms';
import { isApplicationMinor } from '@/lib/participants/minor';
import { MountReveal } from '@/components/motion/mount-reveal';

export default async function MyProfilePage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const { data: application } = await supabase
    .from('applications')
    .select('id, status, age_group, birth_date, guardian_name, guardian_phone')
    .eq('applicant_id', user.id)
    .single();

  if (!application || application.status !== 'accepted') {
    redirect({ href: '/my-dashboard', locale });
    return;
  }

  const t = await getTranslations({ locale, namespace: 'participants.guardian' });

  const [{ data: contacts }, { data: accommodation }, { data: identity }] = await Promise.all([
    supabase
      .from('emergency_contacts')
      .select('id, name, relationship, phone, email')
      .eq('application_id', application.id)
      .order('created_at', { ascending: true }),
    supabase
      .from('application_accommodation')
      .select('hotel_name, location_note, room_number')
      .eq('application_id', application.id)
      .maybeSingle(),
    supabase
      .from('profiles')
      .select('full_name, email, phone, avatar_path')
      .eq('id', user.id)
      .single(),
  ]);

  // avatars bucket is private (20261025000100_avatars_bucket.sql) -- a
  // signed URL is required to actually display the uploaded photo. The
  // owner's own regular (RLS-respecting) client can sign their own file
  // directly -- avatars_all_own covers every storage.objects operation
  // for the caller's own folder, this isn't service-role-only.
  let avatarUrl: string | undefined;
  if (identity?.avatar_path) {
    const { data: signed } = await supabase.storage
      .from('avatars')
      .createSignedUrl(identity.avatar_path, 60 * 60);
    avatarUrl = signed?.signedUrl;
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 md:p-10">
      <div>
        <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">My Profile</h1>
        <p className="mt-1 text-sm text-charcoal/60 dark:text-gray-400">
          Emergency contacts and accommodation details.
        </p>
      </div>

      {/* Identity */}
      <MountReveal delayMs={0}>
        <Card className="flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold text-charcoal dark:text-gray-100">
              Identity
            </h2>
            <p className="mt-0.5 text-sm text-charcoal/60 dark:text-gray-400">
              Your name, contact details, and profile picture.
            </p>
          </div>
          <IdentityForm
            initial={identity ?? { full_name: '', email: user.email ?? '', phone: null, avatar_path: null }}
            initialAvatarUrl={avatarUrl}
          />
        </Card>
      </MountReveal>

      {/* Guardian / Companion (read-only, minors only) */}
      {isApplicationMinor(application) && (application.guardian_name || application.guardian_phone) && (
        <MountReveal delayMs={80}>
          <Card className="flex flex-col gap-2">
            <h2 className="text-base font-semibold text-charcoal dark:text-gray-100">{t('title')}</h2>
            {application.guardian_name && (
              <p className="text-sm">
                <span className="text-charcoal/60 dark:text-gray-400">{t('name')}: </span>
                {application.guardian_name}
              </p>
            )}
            {application.guardian_phone && (
              <p className="text-sm">
                <span className="text-charcoal/60 dark:text-gray-400">{t('phone')}: </span>
                {application.guardian_phone}
              </p>
            )}
          </Card>
        </MountReveal>
      )}

      {/* Emergency Contacts */}
      <MountReveal delayMs={160}>
        <Card className="flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold text-charcoal dark:text-gray-100">
              Emergency Contacts
            </h2>
            <p className="mt-0.5 text-sm text-charcoal/60 dark:text-gray-400">
              At least one contact is recommended. This information is only shared with the COY21 organising team.
            </p>
          </div>
          <EmergencyContactsForm
            applicationId={application.id}
            initial={(contacts ?? []).map((c) => ({
              id: c.id,
              name: c.name,
              relationship: c.relationship,
              phone: c.phone,
              email: c.email,
            }))}
          />
        </Card>
      </MountReveal>

      {/* Accommodation */}
      <MountReveal delayMs={240}>
        <Card className="flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold text-charcoal dark:text-gray-100">
              Accommodation
            </h2>
            <p className="mt-0.5 text-sm text-charcoal/60 dark:text-gray-400">
              Enter your hotel details so the logistics team can coordinate if needed.
            </p>
          </div>
          <AccommodationForm
            applicationId={application.id}
            initial={accommodation ?? null}
          />
        </Card>
      </MountReveal>

      <p className="text-xs text-charcoal/30 dark:text-gray-600">
        This information is stored securely and accessible only to authorised COY21 staff.
      </p>
    </div>
  );
}
