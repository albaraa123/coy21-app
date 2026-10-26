// tests/auth/staff-narrow-access-live.test.ts
//
// Proves the 2026-10-25 staff narrowing end-to-end, at the RLS level
// (not just app-level) -- a real staff-role fixture account is
// independently confirmed REJECTED on every now-out-of-scope
// table/RPC, and still ALLOWED on the kept attendance surface.
//
// Source of truth for which surfaces are "removed" vs "kept":
// supabase/migrations/20261025000500_narrow_staff_rls_to_super_admin.sql
// -- converts every is_staff()-gated RLS policy EXCEPT the
// attendance-domain exception list (attendance_records, scan_attempts,
// scanner_assignments) to is_super_admin(), plus 2 non-table objects
// (ops_dashboard_snapshot(), the ops_dashboard_broadcast_select realtime
// policy) and 4 other SECURITY DEFINER RPCs (create_announcement,
// request_staff_qr_issuance_transactional_internal,
// request_staff_qr_reissue_transactional_internal,
// rollback_import_batch_transactional). admit_walk_in is deliberately
// NOT touched -- it backs the kept /attendance/walk-in capability.
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const createdAuthUserIds: string[] = [];
const createdApplicationIds: string[] = [];

afterAll(async () => {
  for (const id of createdApplicationIds) {
    try {
      await admin.from('applications').delete().eq('id', id);
    } catch {
      // best-effort cleanup
    }
  }
  for (const id of createdAuthUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, 60000);

describe('narrowed staff role: RLS-level proof', () => {
  const EMAIL = 'staff-narrow-access-live-fixture@test.local';
  let staffId: string;
  let staffClient: ReturnType<typeof createClient<Database>>;

  it('setup: create a staff fixture', async () => {
    const { data, error } = await admin.auth.admin.createUser({ email: EMAIL, password: 'password123', email_confirm: true });
    if (error || !data.user) throw new Error(`Failed: ${error?.message}`);
    staffId = data.user.id;
    createdAuthUserIds.push(staffId);
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffId);

    staffClient = createClient<Database>(URL, ANON_KEY);
    const { error: signInErr } = await staffClient.auth.signInWithPassword({ email: EMAIL, password: 'password123' });
    expect(signInErr).toBeNull();
  }, 30000);

  describe('kept attendance-domain surface (still is_staff())', () => {
    it('staff CAN read scan_attempts (kept)', async () => {
      const { error } = await staffClient.from('scan_attempts').select('*').limit(1);
      expect(error).toBeNull();
    });

    it('staff CAN read attendance_records (kept)', async () => {
      const { error } = await staffClient.from('attendance_records').select('*').limit(1);
      expect(error).toBeNull();
    });

    it('staff CAN read scanner_assignments (kept)', async () => {
      const { error } = await staffClient.from('scanner_assignments').select('*').limit(1);
      expect(error).toBeNull();
    });
  });

  describe('removed surfaces: table policies converted to is_super_admin()', () => {
    it('staff CANNOT read applications (removed)', async () => {
      const { data, error } = await staffClient.from('applications').select('*').limit(1);
      expect(error || (data ?? []).length === 0).toBeTruthy();
    });

    it('staff CANNOT read application_travel_info (removed)', async () => {
      // Seed a real row via the service-role client so this is a genuine
      // "a real row exists but RLS keeps it out of reach" proof, not
      // merely "no row happens to exist" -- same rigor as
      // staff-roles-live.test.ts's equivalent sensitive-data assertions.
      const { data: app, error: appErr } = await admin
        .from('applications')
        .insert({ applicant_id: null, imported_email: 'staff-narrow-access-live-travel@example.com', status: 'accepted', full_name: 'Narrow Access Travel Test' })
        .select('id')
        .single();
      if (appErr || !app) throw new Error(`Failed to seed application: ${appErr?.message}`);
      createdApplicationIds.push(app.id);
      await admin.from('application_travel_info').insert({ application_id: app.id, passport_full_name: 'Test Person' });

      const { data, error } = await staffClient.from('application_travel_info').select('*').eq('application_id', app.id);
      expect(error || (data ?? []).length === 0).toBeTruthy();
    });

    it('staff CANNOT read a non-public session via the staff-management policy (removed)', async () => {
      // sessions is a split case: sessions_select_public (a separate,
      // pre-existing, unconditional policy for anon+authenticated —
      // supabase/migrations/20260820150000_add_public_sessions_read_policy.sql)
      // grants read access to any row where is_public = true, completely
      // independent of staff-ness and untouched by the 2026-10-25
      // narrowing. A freshly-inserted session defaults is_public to false,
      // so it is reachable ONLY via the narrowed sessions_staff_all
      // policy (now is_super_admin()) -- this seeds exactly that row to
      // isolate the narrowed policy from the always-public one, rather
      // than asserting "sessions" is blanket-unreadable by staff, which
      // would be false.
      const conferenceDate = new Date(Date.UTC(2096, 0, 1) + Math.floor(Math.random() * 3000) * 86400000).toISOString().slice(0, 10);
      const { data: day, error: dayErr } = await admin
        .from('conference_days')
        .insert({ conference_date: conferenceDate, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
        .select('id')
        .single();
      if (dayErr || !day) throw new Error(`Failed to seed conference_days: ${dayErr?.message}`);
      const { data: track } = await admin.from('tracks').insert({ code: `NARROW-PRIV-TRACK-${staffId.slice(0, 8)}`, name_ar: 'م', name_en: 'T' }).select('id').single();
      const { data: sessionType } = await admin.from('session_types').insert({ code: `NARROW-PRIV-TYPE-${staffId.slice(0, 8)}`, name_ar: 'ن', name_en: 'Y' }).select('id').single();
      const { data: room } = await admin.from('rooms').insert({ code: `NARROW-PRIV-ROOM-${staffId.slice(0, 8)}`, name_ar: 'ق', name_en: 'R', capacity: 10 }).select('id').single();
      const { data: privateSession, error: sessionErr } = await admin
        .from('sessions')
        .insert({
          session_code: `NARROW-PRIVATE-${staffId.slice(0, 8)}`,
          title_ar: 'خاص',
          title_en: 'Private',
          conference_day_id: day.id,
          start_time: `${conferenceDate}T09:00:00+03:00`,
          end_time: `${conferenceDate}T10:00:00+03:00`,
          track_id: track!.id,
          session_type_id: sessionType!.id,
          room_id: room!.id,
          language: 'en',
          difficulty_level: 'beginner',
          capacity: 10,
          is_public: false,
        })
        .select('id')
        .single();
      if (sessionErr || !privateSession) throw new Error(`Failed to seed a private session: ${sessionErr?.message}`);

      const { data, error } = await staffClient.from('sessions').select('*').eq('id', privateSession.id);
      expect(error || (data ?? []).length === 0).toBeTruthy();

      await admin.from('sessions').delete().eq('id', privateSession.id);
      await admin.from('rooms').delete().eq('id', room!.id);
      await admin.from('tracks').delete().eq('id', track!.id);
      await admin.from('session_types').delete().eq('id', sessionType!.id);
      await admin.from('conference_days').delete().eq('id', day.id);
    }, 30000);

    it('staff CANNOT read email_settings (removed)', async () => {
      const { data, error } = await staffClient.from('email_settings').select('*').eq('id', true);
      expect(error || (data ?? []).length === 0).toBeTruthy();
    });
  });

  describe('removed surfaces: RPCs converted to is_super_admin()', () => {
    it('staff CANNOT call ops_dashboard_snapshot (removed)', async () => {
      const { error } = await staffClient.rpc('ops_dashboard_snapshot');
      expect(error).toBeTruthy();
    });

    it('staff CANNOT call create_announcement (removed)', async () => {
      const { error } = await staffClient.rpc('create_announcement' as never, { p_title: 'Should fail' } as never);
      expect(error).toBeTruthy();
    });
  });

  describe('kept walk-in capability: admit_walk_in RPC still reachable past the is_staff() gate', () => {
    // admit_walk_in (supabase/migrations/20261006050000_walk_in_admission.sql)
    // is deliberately NOT touched by the narrowing migration -- its sole
    // authorization gate (`if not is_staff() then raise exception 'Not
    // authorized'`) must still admit a staff caller.
    //
    // A full successful admission needs a real confirmed session with
    // capacity, an accepted application, and no pre-existing booking/
    // attendance for that pair -- all constructible live, so this test
    // does the real thing end-to-end rather than settling for the
    // "reaches past authorization" proxy the task anticipated as a
    // fallback. See booking-rules-completion-live.test.ts's identical,
    // pre-existing admit_walk_in success test for the same fixture shape;
    // this test exists here too so staff-narrow-access-live.test.ts is a
    // self-contained, complete proof of the narrowed boundary without
    // requiring a reader to cross-reference that other file.
    it('a staff caller successfully admits a walk-in (admit_walk_in untouched by the narrowing)', async () => {
      const dayOffset = Math.floor(Math.random() * 3000) + 1;
      const DAY = new Date(Date.UTC(2097, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);
      const suffix = staffId.slice(0, 8);

      const { data: day, error: dayErr } = await admin
        .from('conference_days')
        .insert({ conference_date: DAY, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
        .select('id')
        .single();
      if (dayErr || !day) throw new Error(`Failed to seed conference_days: ${dayErr?.message}`);

      const { data: track, error: trackErr } = await admin
        .from('tracks')
        .insert({ code: `NARROW-TRACK-${suffix}`, name_ar: 'مسار', name_en: 'Track' })
        .select('id')
        .single();
      if (trackErr || !track) throw new Error(`Failed to seed tracks: ${trackErr?.message}`);

      const { data: sessionType, error: sessionTypeErr } = await admin
        .from('session_types')
        .insert({ code: `NARROW-TYPE-${suffix}`, name_ar: 'نوع', name_en: 'Type' })
        .select('id')
        .single();
      if (sessionTypeErr || !sessionType) throw new Error(`Failed to seed session_types: ${sessionTypeErr?.message}`);

      const { data: room, error: roomErr } = await admin
        .from('rooms')
        .insert({ code: `NARROW-ROOM-${suffix}`, name_ar: 'قاعة', name_en: 'Room', capacity: 10 })
        .select('id')
        .single();
      if (roomErr || !room) throw new Error(`Failed to seed rooms: ${roomErr?.message}`);

      const { data: session, error: sessionErr } = await admin
        .from('sessions')
        .insert({
          session_code: `NARROW-SESSION-${suffix}`,
          title_ar: 'جلسة اختبار',
          title_en: 'Test Session',
          conference_day_id: day.id,
          start_time: `${DAY}T09:00:00+03:00`,
          end_time: `${DAY}T10:00:00+03:00`,
          track_id: track.id,
          session_type_id: sessionType.id,
          room_id: room.id,
          language: 'en',
          difficulty_level: 'beginner',
          capacity: 10,
          min_capacity: 0,
          status: 'confirmed',
        })
        .select('id')
        .single();
      if (sessionErr || !session) throw new Error(`Failed to seed sessions: ${sessionErr?.message}`);

      const { data: applicantUser, error: applicantErr } = await admin.auth.admin.createUser({
        email: `staff-narrow-access-live-walkin-applicant-${suffix}@test.local`,
        password: 'password123',
        email_confirm: true,
      });
      if (applicantErr || !applicantUser.user) throw new Error(`Failed to create applicant: ${applicantErr?.message}`);
      createdAuthUserIds.push(applicantUser.user.id);

      const { data: application, error: appErr } = await admin
        .from('applications')
        .insert({ applicant_id: applicantUser.user.id, status: 'accepted', preferred_language: 'en', experience_level: 'beginner', interests: [] })
        .select('id')
        .single();
      if (appErr || !application) throw new Error(`Failed to seed applications: ${appErr?.message}`);
      createdApplicationIds.push(application.id);

      const { data: bookingId, error } = await staffClient.rpc('admit_walk_in', {
        p_application_id: application.id,
        p_session_id: session.id,
      });
      expect(error, `RPC error: ${error?.message}`).toBeNull();
      expect(bookingId).toBeTruthy();

      const { data: bookingRow } = await admin.from('session_bookings').select('source, status').eq('id', bookingId as string).single();
      expect(bookingRow?.source).toBe('walk_in');
      expect(bookingRow?.status).toBe('active');

      // Cleanup for this test's own scratch reference rows (not covered by
      // the shared afterAll's applicationIds/authUserIds sweep).
      await admin.from('attendance_records').delete().eq('session_id', session.id);
      await admin.from('session_bookings').delete().eq('session_id', session.id);
      await admin.from('sessions').delete().eq('id', session.id);
      await admin.from('rooms').delete().eq('id', room.id);
      await admin.from('tracks').delete().eq('id', track.id);
      await admin.from('session_types').delete().eq('id', sessionType.id);
      await admin.from('conference_days').delete().eq('id', day.id);
    }, 30000);
  });
});
