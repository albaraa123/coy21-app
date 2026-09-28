// tests/attendance/participant-qr-live.test.ts
//
// Live coverage for the Participant QR Experience
// (src/lib/attendance/participant-qr.ts, getMyQrState). Proves:
//   - eligibility (accepted-only) is respected reading state, matching
//     the same rule already enforced at the issuance/reissue RPC layer
//     and the live scan-time re-check (both pre-existing, unmodified);
//   - ownership is derived from the caller's own userId, never a
//     client-supplied application/user id;
//   - the displayed QR is a byte-exact reconstruction of the current
//     active credential (crypto round-trip: parseCanonicalQrPayload +
//     hashQrToken over the RECONSTRUCTED payload equals the stored
//     token_hash);
//   - that reconstructed QR actually scans successfully through the
//     existing, unmodified Phase 7 scan_qr_attempt_transactional path;
//   - no token_hash/ciphertext/key material ever appears in the
//     returned state;
//   - a revoked/replaced credential is never returned as usable.
//
// Fixture pattern follows tests/attendance/scan-qr-attempt-live.test.ts
// and tests/attendance/qr-credential-eligibility-revocation-live.test.ts.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { getMyQrState } from '@/lib/attendance/participant-qr';
import { issueMyQrCredential, reissueMyQrCredential } from '@/lib/attendance/qr-credential-issuance';
import { parseCanonicalQrPayload, hashQrToken } from '@/lib/attendance/qr-token-crypto';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import { isScannerDeviceRole } from '@/lib/validation/scanner-device';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const otherUserIds: string[] = [];

type ApplicationStatus = Database['public']['Tables']['applications']['Row']['status'];

async function createApplicant(label: string, status: ApplicationStatus) {
  const email = `pqr-${label}-${randomUUID()}@test.local`;
  const { data: user, error: userError } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  if (userError || !user?.user) throw new Error(`createUser failed: ${userError?.message}`);
  applicantUserIds.push(user.user.id);

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: user.user.id, status, full_name: `PQR ${label}`, country: 'Oman', nationality: 'Omani' })
    .select('id')
    .single();
  if (appError || !app) throw new Error(`application insert failed: ${appError?.message}`);
  applicationIds.push(app.id);

  const client = createClient<Database>(URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: 'password123' });
  if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);

  return { userId: user.user.id, applicationId: app.id, client };
}

afterAll(async () => {
  if (applicationIds.length > 0) {
    await admin.from('qr_credentials').delete().in('application_id', applicationIds);
    await admin.from('applications').delete().in('id', applicationIds);
  }
  await Promise.allSettled([...applicantUserIds, ...otherUserIds].map((id) => admin.auth.admin.deleteUser(id)));
});

describe('eligibility: only accepted may view/hold an operational QR', () => {
  it.each(['draft', 'submitted', 'under_review', 'waitlisted'] as const)('%s -> NOT_YET_AVAILABLE, never QR_AVAILABLE', async (status) => {
    const fx = await createApplicant(`elig-${status}`, status);
    const state = await getMyQrState({ userId: fx.userId, service: admin });
    expect(state.kind).toBe('NOT_YET_AVAILABLE');
  });

  it.each(['rejected', 'withdrawn'] as const)('%s -> NOT_ELIGIBLE', async (status) => {
    const fx = await createApplicant(`elig-${status}`, status);
    const state = await getMyQrState({ userId: fx.userId, service: admin });
    expect(state.kind).toBe('NOT_ELIGIBLE');
  });

  it('accepted with no credential yet -> NOT_YET_AVAILABLE (self-issuance path, not an error)', async () => {
    const fx = await createApplicant('elig-accepted-nocred', 'accepted');
    const state = await getMyQrState({ userId: fx.userId, service: admin });
    expect(state.kind).toBe('NOT_YET_AVAILABLE');
  });

  it('no application row at all -> NOT_YET_AVAILABLE', async () => {
    const email = `pqr-no-app-${randomUUID()}@test.local`;
    const { data: user } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
    otherUserIds.push(user!.user!.id);
    const state = await getMyQrState({ userId: user!.user!.id, service: admin });
    expect(state.kind).toBe('NOT_YET_AVAILABLE');
  });
});

describe('ownership: derived from caller.userId only, never a client-supplied id', () => {
  it("participant A's state never reflects participant B's application/credential", async () => {
    const fxA = await createApplicant('own-a', 'accepted');
    const fxB = await createApplicant('own-b', 'accepted');
    await issueMyQrCredential(fxB.client, admin, randomUUID());

    // A has no credential; B does. Calling getMyQrState with A's own
    // userId must reflect A's own (empty) state, never B's.
    const stateA = await getMyQrState({ userId: fxA.userId, service: admin });
    expect(stateA.kind).toBe('NOT_YET_AVAILABLE');

    const stateB = await getMyQrState({ userId: fxB.userId, service: admin });
    expect(stateB.kind).toBe('QR_AVAILABLE');
  });
});

