import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { APPLICATION_STATUSES } from '@/lib/validation/admission-review';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import { isSelfRegistrationEnabled } from '@/lib/feature-flags';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';

const PAGE_SIZE = 50;

export default async function ApplicationsListPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; reviewer?: string; q?: string; country?: string }>;
}) {
  if (!isSelfRegistrationEnabled()) {
    notFound();
  }

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

  const params = await searchParams;
  const requestedPage = Math.max(1, Number(params.page) || 1);

  // Uses the service-role client (not the caller's session client) for both
  // queries below: profiles RLS (profiles_select_own / profiles_select_super_admin,
  // see supabase/migrations/20260721212035_rls_policies.sql) only lets a
  // registration_admission_manager read their own profile row, so the joined
  // profiles!applications_applicant_id_fkey(...) on other applicants' rows
  // would silently come back null under the session client even though the
  // role check above has already authorized this caller. Verified directly
  // against the live database. Authorization for this whole page is still
  // the role check above, matching actions.ts's requireStaffCaller pattern
  // of role-check-then-service-role-query.
  //
  // The `!inner` join hint is required (not just stylistic) for the `.or()`
  // referenced-table filter below to actually restrict which `applications`
  // rows come back. Verified directly against the live database: with a
  // plain (left) join, `.or('full_name.ilike...,email.ilike...', {
  // referencedTable: 'profiles' })` only nulls out the *embedded* profiles
  // object on non-matching rows — every application row still comes back
  // unfiltered. `!inner` turns it into a real join-level filter. Safe
  // unconditionally here since applicant_id is NOT NULL and every profile
  // row is created by the signup trigger, so no application can lack one.
  let countQuery = service
    .from('applications')
    .select('id, profiles!applications_applicant_id_fkey!inner()', { count: 'exact', head: true })
    .neq('status', 'draft');
  let dataQuery = service
    .from('applications')
    .select(
      'id, application_number, participant_type, status, submitted_at, country, applicant_id, assigned_reviewer_id, profiles!applications_applicant_id_fkey!inner(full_name, email), reviewer:profiles!applications_assigned_reviewer_id_fkey(full_name)'
    )
    .neq('status', 'draft')
    .order('submitted_at', { ascending: false })
    .order('id', { ascending: false });

  if (params.status && (APPLICATION_STATUSES as readonly string[]).includes(params.status)) {
    const status = params.status as (typeof APPLICATION_STATUSES)[number];
    countQuery = countQuery.eq('status', status);
    dataQuery = dataQuery.eq('status', status);
  }
  if (params.reviewer) {
    countQuery = countQuery.eq('assigned_reviewer_id', params.reviewer);
    dataQuery = dataQuery.eq('assigned_reviewer_id', params.reviewer);
  }
  if (params.country) {
    countQuery = countQuery.eq('country', params.country);
    dataQuery = dataQuery.eq('country', params.country);
  }
  // NOTE: postgrest-js's `.or()` cannot combine a referenced-table filter
  // (profiles.full_name / profiles.email) with a base-table filter
  // (applications.country) in a single call — see the `.or()` JSDoc in
  // @supabase/postgrest-js ("It's currently not possible to do an `.or()`
  // filter across multiple tables."). Free-text `q` therefore only searches
  // the joined applicant's name/email; searching by country uses the
  // separate `country` param above instead of being folded into `q`.
  if (params.q) {
    // `.or()` takes a raw PostgREST filter string with no escaping of its
    // own (unlike `.in()`, which auto-quotes reserved characters — see
    // PostgrestReservedCharsRegexp in @supabase/postgrest-js). Comma and
    // parens are the mini-grammar's actual delimiters (a period is fine —
    // the parser splits `column.operator.value` positionally, so emails
    // still match). An unescaped comma or paren in a search term would
    // either 400 or silently widen/mis-scope the filter, so strip them
    // before interpolating rather than rejecting the whole search — a
    // search term containing them wasn't a meaningful ilike pattern anyway.
    const sanitizedQ = params.q.replace(/[,()]/g, '');
    if (sanitizedQ) {
      const orFilter = `full_name.ilike.%${sanitizedQ}%,email.ilike.%${sanitizedQ}%`;
      countQuery = countQuery.or(orFilter, { referencedTable: 'profiles' });
      dataQuery = dataQuery.or(orFilter, { referencedTable: 'profiles' });
    }
  }

  // Count first (cheap, head:true) so `page` can be clamped to a range that
  // actually exists before `.range()` runs. Without this, PostgREST errors
  // with PGRST103 "Requested range not satisfiable" whenever the requested
  // page's offset is past the last row for the current filters (e.g. a
  // stale pagination link after a filter narrows the result set) -- verified
  // directly against the live database. That error left `count`/`data` both
  // null/undefined and silently rendered "Page N of 0" with no indication
  // anything had gone wrong.
  const { count } = await countQuery;
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data: applications } = await dataQuery.range(from, to);

  const t = await getTranslations({ locale, namespace: 'applications.list' });

  const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
    submitted: 'pending',
    under_review: 'pending',
    accepted: 'changed',
    waitlisted: 'mandatory',
    rejected: 'cancelled',
    withdrawn: 'neutral',
    draft: 'neutral',
  };

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      <p className="mb-4 text-sm text-charcoal/70 dark:text-gray-400 md:mb-6">{t('description')}</p>

      {!applications || applications.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <>
          {/* Mobile: card-per-application list. Desktop (md+): table.
              Both trees render the same `applications` data and must be kept
              in sync — any column/field added to one must be added to the
              other. */}
          <div className="flex flex-col gap-2 md:hidden">
            {applications.map((app) => (
              <Card key={app.id}>
                <Link href={`/applications/${app.id}`} className="font-mono text-sm font-medium text-turquoise hover:underline">
                  {app.application_number ?? t('viewApplication')}
                </Link>
                {app.participant_type && (
                  <span className="text-xs text-charcoal/50 dark:text-gray-500 capitalize">{app.participant_type.replace('_', ' ')}</span>
                )}
                <p className="mt-1 text-sm text-charcoal dark:text-gray-100">{app.profiles?.full_name}</p>
                <p className="text-xs text-charcoal/60 dark:text-gray-400">{app.profiles?.email}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-charcoal/60 dark:text-gray-400">
                  <Badge variant={STATUS_BADGE_VARIANT[app.status] ?? 'neutral'}>{app.status}</Badge>
                  <span>{app.country}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-charcoal/60 dark:text-gray-400">
                  <span>{t('reviewer')}: {app.reviewer?.full_name ?? t('unassigned')}</span>
                </div>
                {app.submitted_at && (
                  <p className="mt-1 text-xs text-charcoal/60 dark:text-gray-400">
                    {t('submitted')}: {new Date(app.submitted_at).toLocaleString(locale)}
                  </p>
                )}
              </Card>
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('applicationNumber')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">Type</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('name')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('email')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('country')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('reviewer')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('submitted')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                {applications.map((app) => (
                  <tr key={app.id}>
                    <td className="px-4 py-2">
                      <Link href={`/applications/${app.id}`} className="font-mono text-sm font-medium text-turquoise hover:underline">
                        {app.application_number ?? t('viewApplication')}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-xs text-charcoal/70 dark:text-gray-400 capitalize">
                      {app.participant_type?.replace('_', ' ') ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-charcoal dark:text-gray-100">{app.profiles?.full_name}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{app.profiles?.email}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{app.country}</td>
                    <td className="px-4 py-2">
                      <Badge variant={STATUS_BADGE_VARIANT[app.status] ?? 'neutral'}>{app.status}</Badge>
                    </td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{app.reviewer?.full_name ?? t('unassigned')}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                      {app.submitted_at ? new Date(app.submitted_at).toLocaleString(locale) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-charcoal/70 dark:text-gray-400">{t('pageOf', { page, totalPages })}</p>
        </>
      )}
    </div>
  );
}
