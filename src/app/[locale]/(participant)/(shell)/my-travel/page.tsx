import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { TravelForm } from './travel-form';

export default async function MyTravelPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const { data: application } = await supabase
    .from('applications')
    .select('id')
    .eq('applicant_id', user.id)
    .eq('status', 'accepted')
    .maybeSingle();

  if (!application) {
    redirect({ href: '/my-application', locale });
    return;
  }

  const { data: legs } = await supabase
    .from('travel_legs')
    .select('*')
    .eq('application_id', application.id)
    .order('departure_datetime', { nullsFirst: false });

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 md:p-10">
      <div>
        <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">My Travel</h1>
        <p className="mt-1 text-sm text-charcoal/60 dark:text-gray-400">
          Enter your flight details so the logistics team can plan airport reception.
        </p>
      </div>

      <TravelForm initialLegs={legs ?? []} />
    </div>
  );
}