describe('data exposure: no secrets in the resolved state', () => {
  it('QR_AVAILABLE never includes token_hash, ciphertext, or key material — only the canonical payload, credentialId, and allow-listed display fields', async () => {
    const fx = await createApplicant('exposure', 'accepted');
    await issueMyQrCredential(fx.client, admin, randomUUID());
    const state = await getMyQrState({ userId: fx.userId, service: admin });
    expect(state.kind).toBe('QR_AVAILABLE');
    if (state.kind !== 'QR_AVAILABLE') throw new Error('unreachable');

    expect(Object.keys(state).sort()).toEqual(['credentialId', 'kind', 'participant', 'qrPayload']);
    // attendeeCode/participantType (application_number/participant_type) were
    // added to ParticipantQrDisplay's allow-list after this test was written
    // (src/lib/attendance/participant-qr.ts's getOwnDisplaySummary) — both
    // are plain non-sensitive display fields, same category as
    // country/fullName/nationality, not a new exposure.
    expect(Object.keys(state.participant).sort()).toEqual(['attendeeCode', 'country', 'fullName', 'nationality', 'participantType']);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/token_hash|ciphertext|encryption_key|QR_ENCRYPTION_KEY/i);
  });
});

describe('crypto round-trip: the displayed QR is exactly the current stored credential', () => {
  it('parseCanonicalQrPayload + hashQrToken over the reconstructed payload equals the stored token_hash', async () => {
    const fx = await createApplicant('roundtrip', 'accepted');
    const issued = await issueMyQrCredential(fx.client, admin, randomUUID());
    expect(issued.outcome).toBe('issued');

    const state = await getMyQrState({ userId: fx.userId, service: admin });
    expect(state.kind).toBe('QR_AVAILABLE');
    if (state.kind !== 'QR_AVAILABLE') throw new Error('unreachable');

    const parsed = parseCanonicalQrPayload(state.qrPayload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const reconstructedHash = hashQrToken(parsed.rawToken);

    const { data: row } = await admin.from('qr_credentials').select('token_hash').eq('id', state.credentialId).single();
    const storedHash = Buffer.from((row!.token_hash as unknown as string).replace(/^\\x/, ''), 'hex');
    expect(Buffer.compare(reconstructedHash, storedHash)).toBe(0);
  });
});

describe('displayed QR -> scanner: the reconstructed payload actually admits through the unmodified Phase 7 scan path', () => {
  it('scans successfully via scan_qr_attempt_transactional', async () => {
    const conferenceDate = new Date(Date.UTC(2098, 0, 1) + (Math.floor(Math.random() * 3000) + 1) * 86400000).toISOString().slice(0, 10);
    const { data: day } = await admin
      .from('conference_days')
      .insert({ conference_date: conferenceDate, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
      .select('id')
      .single();
    const { data: track } = await admin.from('tracks').insert({ code: `PQR-TRACK-${randomUUID().slice(0, 6)}`, name_ar: 'م', name_en: 'Track' }).select('id').single();
    const { data: sessionType } = await admin.from('session_types').insert({ code: `PQR-TYPE-${randomUUID().slice(0, 6)}`, name_ar: 'ن', name_en: 'Type' }).select('id').single();
    const { data: room } = await admin.from('rooms').insert({ code: `PQR-ROOM-${randomUUID().slice(0, 6)}`, name_ar: 'ق', name_en: 'Room', capacity: 100 }).select('id').single();
    const { data: session } = await admin
      .from('sessions')
      .insert({
        session_code: `PQR-SESSION-${randomUUID().slice(0, 8)}`,
        title_ar: 'ج',
        title_en: 'Session',
        conference_day_id: day!.id,
        start_time: `${conferenceDate}T09:00:00Z`,
        end_time: `${conferenceDate}T10:00:00Z`,
        track_id: track!.id,
        session_type_id: sessionType!.id,
        language: 'bilingual',
        difficulty_level: 'all_levels',
        capacity: 10,
        is_mandatory: false,
        status: 'confirmed',
        admission_policy: 'open',
        room_id: room!.id,
      })
      .select('id')
      .single();
    const sessionId = session!.id;

    const { data: scanner } = await admin.auth.admin.createUser({ email: `pqr-scanner-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
    const scannerId = scanner!.user!.id;
    await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerId);
    const { data: staff } = await admin.auth.admin.createUser({ email: `pqr-staff-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
    await admin.from('profiles').update({ role: 'program_attendance_manager' }).eq('id', staff!.user!.id);
    await admin.from('scanner_assignments').insert({ scanner_user_id: scannerId, session_id: sessionId, assigned_by: staff!.user!.id });

    const fx = await createApplicant('scan-roundtrip', 'accepted');
    await issueMyQrCredential(fx.client, admin, randomUUID());
    const state = await getMyQrState({ userId: fx.userId, service: admin });
    expect(state.kind).toBe('QR_AVAILABLE');
    if (state.kind !== 'QR_AVAILABLE') throw new Error('unreachable');

    const parsed = parseCanonicalQrPayload(state.qrPayload);
    if (!parsed.ok) throw new Error('unreachable');
    const tokenHash = hashQrToken(parsed.rawToken);

    const { data, error } = await admin.rpc('scan_qr_attempt_transactional', {
      p_token_hash: `\\x${tokenHash.toString('hex')}`,
      p_session_id: sessionId,
      p_scanned_by: scannerId,
      p_device_identifier: 'pqr-device' as string,
      p_is_override_caller: false,
    });
    expect(error).toBeNull();
    expect(data!.result).toBe('flexible_admitted');

    await admin.from('scan_attempts').delete().eq('session_id', sessionId);
    await admin.from('attendance_records').delete().eq('session_id', sessionId);
    await admin.from('scanner_assignments').delete().eq('session_id', sessionId);
    await admin.from('sessions').delete().eq('id', sessionId);
    await admin.from('rooms').delete().eq('id', room!.id);
    await admin.from('tracks').delete().eq('id', track!.id);
    await admin.from('session_types').delete().eq('id', sessionType!.id);
    await Promise.allSettled([admin.auth.admin.deleteUser(scannerId), admin.auth.admin.deleteUser(staff!.user!.id)]);
  });
});

describe('revoked/replaced credentials are never displayed as usable', () => {
  it('after reissue, getMyQrState shows only the NEW credential, never the old (now replaced) one', async () => {
    const fx = await createApplicant('replaced', 'accepted');
    const issued = await issueMyQrCredential(fx.client, admin, randomUUID());
    const stateA = await getMyQrState({ userId: fx.userId, service: admin });
    if (stateA.kind !== 'QR_AVAILABLE') throw new Error('unreachable');

    await reissueMyQrCredential(fx.client, admin, {
      requestKey: randomUUID(),
      expectedCurrentCredentialId: issued.credentialId!,
      reissueReasonCode: 'participant_other',
      reissueNote: 'test replacement',
    });

    const stateB = await getMyQrState({ userId: fx.userId, service: admin });
    expect(stateB.kind).toBe('QR_AVAILABLE');
    if (stateB.kind !== 'QR_AVAILABLE') throw new Error('unreachable');
    expect(stateB.credentialId).not.toBe(stateA.credentialId);
    expect(stateB.qrPayload).not.toBe(stateA.qrPayload);
  });

  it('after application_ineligible auto-revocation, no credential is displayed until fresh issuance', async () => {
    const fx = await createApplicant('auto-revoked', 'accepted');
    await issueMyQrCredential(fx.client, admin, randomUUID());
    await admin.from('applications').update({ status: 'waitlisted' }).eq('id', fx.applicationId);

    const stateWhileIneligible = await getMyQrState({ userId: fx.userId, service: admin });
    expect(stateWhileIneligible.kind).toBe('NOT_YET_AVAILABLE');

    await admin.from('applications').update({ status: 'accepted' }).eq('id', fx.applicationId);
    const stateAfterReaccept = await getMyQrState({ userId: fx.userId, service: admin });
    // Old credential stays revoked -> no active credential yet -> self-issuance path, not a resurrected QR.
    expect(stateAfterReaccept.kind).toBe('NOT_YET_AVAILABLE');
  });
});

describe('role boundary (documented, matches the established live-test pattern for un-forgeable server-action callers)', () => {
  // getMyQrState itself takes a caller object directly and has no role
  // check of its own by design (any authenticated user may see their
  // OWN state — a scanner_device or staff account calling it with their
  // OWN userId would just resolve their own application, which for a
  // scanner_device account naturally has none). The actual
  // participant-page authorization boundary is the my-qr/actions.ts
  // 'use server' wrapper's own auth.getUser() check plus the (shell)
  // layout's redirect-if-unauthenticated gate — neither is forgeable in
  // a live test outside a real Next.js request (same structural
  // constraint documented throughout this codebase's other live
  // suites). This test instead proves the DATA-level guarantee
  // getMyQrState actually provides: a scanner_device/staff account's own
  // userId never resolves to a participant's application.
  it('a scanner_device account has no application, so its own getMyQrState call resolves to NOT_YET_AVAILABLE, never another participant’s QR', async () => {
    const { data: scanner } = await admin.auth.admin.createUser({ email: `pqr-role-scanner-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
    otherUserIds.push(scanner!.user!.id);
    await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scanner!.user!.id);
    expect(isScannerDeviceRole('scanner_device')).toBe(true);

    const state = await getMyQrState({ userId: scanner!.user!.id, service: admin });
    expect(state.kind).toBe('NOT_YET_AVAILABLE');
  });

  it('a program_attendance_manager account has no application, so its own getMyQrState call resolves to NOT_YET_AVAILABLE', async () => {
    const { data: staff } = await admin.auth.admin.createUser({ email: `pqr-role-staff-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
    otherUserIds.push(staff!.user!.id);
    await admin.from('profiles').update({ role: 'program_attendance_manager' }).eq('id', staff!.user!.id);
    expect(isProgramAttendanceStaffRole('program_attendance_manager')).toBe(true);

    const state = await getMyQrState({ userId: staff!.user!.id, service: admin });
    expect(state.kind).toBe('NOT_YET_AVAILABLE');
  });
});
