// src/app/[locale]/(admin)/allocation/runs/[id]/export/route.ts
//
// Downloads every assignment in one allocation run as a single CSV: one
// row per (participant, session) pairing, with the participant's name,
// the session, its room, and its time. Read-only — no writes, mirrors the
// same role gate as the run detail page (isAgendaStaffRole or
// isProgramAttendanceStaffRole) rather than introducing a new check.
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { toSafeCsv } from '@/lib/import/csv-export';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response('Not authenticated', { status: 401 });
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !isStaffRole(profile.role)) {
    return new Response('Not found', { status: 404 });
  }
  // 2026-10-25 staff narrowing: the allocation engine/export is out of
  // scope for `staff` (kept to walk-in admission + the attendance-
  // correction console only — see docs/superpowers/specs/2026-10-25-
  // profile-accommodation-staff-narrowing-design.md). isStaffRole above
  // still admits `staff` (it must, for super_admin sharing this check),
  // so this is an explicit additional rejection, not a change to
  // isStaffRole itself. 403, not this file's existing 404-for-
  // unauthorized convention, per the approved plan.
  if (profile.role === 'staff') {
    return new Response('Forbidden', { status: 403 });
  }

  const { data: run } = await service.from('allocation_runs').select('id').eq('id', id).maybeSingle();
  if (!run) {
    return new Response('Not found', { status: 404 });
  }

  const { data: assignments, error } = await service
    .from('allocation_assignments')
    .select(
      'application_id, status, suitability_score, is_low_confidence, applications(full_name, imported_email), sessions(session_code, title_en, title_ar, start_time, end_time, rooms(name_en))'
    )
    .eq('allocation_run_id', id)
    .order('application_id', { ascending: true });

  if (error) {
    return new Response('Failed to load assignments', { status: 500 });
  }

  const headers = ['Participant name', 'Email', 'Session code', 'Session title', 'Room', 'Start time', 'End time', 'Status', 'Suitability score', 'Low confidence'];
  const rows = (assignments ?? []).map((a) => [
    a.applications?.full_name ?? '',
    a.applications?.imported_email ?? '',
    a.sessions?.session_code ?? '',
    a.sessions?.title_en ?? '',
    a.sessions?.rooms?.name_en ?? '',
    a.sessions?.start_time ? new Date(a.sessions.start_time).toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }) : '',
    a.sessions?.end_time ? new Date(a.sessions.end_time).toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }) : '',
    a.status ?? '',
    a.suitability_score != null ? String(a.suitability_score) : '',
    a.is_low_confidence ? 'Yes' : 'No',
  ]);

  const csv = toSafeCsv(headers, rows);

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="allocation-run-${id}.csv"`,
    },
  });
}
