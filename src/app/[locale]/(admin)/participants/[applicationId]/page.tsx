// src/app/[locale]/(admin)/participants/[applicationId]/page.tsx
//
// NEW admin detail view for an imported participant's application. Distinct
// from the legacy (now flagged-off, Task 19) applications/[id] review page —
// that page's UI is built around a review workflow (status transitions,
// reviewer assignment) that does not apply to already-`accepted` imported
// rows. This page is read-only application data plus invitation controls.
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import InvitationControls from './invitation-controls';
import ClassificationControls from './classification-controls';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function ParticipantDetailPage({ params }: { params: Promise<{ applicationId: string }> }) {
  const locale = await getLocale();
  const { applicationId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !isStaffRole(profile.role)) {
    notFound();
  }
  // Sensitive-answer visibility (Task 20 investigation point 4): the
  // service-role client used throughout this page bypasses RLS entirely, so
  // this in-memory boolean is the ONLY thing enforcing the same
  // is_sensitive visibility split that application_answers_sensitive_staff_all
  // enforces at the DB level for RLS-bound queries (see
  // supabase/migrations/20260726105000_import_rls_policies.sql: sensitive
  // answers are `is_sensitive and current_user_role() = 'super_admin'`,
  // narrower than the plain `application_answers_staff_all` policy available
  // to any agenda staff role). Mirrored here exactly: only 'super_admin'
  // sees is_sensitive = true rows; every other staff role (currently just
  // 'agenda_allocation_manager') gets them filtered out before render.
  const canSeeSensitive = profile.role === 'super_admin';

  const { data: application } = await service
    .from('applications')
    .select(
      'id, applicant_id, imported_email, status, application_number, participant_type, phone, country, nationality, birth_date, age_group, city, organization, field_of_work, preferred_language, interests, climate_experience, experience_level, past_initiatives, participation_goals, topics_to_learn, content_type_pref, track_interests, priority_sessions, special_needs, submitted_at, created_at, import_batch_id'
    )
    .eq('id', applicationId)
    .maybeSingle();
  if (!application) notFound();

  const { data: answersRaw } = await service
    .from('application_answers')
    .select('id, question_key, question_label, normalized_value, raw_value, value_type, source, is_sensitive')
    .eq('application_id', applicationId)
    .order('question_key', { ascending: true });

  // Application-layer filter — the only enforcement point for this rule
  // given the service-role client. Never remove this without adding an
  // equivalent guard, since there is no RLS backstop on this code path.
  const answers = (answersRaw ?? []).filter((a) => canSeeSensitive || !a.is_sensitive);
  const hiddenSensitiveCount = (answersRaw ?? []).length - answers.length;

  const { data: invitation } = await service
    .from('participant_invitations')
    .select('status, sent_at, accepted_at, revoked_at, last_error, resend_count')
    .eq('application_id', applicationId)
    .maybeSingle();

  const { data: activeCredential } = await service
    .from('qr_credentials')
    .select('id')
    .eq('application_id', applicationId)
    .eq('status', 'active')
    .maybeSingle();

  const t = await getTranslations({ locale, namespace: 'participants.detail' });

  const fields: Array<[label: string, value: string]> = [
    [t('status'), application.status],
    [t('claimed'), application.applicant_id ? t('claimedYes') : t('claimedNo')],
    [t('applicationNumber'), application.application_number ?? '—'],
    [t('participantType'), application.participant_type ?? '—'],
    [t('importedEmail'), application.imported_email ?? ''],
    [t('phone'), application.phone ?? ''],
    [t('country'), application.country ?? ''],
    [t('nationality'), application.nationality ?? ''],
    [t('city'), application.city ?? ''],
    [t('organization'), application.organization ?? ''],
    [t('fieldOfWork'), application.field_of_work ?? ''],
    [t('ageGroup'), application.age_group ?? ''],
    [t('preferredLanguage'), application.preferred_language ?? ''],
    [t('interests'), (application.interests ?? []).join(', ')],
    [t('trackInterests'), (application.track_interests ?? []).join(', ')],
    [t('experienceLevel'), application.experience_level ?? ''],
    [t('submitted'), application.submitted_at ? new Date(application.submitted_at).toLocaleString(locale) : ''],
  ];

  return (
    <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
      <div>
        <h1 className="mb-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
        <Link href="/participants/accounts" className="text-sm font-medium text-turquoise hover:underline">
          {t('backLabel')}
        </Link>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('applicationTitle')}</h2>
        <Card className="p-0">
          <dl className="divide-y divide-charcoal/10 dark:divide-gray-700">
            {fields.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
                <dt className="shrink-0 text-xs font-medium text-charcoal/60 dark:text-gray-400 sm:w-48">{label}</dt>
                <dd className="text-sm text-charcoal dark:text-gray-100">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('answersTitle')}</h2>
        {hiddenSensitiveCount > 0 && (
          <p className="mb-2 text-xs text-charcoal/60 dark:text-gray-400">
            {t('hiddenSensitive', { count: hiddenSensitiveCount })}
          </p>
        )}
        {answers.length === 0 ? (
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('noAnswers')}</p>
        ) : (
          <>
            {/* Mobile: card-per-answer list. Desktop (md+): table. */}
            <div className="flex flex-col gap-2 md:hidden">
              {answers.map((a) => (
                <Card key={a.id}>
                  <p className="text-xs font-medium text-charcoal/60 dark:text-gray-400">{a.question_label ?? a.question_key}</p>
                  <p className="mt-1 text-sm text-charcoal dark:text-gray-100">{a.normalized_value ?? a.raw_value}</p>
                  <div className="mt-2 flex items-center gap-3 text-xs text-charcoal/60 dark:text-gray-400">
                    <span>{t('source')}: {a.source}</span>
                    <span>{t('sensitive')}: {a.is_sensitive ? t('sensitiveYes') : t('sensitiveNo')}</span>
                  </div>
                </Card>
              ))}
            </div>
            <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('question')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('value')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('source')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('sensitive')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                  {answers.map((a) => (
                    <tr key={a.id}>
                      <td className="px-4 py-2 text-charcoal dark:text-gray-100">{a.question_label ?? a.question_key}</td>
                      <td className="px-4 py-2 text-charcoal dark:text-gray-100">{a.normalized_value ?? a.raw_value}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{a.source}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{a.is_sensitive ? t('sensitiveYes') : t('sensitiveNo')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <InvitationControls applicationId={applicationId} invitation={invitation ?? null} applicantId={application.applicant_id} />

      <ClassificationControls
        applicationId={applicationId}
        currentParticipantType={application.participant_type}
        applicationStatus={application.status}
        hasActiveQrCredential={!!activeCredential}
      />
    </div>
  );
}
