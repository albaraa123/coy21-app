import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmationCard } from './confirmation-card';
import { DocumentUpload } from './document-upload';

// Same mapping as the admin (admin)/applications/page.tsx's
// STATUS_BADGE_VARIANT — a given application status must read the same
// regardless of who's viewing it (admin or the participant themselves).
// Keep these two in sync if either changes.
const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  submitted: 'pending',
  under_review: 'pending',
  accepted: 'changed',
  waitlisted: 'mandatory',
  rejected: 'cancelled',
  withdrawn: 'neutral',
  draft: 'neutral',
};

// Documents provided to accepted participants. Flight ticket is the only
// one participants upload themselves; the rest are issued by the org team.
const PARTICIPANT_DOCUMENTS = [
  { key: 'invitation_letter',     label: 'Invitation Letter',     uploadable: false },
  { key: 'accommodation_letter',  label: 'Accommodation Letter',  uploadable: false },
  { key: 'flight_ticket',         label: 'Flight Ticket',         uploadable: true  },
  { key: 'visa_support_letter',   label: 'Visa Support Letter',   uploadable: false },
  { key: 'handbook',              label: 'COY21 Handbook 2026',   uploadable: false },
] as const;

export default async function MyApplicationPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const { data: application } = await supabase
    .from('applications')
    .select('*')
    .eq('applicant_id', user.id)
    .maybeSingle();

  if (!application || application.status === 'draft') {
    redirect({ href: '/register', locale });
    return;
  }

  const t = await getTranslations('status');

  // Applications created via Phase 5.1's import path (apply_import_row_transactional)
  // skip the participant-facing submission step entirely, so submitted_at is
  // never set for them — unlike self-registered applications, which always
  // have it populated at submission time. Rendering `{application.submitted_at}`
  // directly would render nothing after "Submitted: " for every imported
  // participant, an ungraceful/incomplete-looking gap. created_at is NOT NULL
  // on every application regardless of path and is a reasonable proxy for when
  // an imported row entered the system, so fall back to it rather than
  // rendering blank.
  const submittedDisplay = application.submitted_at ?? application.created_at;
  // No weekday here deliberately -- formatConferenceDate always includes one,
  // which would widen this specific display beyond its original
  // year/month/day-only format; this call only needed its timezone fixed
  // (Asia/Muscat -> Europe/Istanbul), not a format change.
  const formattedDate = new Date(submittedDisplay).toLocaleDateString(locale === 'ar' ? 'ar' : 'en-US', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const badgeVariant = STATUS_BADGE_VARIANT[application.status] ?? 'neutral';

  const tMyApplication = await getTranslations({ locale, namespace: 'myApplication' });

  const isAccepted = application.status === 'accepted';

  // attendance_confirmation is NOT NULL with default 'not_confirmed',
  // but the DB type is the enum — cast defensively for the client prop.
  const confirmationStatus = (application.attendance_confirmation ?? 'not_confirmed') as
    'confirmed' | 'not_confirmed' | 'declined';

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 md:p-10">
      <div>
        <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">{tMyApplication('title')}</h1>
      </div>

      {/* Application summary card */}
      <Card className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-charcoal/50 dark:text-gray-500 uppercase tracking-wide">Your Attendee Code</span>
            <span className="font-mono text-lg font-bold tracking-widest text-turquoise">
              {application.application_number ?? '—'}
            </span>
            {application.participant_type && (
              <span className="text-xs text-charcoal/60 dark:text-gray-400 capitalize">
                {application.participant_type.replace('_', ' ')}
              </span>
            )}
          </div>
          <span className="shrink-0 mt-1"><Badge variant={badgeVariant}>{t(application.status)}</Badge></span>
        </div>
        <p className="text-sm text-charcoal/70 dark:text-gray-400">
          {tMyApplication('submitted', { date: formattedDate })}
        </p>
        {!isAccepted && (
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{tMyApplication('reviewNotice')}</p>
        )}
      </Card>

      {/* Task 2: Attendance confirmation — only for accepted participants */}
      {isAccepted && (
        <ConfirmationCard initialStatus={confirmationStatus} />
      )}

      {/* Task 3: Documents — only shown to accepted participants */}
      {isAccepted && (
        <div className="flex flex-col gap-3">
          <h2 className="text-base font-semibold text-charcoal dark:text-gray-100">Your Documents</h2>
          <div className="flex flex-col gap-2">
            {PARTICIPANT_DOCUMENTS.map((doc) => (
              <Card key={doc.key} className="flex flex-row items-center gap-3 py-3">
                <div className="flex-1">
                  <p className="text-sm font-medium text-charcoal dark:text-gray-100">{doc.label}</p>
                  {doc.uploadable && (
                    <p className="mt-0.5 text-xs text-charcoal/50 dark:text-gray-500">Upload your ticket once booked</p>
                  )}
                </div>
                {doc.uploadable ? (
                  <DocumentUpload userId={user.id} docKey={doc.key} label={doc.label} />
                ) : (
                  <span className="rounded-md bg-charcoal/5 px-3 py-1.5 text-xs text-charcoal/40 dark:bg-white/5 dark:text-gray-500">
                    Issued by team
                  </span>
                )}
              </Card>
            ))}
          </div>
          <p className="text-xs text-charcoal/40 dark:text-gray-500">
            Documents issued by the team will appear here once ready.
          </p>
        </div>
      )}
    </div>
  );
}
