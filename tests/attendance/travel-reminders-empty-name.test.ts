// tests/attendance/travel-reminders-empty-name.test.ts
//
// Regression test for a live incident (2026-10-13): src/app/api/cron/
// travel-reminders/route.ts gated recipient inclusion on
// `!profile?.email || !profile?.full_name`, silently dropping any accepted
// applicant whose profiles.full_name is '' (not null -- a self-registered
// participant can leave it blank; profiles.full_name is NOT NULL with a
// coalesce-to-'' default on signup) from travel-reminder dispatch
// entirely, despite having a valid email and no travel_legs row yet.
// process-notifications itself never skips on a missing name for any
// channel (it degrades to an empty greeting), so this stricter check was
// the odd one out -- same bug class, same fix, as
// session-reminders-dedupe.test.ts's matching regression test.
//
// No test file existed for this route before this one -- follows the same
// "import and call the handler directly" mocking convention established
// in tests/attendance/process-notifications-cron.test.ts and
// tests/attendance/session-reminders-dedupe.test.ts.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CRON_SECRET = 'test-cron-secret';

const { createServiceRoleClientMock } = vi.hoisted(() => ({
  createServiceRoleClientMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: createServiceRoleClientMock,
}));

import { GET } from '@/app/api/cron/travel-reminders/route';

function cronRequest(bearer?: string): Request {
  const headers: Record<string, string> = {};
  if (bearer !== undefined) headers['authorization'] = bearer;
  return new Request('http://localhost/api/cron/travel-reminders', { headers });
}

/**
 * Builds a fake service-role client:
 *  - 'travel_legs' select -> empty (no one has submitted travel yet).
 *  - 'applications' select -> `apps` (accepted applicants + profiles).
 *  - rpc('create_notification', ...) -> success for every call.
 */
function fakeService(apps: Array<{ id: string; preferred_language: string | null; profiles: { full_name: string; email: string } }>) {
  const rpcCalls: unknown[] = [];

  const from = vi.fn((table: string) => {
    if (table === 'travel_legs') {
      return {
        select: vi.fn(() => Promise.resolve({ data: [], error: null })),
      };
    }
    if (table === 'applications') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => Promise.resolve({ data: apps, error: null })),
        })),
      };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });

  const rpc = vi.fn((_fn: string, params: unknown) => {
    rpcCalls.push(params);
    return Promise.resolve({ error: null });
  });

  return { client: { from, rpc }, rpcCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = CRON_SECRET;
});

describe('GET /api/cron/travel-reminders', () => {
  it('still creates a reminder for an accepted applicant whose profile full_name is empty, not just missing email', async () => {
    const appId = randomUUID();
    const { client, rpcCalls } = fakeService([
      { id: appId, preferred_language: 'en', profiles: { full_name: '', email: 'noname@example.com' } },
    ]);
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const body = await response.json();

    expect(body).toMatchObject({ sent: 1, failed: 0 });
    expect(rpcCalls).toHaveLength(1);
  });

  it('still skips an applicant with no email at all', async () => {
    const appId = randomUUID();
    const { client, rpcCalls } = fakeService([
      { id: appId, preferred_language: 'en', profiles: { full_name: 'Has A Name', email: '' } },
    ]);
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const body = await response.json();

    expect(body).toMatchObject({ sent: 0, failed: 0 });
    expect(rpcCalls).toHaveLength(0);
  });
});
