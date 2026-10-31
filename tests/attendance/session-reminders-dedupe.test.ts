// tests/attendance/session-reminders-dedupe.test.ts
//
// Covers the once-daily digest design (changed 2026-10-31 from a
// per-session "30 minutes before" reminder running every 5 minutes, to a
// once-a-day summary of all of a participant's bookings for the Istanbul
// calendar day -- see this route's own header comment for why: quota
// pressure on Resend's free tier). Dedup is still backed by the existing
// unique partial index notifications_session_reminder_dedupe_idx on
// (application_id, session_id, channel) -- this route now keys each
// digest's session_id to the participant's EARLIEST booked session that
// day, so a second same-day invocation (cron drift, manual re-trigger)
// hits the same unique-violation this index was built for.
//
// This suite does not exercise the live unique index itself (that's a
// live-DB behavior, not something a mocked unit test can usefully fake
// beyond "the RPC call returned this error shape") -- it exercises the
// ROUTE's handling of each outcome the RPC can return: success, a 23505
// duplicate, and a genuine other error, following the mocking pattern
// already established in tests/attendance/process-notifications-cron.test.ts.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CRON_SECRET = 'test-cron-secret';

const { createServiceRoleClientMock } = vi.hoisted(() => ({
  createServiceRoleClientMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: createServiceRoleClientMock,
}));

import { GET } from '@/app/api/cron/session-reminders/route';

function cronRequest(bearer?: string): Request {
  const headers: Record<string, string> = {};
  if (bearer !== undefined) headers['authorization'] = bearer;
  return new Request('http://localhost/api/cron/session-reminders', { headers });
}

type Session = {
  id: string;
  title_en: string;
  title_ar: string | null;
  start_time: string;
  rooms: { name_en: string; name_ar: string } | null;
};

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: randomUUID(),
    title_en: 'Opening Ceremony',
    title_ar: null,
    start_time: new Date().toISOString(),
    rooms: { name_en: 'Main Hall', name_ar: 'القاعة الرئيسية' },
    ...overrides,
  };
}

/**
 * Builds a fake service-role client:
 *  - 'sessions' select chain -> `sessions` (today's confirmed sessions).
 *  - 'session_bookings' select chain -> `bookings` (active bookings for them).
 *  - 'applications' select chain -> `apps` (resolved applicant profiles).
 *  - rpc('create_notification', ...) -> consumes `rpcResults` in call
 *    order (one entry per application processed), defaulting to success.
 */
function fakeService(opts: {
  sessions: Session[];
  bookings: Array<{ application_id: string; session_id: string }>;
  apps: Array<{ id: string; preferred_language: string | null; profiles: { full_name: string; email: string } }>;
  rpcResults?: Array<{ error: { code: string; message: string } | null }>;
}) {
  const rpcCalls: unknown[] = [];
  let rpcCallIndex = 0;

  const from = vi.fn((table: string) => {
    if (table === 'sessions') {
      return {
        select: vi.fn(() => ({
          gte: vi.fn(() => ({
            lt: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => Promise.resolve({ data: opts.sessions, error: null })),
              })),
            })),
          })),
        })),
      };
    }
    if (table === 'session_bookings') {
      return {
        select: vi.fn(() => ({
          in: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ data: opts.bookings, error: null })),
          })),
        })),
      };
    }
    if (table === 'applications') {
      return {
        select: vi.fn(() => ({
          in: vi.fn(() => Promise.resolve({ data: opts.apps, error: null })),
        })),
      };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });

  const rpc = vi.fn((_fn: string, params: unknown) => {
    rpcCalls.push(params);
    const result = opts.rpcResults?.[rpcCallIndex] ?? { error: null };
    rpcCallIndex++;
    return Promise.resolve(result);
  });

  return { client: { from, rpc }, rpcCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = CRON_SECRET;
});

