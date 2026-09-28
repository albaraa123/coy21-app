// tests/attendance/scanner-assignment-context-live.test.ts
//
// Live coverage for loadScannerAssignmentContext
// (src/lib/attendance/scanner-assignment-context.ts) — the trusted,
// server-only data source behind Phase 7B's /scanner page. Proves the
// page's displayed session/room context comes from real
// scanner_assignments/sessions/rooms rows, not client state, and that
// the three non-ready branches (no_assignment, session_unavailable,
// ready) are each reachable from real fixture data.
//
// Fixture pattern follows tests/attendance/scan-attempt-live.test.ts.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { loadScannerAssignmentContext } from '@/lib/attendance/scanner-assignment-context';
import { isScannerDeviceRole } from '@/lib/validation/scanner-device';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string;

const scannerIds: string[] = [];
const sessionIds: string[] = [];
const roomIds: string[] = [];
const conferenceDayIds: string[] = [];
const scannerAssignmentIds: string[] = [];
let roomCounter = 0;

// Randomized suffix for every fixed-literal identifier this file inserts
// (conference_date, tracks.code, session_types.code, rooms.code) — a fixed
// literal collides with a leftover row from any earlier run whose own
// afterAll cleanup didn't complete (interrupted process, crashed assertion
// before cleanup ran), same FIXTURE COLLISION hazard scan-attempt-live.test.ts's
// own runId comment documents. This file's header claims to follow that
// file's fixture pattern but omitted this specific piece; added to close
// the gap (confirmed reproducible: a prior interrupted run left a
// conference_days row at the old hardcoded '2026-09-24' date that broke
// every subsequent run's beforeAll until manually cleaned up).
const runId = randomUUID().slice(0, 8);

