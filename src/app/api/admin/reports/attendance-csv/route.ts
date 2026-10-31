// src/app/api/admin/reports/attendance-csv/route.ts
//
// Streams a full attendance (QR scan) log CSV: one row per
// attendance_records entry, across every session. Each scan is tied to a
// specific session_id (there is no separate "general conference entry"
// table -- see attendance_records_entry_type_check in
// 20261006050000_walk_in_admission.sql, and admit_walk_in /
// scan_attempt_transactional, the only two writers of this table), so a
// participant's first scan of the day is typically their Registration &
// Arrival session row -- the Session column makes that explicit rather
// than assuming it.
//
// Mirrors participants-csv/route.ts's exact pattern: same auth/role gate,
// same RFC 4180 csvCell() escaping, same Content-Disposition download
// response shape. Role-gated identically (participants_communications_
// manager and super_admin; `staff` explicitly excluded, matching the
// 2026-10-25 staff narrowing this sibling route already documents).

import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!isStaffRole(profile?.role)) {
    return new NextResponse('Forbidden', { status: 403 });
  }
  if (profile?.role === 'staff') {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const service = createServiceRoleClient();
  const { data: rows, error } = await service
    .from('attendance_records')
    .select(`
      admitted_at,
      status,
      entry_type,
      applications!attendance_records_application_id_fkey (
        application_number,
        imported_email,
        participant_type,
        profiles!applications_applicant_id_fkey (
          full_name,
          email
        )
      ),
      sessions!attendance_records_session_id_fkey (
        session_code,
        title_en
      ),
      scanner:profiles!attendance_records_scanned_by_fkey (
        full_name
      )
    `)
    .order('admitted_at', { ascending: true });

  if (error) {
    console.error('attendance-csv: query failed', error);
    return new NextResponse('Query failed', { status: 500 });
  }

  // Excludes @test.local test fixtures, same filter as participants-csv's
  // sibling export -- a real attendance log must never mix in fake rows
  // left over from the live test-suite leak (docs/pre-launch-checklist.md).
  const realRows = (rows ?? []).filter((r) => {
    const application = Array.isArray(r.applications) ? r.applications[0] : r.applications;
    if (application?.imported_email?.toLowerCase().endsWith('@test.local')) return false;
    const applicantProfile = Array.isArray(application?.profiles) ? application.profiles[0] : application?.profiles;
    return !applicantProfile?.email?.toLowerCase().endsWith('@test.local');
  });

  const header = ['Attendee Code', 'Full Name', 'Email', 'Type', 'Session', 'Scanned At (Europe/Istanbul)', 'Entry Type', 'Status', 'Scanned By'];

  const csvLines = [
    header.join(','),
    ...realRows.map((r) => {
      const application = Array.isArray(r.applications) ? r.applications[0] : r.applications;
      const applicantProfile = Array.isArray(application?.profiles) ? application.profiles[0] : application?.profiles;
      const session = Array.isArray(r.sessions) ? r.sessions[0] : r.sessions;
      const scanner = Array.isArray(r.scanner) ? r.scanner[0] : r.scanner;
      const sessionLabel = session ? `${session.session_code} — ${session.title_en}` : '';
      // Europe/Istanbul wall-clock time, matching the agenda's own
      // timezone convention (src/lib/datetime/conference-time.ts) rather
      // than a raw UTC ISO string that would read 3 hours early here too.
      const scannedAt = r.admitted_at
        ? new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Istanbul',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
          }).format(new Date(r.admitted_at))
        : '';
      return [
        csvCell(application?.application_number ?? ''),
        csvCell(applicantProfile?.full_name ?? ''),
        csvCell(applicantProfile?.email ?? ''),
        csvCell(application?.participant_type ?? ''),
        csvCell(sessionLabel),
        csvCell(scannedAt),
        csvCell(r.entry_type ?? ''),
        csvCell(r.status ?? ''),
        csvCell(scanner?.full_name ?? ''),
      ].join(',');
    }),
  ];

  const csv = csvLines.join('\r\n');
  const filename = `coy21-attendance-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

function csvCell(value: string): string {
  // Neutralize formula injection: a leading =, +, -, or @ can trigger
  // formula execution when the CSV is opened in Excel/Sheets.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  // RFC 4180: wrap in double quotes and escape inner double quotes.
  return `"${safe.replace(/"/g, '""')}"`;
}
