// src/app/[locale]/(admin)/agenda/sessions/[id]/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole, SESSION_VALID_TRANSITIONS, type SessionStatus } from '@/lib/validation/agenda';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import { Badge } from '@/components/ui/badge';
import SessionControls from './session-controls';

const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  draft: 'neutral',
  published: 'pending',
  confirmed: 'changed',
  cancelled: 'cancelled',
  completed: 'elective',
};

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
  if (!profile || !(isAgendaStaffRole(profile.role) || isProgramAttendanceStaffRole(profile.role))) {
    notFound();
  }

  // Session client is sufficient for every query on this page. `sessions_staff_all`,
  // `session_people_staff_all`, and `session_tags_staff_all`
  // (supabase/migrations/20260723040000_sessions_rls_policies.sql), and the
  // reference-table policies (`conference_days_staff_all`, `tracks_staff_all`,
  // `session_types_staff_all`, `rooms_staff_all`, `people_staff_all`,
  // `tags_staff_all` — supabase/migrations/20260722201600_agenda_reference_rls_policies.sql)
  // are all plain `current_user_role() in (...)` checks with no per-row owner
  // condition, unlike Phase 2's `profiles_select_own`. Critically, the
  // `session_people` -> `people` join used below never touches `profiles`
  // (unlike Task 15's people page, which separately joins `profiles` for its
  // "linked platform account" picker and genuinely needs the service-role
  // client for that one query) — so there's no other-users'-row problem for
  // the caller's own session client to hit anywhere on this page, same
  // reasoning already verified live for Task 16's sessions list page. The
  // service-role client above is still needed, but only for the role-gate's
  // `profiles` lookup.
  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', id)
    .single();
  if (!session) notFound();

  const [
    { data: sessionPeople },
    { data: sessionTags },
    { data: days },
    { data: tracks },
    { data: sessionTypes },
    { data: rooms },
    { data: people },
    { data: tags },
  ] = await Promise.all([
    supabase
      .from('session_people')
      .select('id, person_id, role, display_order, is_primary, people(id, full_name_ar, full_name_en)')
      .eq('session_id', id)
      .order('display_order', { ascending: true }),
    supabase
      .from('session_tags')
      .select('id, tag_id, weight, tags(id, name_ar, name_en)')
      .eq('session_id', id),
    supabase.from('conference_days').select('id, label_en').order('display_order', { ascending: true }),
    supabase.from('tracks').select('id, name_en').order('name_en', { ascending: true }),
    supabase.from('session_types').select('id, name_en').order('name_en', { ascending: true }),
    supabase.from('rooms').select('id, name_en, capacity').order('name_en', { ascending: true }),
    supabase.from('people').select('id, full_name_en').eq('is_active', true).order('full_name_en', { ascending: true }),
    supabase.from('tags').select('id, name_en').eq('is_active', true).order('name_en', { ascending: true }),
  ]);

  const validNextStatuses = SESSION_VALID_TRANSITIONS[session.status as SessionStatus] ?? [];

  const t = await getTranslations({ locale, namespace: 'agenda.sessions' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-2 text-lg font-semibold text-charcoal dark:text-gray-100">
        {session.session_code} — {session.title_en}
      </h1>
      <div className="mb-4 flex items-center gap-2 md:mb-6">
        <span className="text-sm text-charcoal/70 dark:text-gray-400">{t('detail.statusLabel')}:</span>
        <Badge variant={STATUS_BADGE_VARIANT[session.status] ?? 'neutral'}>
          {t(`statusValues.${session.status}`)}
        </Badge>
      </div>

      <SessionControls
        session={session}
        sessionPeople={sessionPeople ?? []}
        sessionTags={sessionTags ?? []}
        validNextStatuses={validNextStatuses}
        days={days ?? []}
        tracks={tracks ?? []}
        sessionTypes={sessionTypes ?? []}
        rooms={rooms ?? []}
        people={people ?? []}
        tags={tags ?? []}
      />
    </div>
  );
}