async function createScanner() {
  const { data: user } = await admin.auth.admin.createUser({ email: `scanner-ctx-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
  const id = user!.user!.id;
  scannerIds.push(id);
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', id);
  return id;
}

async function createRoom() {
  roomCounter += 1;
  const { data, error } = await admin
    .from('rooms')
    .insert({ code: `SCANNER-CTX-ROOM-${runId}-${roomCounter}`, name_ar: 'قاعة', name_en: `Room ${roomCounter}`, capacity: 100 })
    .select('id')
    .single();
  if (error || !data) throw new Error(`room: ${error?.message}`);
  roomIds.push(data.id);
  return data.id;
}

async function createSession(overrides: Partial<Database['public']['Tables']['sessions']['Insert']> & { session_code: string }) {
  const roomForSession = overrides.room_id ?? (await createRoom());
  const { data, error } = await admin
    .from('sessions')
    .insert({
      title_ar: 'جلسة',
      title_en: 'Session',
      conference_day_id: conferenceDayId,
      start_time: `${conferenceDate}T09:00:00Z`,
      end_time: `${conferenceDate}T10:00:00Z`,
      track_id: trackId,
      session_type_id: sessionTypeId,
      language: 'bilingual',
      difficulty_level: 'all_levels',
      capacity: 10,
      is_mandatory: false,
      status: 'confirmed',
      admission_policy: 'open',
      ...overrides,
      room_id: roomForSession,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`session: ${error?.message}`);
  sessionIds.push(data.id);
  return data.id;
}

async function assign(scannerId: string, opts: { sessionId?: string; roomId?: string }) {
  const { data, error } = await admin
    .from('scanner_assignments')
    .insert({ scanner_user_id: scannerId, session_id: opts.sessionId ?? null, room_id: opts.roomId ?? null, assigned_by: scannerId, is_active: true })
    .select('id')
    .single();
  if (error || !data) throw new Error(`assignment: ${error?.message}`);
  scannerAssignmentIds.push(data.id);
  return data.id;
}

afterAll(async () => {
  if (sessionIds.length > 0) await admin.from('sessions').delete().in('id', sessionIds);
  if (scannerAssignmentIds.length > 0) await admin.from('scanner_assignments').delete().in('id', scannerAssignmentIds);
  if (trackId) await admin.from('tracks').delete().eq('id', trackId);
  if (sessionTypeId) await admin.from('session_types').delete().eq('id', sessionTypeId);
  if (roomIds.length > 0) await admin.from('rooms').delete().in('id', roomIds);
  if (conferenceDayIds.length > 0) await admin.from('conference_days').delete().in('id', conferenceDayIds);
});

// Far-future date, offset by a random number of days per run — same
// collision-proofing rationale as runId above, applied to the one fixture
// value that can't take a text suffix (conference_days.conference_date is
// a date column, uniquely constrained).
const conferenceDate = new Date(Date.UTC(2099, 0, 1) + (Math.floor(Math.random() * 3000) + 1) * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  const { data: day } = await admin
    .from('conference_days')
    .insert({ conference_date: conferenceDate, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  conferenceDayId = day!.id;
  conferenceDayIds.push(conferenceDayId);

  const { data: track } = await admin.from('tracks').insert({ code: `SCANNER-CTX-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: `SCANNER-CTX-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;
});

describe('loadScannerAssignmentContext', () => {
  it('a scanner with no scanner_assignments row returns no_assignment', async () => {
    const scannerId = await createScanner();
    const result = await loadScannerAssignmentContext(admin, scannerId);
    expect(result.kind).toBe('no_assignment');
  });

  it('a scanner with a session-scoped assignment to a confirmed session returns ready with correct session/room details', async () => {
    const scannerId = await createScanner();
    const sessionId = await createSession({ session_code: `ctx-ready-1-${runId}` });
    await assign(scannerId, { sessionId });

    const result = await loadScannerAssignmentContext(admin, scannerId);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe(sessionId);
    expect(result.sessions[0].titleEn).toBe('Session');
    expect(result.sessions[0].roomCode).toMatch(/^SCANNER-CTX-ROOM-/);
  });

  it('a scanner assigned only to a non-confirmed (draft) session returns session_unavailable, not no_assignment', async () => {
    const scannerId = await createScanner();
    const sessionId = await createSession({ session_code: `ctx-draft-1-${runId}`, status: 'draft' });
    await assign(scannerId, { sessionId });

    const result = await loadScannerAssignmentContext(admin, scannerId);
    expect(result.kind).toBe('session_unavailable');
  });

  it('a room-scoped assignment expands to every confirmed session in that room', async () => {
    const scannerId = await createScanner();
    const roomId = await createRoom();
    const sessionA = await createSession({ session_code: `ctx-room-a-${runId}`, room_id: roomId, start_time: `${conferenceDate}T09:00:00Z`, end_time: `${conferenceDate}T10:00:00Z` });
    const sessionB = await createSession({ session_code: `ctx-room-b-${runId}`, room_id: roomId, start_time: `${conferenceDate}T11:00:00Z`, end_time: `${conferenceDate}T12:00:00Z` });
    await assign(scannerId, { roomId });

    const result = await loadScannerAssignmentContext(admin, scannerId);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    const ids = result.sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual([sessionA, sessionB].sort());
  });

  it('a deactivated (is_active=false) assignment does not count — behaves like no_assignment', async () => {
    const scannerId = await createScanner();
    const sessionId = await createSession({ session_code: `ctx-inactive-1-${runId}` });
    const assignmentId = await assign(scannerId, { sessionId });
    await admin.from('scanner_assignments').update({ is_active: false }).eq('id', assignmentId);

    const result = await loadScannerAssignmentContext(admin, scannerId);
    expect(result.kind).toBe('no_assignment');
  });

  it('a scanner_device role is recognized by isScannerDeviceRole (the same check the page uses to gate access)', async () => {
    const scannerId = await createScanner();
    const { data: profile } = await admin.from('profiles').select('role').eq('id', scannerId).single();
    expect(isScannerDeviceRole(profile!.role)).toBe(true);
  });
});
