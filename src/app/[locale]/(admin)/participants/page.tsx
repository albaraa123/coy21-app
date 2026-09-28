import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';

// /participants has no content of its own — the actual participant list
// lives at /applications. Redirect transparently so any bookmarked link
// or nav click still lands somewhere useful.
export default async function ParticipantsOverviewPage() {
  const locale = await getLocale();
  redirect({ href: '/applications', locale });
}