describe('GET /api/cron/session-reminders', () => {
  it('sends a digest for a participant booked into a session today', async () => {
    const session = baseSession();
    const appId = randomUUID();
    const { client } = fakeService({
      sessions: [session],
      bookings: [{ application_id: appId, session_id: session.id }],
      apps: [{ id: appId, preferred_language: 'en', profiles: { full_name: 'Jane Doe', email: 'jane@example.com' } }],
    });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(1);
    expect(json.failed).toBe(0);
    expect(json.alreadyReminded).toBe(0);
  });

  it('lists every booked session today in one digest body, keyed to the earliest for dedup', async () => {
    const earlier = baseSession({ start_time: new Date(Date.now() - 60 * 60 * 1000).toISOString(), title_en: 'Morning Plenary' });
    const later = baseSession({ start_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(), title_en: 'Afternoon Workshop' });
    const appId = randomUUID();
    const { client, rpcCalls } = fakeService({
      sessions: [earlier, later],
      bookings: [
        { application_id: appId, session_id: earlier.id },
        { application_id: appId, session_id: later.id },
      ],
      apps: [{ id: appId, preferred_language: 'en', profiles: { full_name: 'Jane Doe', email: 'jane@example.com' } }],
    });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(1);
    expect(rpcCalls).toHaveLength(1);
    const call = rpcCalls[0] as { p_body: string; p_session_id: string; p_title: string };
    expect(call.p_body).toContain('Morning Plenary');
    expect(call.p_body).toContain('Afternoon Workshop');
    expect(call.p_session_id).toBe(earlier.id); // earliest session is the dedup key
    expect(call.p_title).toContain('2'); // 2 sessions today
  });

  // Core regression coverage carried over from the per-session design: a
  // second same-day invocation for the same participant must be recognized
  // as a duplicate via the RPC's 23505 response -- not counted as a
  // failure, and not silently swallowed as a success either.
  it('counts a 23505 unique-violation from create_notification as alreadyReminded, not failed', async () => {
    const session = baseSession();
    const appId = randomUUID();
    const { client } = fakeService({
      sessions: [session],
      bookings: [{ application_id: appId, session_id: session.id }],
      apps: [{ id: appId, preferred_language: 'en', profiles: { full_name: 'Jane Doe', email: 'jane@example.com' } }],
      rpcResults: [{ error: { code: '23505', message: 'duplicate key value violates unique constraint "notifications_session_reminder_dedupe_idx"' } }],
    });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(0);
    expect(json.failed).toBe(0);
    expect(json.alreadyReminded).toBe(1);
  });

  it('still counts a genuine (non-23505) create_notification error as failed, logging it', async () => {
    const session = baseSession();
    const appId = randomUUID();
    const { client } = fakeService({
      sessions: [session],
      bookings: [{ application_id: appId, session_id: session.id }],
      apps: [{ id: appId, preferred_language: 'en', profiles: { full_name: 'Jane Doe', email: 'jane@example.com' } }],
      rpcResults: [{ error: { code: '42501', message: 'permission denied' } }],
    });
    createServiceRoleClientMock.mockReturnValue(client);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(0);
    expect(json.failed).toBe(1);
    expect(json.alreadyReminded).toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('across repeated same-day invocations for the same participant, only the first is sent and the rest are deduped', async () => {
    const session = baseSession();
    const appId = randomUUID();
    const appFixture = { id: appId, preferred_language: 'en' as const, profiles: { full_name: 'Jane Doe', email: 'jane@example.com' } };

    const tick1 = fakeService({
      sessions: [session],
      bookings: [{ application_id: appId, session_id: session.id }],
      apps: [appFixture],
      rpcResults: [{ error: null }],
    });
    createServiceRoleClientMock.mockReturnValue(tick1.client);
    const firstTick = await (await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never)).json();
    expect(firstTick).toMatchObject({ sent: 1, failed: 0, alreadyReminded: 0 });

    const tick2 = fakeService({
      sessions: [session],
      bookings: [{ application_id: appId, session_id: session.id }],
      apps: [appFixture],
      rpcResults: [{ error: { code: '23505', message: 'duplicate key value violates unique constraint' } }],
    });
    createServiceRoleClientMock.mockReturnValue(tick2.client);
    const secondTick = await (await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never)).json();
    expect(secondTick).toMatchObject({ sent: 0, failed: 0, alreadyReminded: 1 });
  });

  // Regression test for a live incident (2026-10-13): a real, non-staff
  // participant's profiles.full_name was '' (empty, not null). This
  // route must still send -- gating only on email, matching
  // process-notifications's own established pattern of degrading to an
  // empty greeting rather than skipping on a missing name.
  it('still creates a digest for a participant whose profile full_name is empty, not just missing email', async () => {
    const session = baseSession();
    const appId = randomUUID();
    const { client, rpcCalls } = fakeService({
      sessions: [session],
      bookings: [{ application_id: appId, session_id: session.id }],
      apps: [{ id: appId, preferred_language: 'en', profiles: { full_name: '', email: 'noname@example.com' } }],
    });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const body = await response.json();

    expect(body).toMatchObject({ sent: 1, failed: 0, alreadyReminded: 0 });
    expect(rpcCalls).toHaveLength(1);
  });
});
