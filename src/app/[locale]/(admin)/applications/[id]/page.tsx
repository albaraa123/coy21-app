import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { VALID_TRANSITIONS, type ApplicationStatus } from '@/lib/validation/admission-review';
import { STAFF_ROLES, isStaffRole } from '@/lib/auth/is-staff-role';
import { isSelfRegistrationEnabled } from '@/lib/feature-flags';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import ReviewControls from './review-controls';

const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  submitted: 'pending',
  under_review: 'pending',
  accepted: 'changed',
  waitlisted: 'mandatory',
  rejected: 'cancelled',
  withdrawn: 'neutral',
  draft: 'neutral',
};

export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isSelfRegistrationEnabled()) {
    notFound();
  }

  const locale = await getLocale();
  const { id } = await params;
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

  // Uses the service-role client (not the caller's session client) for all
  // three queries below, same as page.tsx's list page and for the same
  // reason: profiles RLS (profiles_select_own / profiles_select_super_admin,
  // see supabase/migrations/20260721212035_rls_policies.sql) only lets a
  // registration_admission_manager read their own profile row. That affects
  // every join/select here that touches another user's profiles row: the
  // applicant's joined profile on `applications`, the note authors' joined
  // profiles on `application_notes`, and the `reviewers` list itself (which
  // selects other staff members' profiles rows directly, not just via a
  // join). Under the session client all three would silently come back
  // null/empty for a registration_admission_manager caller even though the
  // role check above has already authorized them — verified directly
  // against the live database. Authorization for this page is the role
  // check above, matching actions.ts's requireStaffCaller pattern of
  // role-check-then-service-role-query.
  const { data: application } = await service
    .from('applications')
    .select('*, profiles!applications_applicant_id_fkey(full_name, email)')
    .eq('id', id)
    // spec non-goal: draft applications never appear in this dashboard,
    // including via direct navigation to a draft's id — the list page already
    // excludes drafts, but RLS alone doesn't (applications_select_staff grants
    // staff read access to all applications regardless of status), so the
    // query itself must exclude it too.
    .neq('status', 'draft')
    .single();
  if (!application) notFound();

  const { data: notes } = await service
    .from('application_notes')
    .select('*, profiles!application_notes_author_id_fkey(full_name)')
    .eq('application_id', id)
    .order('created_at', { ascending: false });

  const { data: reviewers } = await service
    .from('profiles')
    .select('id, full_name')
    .in('role', [...STAFF_ROLES]);

  const validNextStatuses = VALID_TRANSITIONS[application.status as ApplicationStatus] ?? [];

  const t = await getTranslations({ locale, namespace: 'applications.detail' });

  const personalFields: Array<[label: string, value: string]> = [
    [t('phone'), application.phone ?? ''],
    [t('country'), application.country ?? ''],
    [t('nationality'), application.nationality ?? ''],
    [t('birthDate'), application.birth_date ?? ''],
    [t('ageGroup'), application.age_group ?? ''],
    [t('city'), application.city ?? ''],
    [t('organization'), application.organization ?? ''],
    [t('fieldOfWork'), application.field_of_work ?? ''],
    [t('preferredLanguage'), application.preferred_language ?? ''],
  ];

  const conferenceFields: Array<[label: string, value: string]> = [
    [t('interests'), (application.interests ?? []).join(', ')],
    [t('climateExperience'), application.climate_experience ?? ''],
    [t('experienceLevel'), application.experience_level ?? ''],
    [t('pastInitiatives'), application.past_initiatives ?? ''],
    [t('participationGoals'), application.participation_goals ?? ''],
    [t('topicsToLearn'), application.topics_to_learn ?? ''],
    [t('contentTypePref'), application.content_type_pref ?? ''],
    [t('trackInterests'), (application.track_interests ?? []).join(', ')],
    [t('prioritySessions'), application.priority_sessions ?? ''],
    [t('specialNeeds'), application.special_needs ?? ''],
  ];

  const submissionFields: Array<[label: string, value: string]> = [
    [t('submittedAt'), application.submitted_at ? new Date(application.submitted_at).toLocaleString(locale) : ''],
    [t('createdAt'), application.created_at ? new Date(application.created_at).toLocaleString(locale) : ''],
    [t('updatedAt'), application.updated_at ? new Date(application.updated_at).toLocaleString(locale) : ''],
  ];

  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
      <div>
        <Link href="/applications" className="text-sm font-medium text-turquoise hover:underline">
          {t('backLabel')}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{application.application_number}</h1>
          <Badge variant={STATUS_BADGE_VARIANT[application.status] ?? 'neutral'}>{application.status}</Badge>
        </div>
        {/* Read-only: attendance_confirmation is edited exclusively from
            /participants/funding ("Participant Status") by program_
            attendance_manager/travel_operations_staff/super_admin — this
            page (registration_admission_manager/super_admin) shows it for
            situational awareness only, no edit control, per explicit user
            decision not to widen this page's write surface. */}
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
          {t('attendanceConfirmation')}: {t(`attendanceConfirmationValues.${application.attendance_confirmation}`)}
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('applicantTitle')}</h2>
        <Card className="p-0">
          <dl className="divide-y divide-charcoal/10 dark:divide-gray-700">
            {[
              [t('name'), application.profiles?.full_name ?? ''],
              [t('email'), application.profiles?.email ?? ''],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
                <dt className="shrink-0 text-xs font-medium text-charcoal/60 dark:text-gray-400 sm:w-48">{label}</dt>
                <dd className="text-sm text-charcoal dark:text-gray-100">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('personalTitle')}</h2>
        <Card className="p-0">
          <dl className="divide-y divide-charcoal/10 dark:divide-gray-700">
            {personalFields.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
                <dt className="shrink-0 text-xs font-medium text-charcoal/60 dark:text-gray-400 sm:w-48">{label}</dt>
                <dd className="text-sm text-charcoal dark:text-gray-100">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('conferenceTitle')}</h2>
        <Card className="p-0">
          <dl className="divide-y divide-charcoal/10 dark:divide-gray-700">
            {conferenceFields.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
                <dt className="shrink-0 text-xs font-medium text-charcoal/60 dark:text-gray-400 sm:w-48">{label}</dt>
                <dd className="text-sm text-charcoal dark:text-gray-100">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('submissionTitle')}</h2>
        <Card className="p-0">
          <dl className="divide-y divide-charcoal/10 dark:divide-gray-700">
            {submissionFields.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
                <dt className="shrink-0 text-xs font-medium text-charcoal/60 dark:text-gray-400 sm:w-48">{label}</dt>
                <dd className="text-sm text-charcoal dark:text-gray-100">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>

      <ReviewControls
        applicationId={application.id}
        currentStatus={application.status}
        validNextStatuses={validNextStatuses}
        assignedReviewerId={application.assigned_reviewer_id}
        reviewers={reviewers ?? []}
        notes={notes ?? []}
        locale={locale}
      />
    </div>
  );
}
