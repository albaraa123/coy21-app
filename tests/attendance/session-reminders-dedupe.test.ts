// tests/attendance/session-reminders-dedupe.test.ts
//
// Final whole-branch review of sub-project 6 found that
// src/app/api/cron/session-reminders/route.ts had no coverage for its own
// 10-minute match window overlapping its 5-minute cron cadence: 2-3
// consecutive invocations can match the SAME upcoming session for the
// SAME participant, and without a guard each would insert its own
// session_reminder row (duplicate bell entries, duplicate emails). Fixed
// via a unique partial index (notifications_session_reminder_dedupe_idx,
// migration 20261008090000) plus route-level handling of the resulting
// 23505 unique-violation as "already reminded", not a failure.
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
  end_time: string;
  rooms: { name_en: string; name_ar: string } | null;
};

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: randomUUID(),
    title_en: 'Opening Ceremony',
    title_ar: null,
    start_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    end_time: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
    rooms: { name_en: 'Main Hall', name_ar: 'القاعة الرئيسية' },
    ...overrides,
  };
}

/**
 * Builds a fake service-role client:
 *  - 'sessions' select chain -> `sessions` (one matched session).
 *  - 'session_bookings' select chain -> `bookings` (active bookings for it).
 *  - 'applications' select chain -> `apps` (resolved applicant profiles).
 *  - rpc('create_notification', ...) -> consumes `rpcResults` in call
 *    order (one entry per application processed), defaulting to success.
 */
function fakeService(opts: {
  sessions: Session[];
  bookings: Array<{ application_id: string }>;
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
            lte: vi.fn(() => ({
              eq: vi.fn(() => Promise.resolve({ data: opts.sessions, error: null })),
            })),
          })),
        })),
      };
    }
    if (table === 'session_bookings') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
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
  it('sends a reminder for a newly-matched participant', async () => {
    const session = baseSession();
    const appId = randomUUID();
    const { client } = fakeService({
      sessions: [session],
      bookings: [{ application_id: appId }],
      apps: [{ id: appId, preferred_language: 'en', profiles: { full_name: 'Jane Doe', email: 'jane@example.com' } }],
    });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(1);
    expect(json.failed).toBe(0);
    expect(json.alreadyReminded).toBe(0);
  });

  // The core regression test: a second (or third) invocation within the
  // same 10-minute match window, for the same participant/session, must
  // be recognized as a duplicate via the RPC's 23505 response -- not
  // counted as a failure, and not silently swallowed as a success either.
  it('counts a 23505 unique-violation from create_notification as alreadyReminded, not failed', async () => {
    const session = baseSession();
    const appId = randomUUID();
    const { client } = fakeService({
      sessions: [session],
      bookings: [{ application_id: appId }],
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
      bookings: [{ application_id: appId }],
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

  // Simulates the exact scenario the finding described: three consecutive
  // 5-minute cron ticks all matching the same session/participant pair
  // (the 10-minute window overlapping 2-3 cadences). Only the first call
  // should ever land as a real send; the rest must be deduped.
  it('across repeated invocations for the same participant/session, only the first is sent and the rest are deduped', async () => {
    const session = baseSession();
    const appId = randomUUID();
    const appFixture = { id: appId, preferred_language: 'en' as const, profiles: { full_name: 'Jane Doe', email: 'jane@example.com' } };

    const tick1 = fakeService({
      sessions: [session],
      bookings: [{ application_id: appId }],
      apps: [appFixture],
      rpcResults: [{ error: null }],
    });
    createServiceRoleClientMock.mockReturnValue(tick1.client);
    const firstTick = await (await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never)).json();
    expect(firstTick).toMatchObject({ sent: 1, failed: 0, alreadyReminded: 0 });

    const tick2 = fakeService({
      sessions: [session],
      bookings: [{ application_id: appId }],
      apps: [appFixture],
      rpcResults: [{ error: { code: '23505', message: 'duplicate key value violates unique constraint' } }],
    });
    createServiceRoleClientMock.mockReturnValue(tick2.client);
    const secondTick = await (await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never)).json();
    expect(secondTick).toMatchObject({ sent: 0, failed: 0, alreadyReminded: 1 });
  });
});
