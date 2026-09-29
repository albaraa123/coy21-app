// src/app/api/admin/reports/participants-csv/route.ts
//
// Streams an accepted-participants CSV. Role-gated: only
// participants_communications_manager and super_admin may call this.
// Returns Content-Disposition: attachment so the browser saves it.

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

  const service = createServiceRoleClient();
  const { data: rows, error } = await service
    .from('applications')
    .select(`
      application_number,
      status,
      participant_type,
      created_at,
      profiles!applications_applicant_id_fkey (
        full_name,
        email
      )
    `)
    .eq('status', 'accepted')
    .order('application_number', { ascending: true });

  if (error) {
    console.error('participants-csv: query failed', error);
    return new NextResponse('Query failed', { status: 500 });
  }

  const header = ['Attendee Code', 'Full Name', 'Email', 'Type', 'Status', 'Created At'];

  const csvLines = [
    header.join(','),
    ...(rows ?? []).map((r) => {
      const profile = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
      return [
        csvCell(r.application_number ?? ''),
        csvCell(profile?.full_name ?? ''),
        csvCell(profile?.email ?? ''),
        csvCell(r.participant_type ?? ''),
        csvCell(r.status ?? ''),
        csvCell(r.created_at ? new Date(r.created_at).toISOString() : ''),
      ].join(',');
    }),
  ];

  const csv = csvLines.join('\r\n');
  const filename = `coy21-participants-${new Date().toISOString().slice(0, 10)}.csv`;

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
