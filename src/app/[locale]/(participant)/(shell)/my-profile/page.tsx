// src/app/[locale]/(participant)/(shell)/my-profile/page.tsx
//
// COY21 §12 — Extended Participant Profile.
// Emergency contacts + accommodation details.
// Only available to accepted participants.

import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmergencyContactsForm, AccommodationForm } from './profile-forms';

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
    .select('id, status')
    .eq('applicant_id', user.id)
    .single();

  if (!application || application.status !== 'accepted') {
    redirect({ href: '/my-dashboard', locale });
    return;
  }

  const [{ data: contacts }, { data: accommodation }] = await Promise.all([
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
  ]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 md:p-10">
      <div>
        <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">My Profile</h1>
        <p className="mt-1 text-sm text-charcoal/60 dark:text-gray-400">
          Emergency contacts and accommodation details.
        </p>
      </div>

      {/* Emergency Contacts */}
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

      {/* Accommodation */}
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

      <p className="text-xs text-charcoal/30 dark:text-gray-600">
        This information is stored securely and accessible only to authorised COY21 staff.
      </p>
    </div>
  );
}
