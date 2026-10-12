// tests/attendance/dispatch-all-cron.test.ts
//
// Unit coverage for the unified dispatch-all cron
// (src/app/api/cron/dispatch-all/route.ts), which exists purely to let
// one external cron job drive the 4 fast-cadence cron routes in a single
// HTTP call. Mocks each sub-route's own GET export directly (not their
// internal Supabase/Resend dependencies -- that's already covered by
// each sub-route's own test file, e.g. process-notifications-cron.test.ts)
// so this file tests ONLY the dispatcher's own orchestration: does it
// call all 4, does one failing/throwing sub-route still let the rest
// run, and does the aggregate response reflect partial failure.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  processNotificationsMock,
  sessionRemindersMock,
  processSessionNotificationsMock,
  processSessionNoShowsMock,
} = vi.hoisted(() => ({
  processNotificationsMock: vi.fn(),
  sessionRemindersMock: vi.fn(),
  processSessionNotificationsMock: vi.fn(),
  processSessionNoShowsMock: vi.fn(),
}));

vi.mock('@/app/api/cron/process-notifications/route', () => ({ GET: processNotificationsMock }));
vi.mock('@/app/api/cron/session-reminders/route', () => ({ GET: sessionRemindersMock }));
vi.mock('@/app/api/cron/process-session-notifications/route', () => ({ GET: processSessionNotificationsMock }));
vi.mock('@/app/api/cron/process-session-no-shows/route', () => ({ GET: processSessionNoShowsMock }));

import { GET } from '@/app/api/cron/dispatch-all/route';

function cronRequest(): Request {
  return new Request('http://localhost/api/cron/dispatch-all', {
    headers: { authorization: 'Bearer test-cron-secret' },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dispatch-all cron', () => {
  it('calls all 4 sub-route GET handlers with the incoming request', async () => {
    processNotificationsMock.mockResolvedValue(jsonResponse({ processed: 0, sent: 0, failed: 0 }));
    sessionRemindersMock.mockResolvedValue(jsonResponse({ ok: true }));
    processSessionNotificationsMock.mockResolvedValue(jsonResponse({ ok: true }));
    processSessionNoShowsMock.mockResolvedValue(jsonResponse({ ok: true }));

    const req = cronRequest();
    await GET(req as never);

    expect(processNotificationsMock).toHaveBeenCalledWith(req);
    expect(sessionRemindersMock).toHaveBeenCalledWith(req);
    expect(processSessionNotificationsMock).toHaveBeenCalledWith(req);
    expect(processSessionNoShowsMock).toHaveBeenCalledWith(req);
  });

  it('returns 200 with per-route results when every sub-route succeeds', async () => {
    processNotificationsMock.mockResolvedValue(jsonResponse({ processed: 3, sent: 3, failed: 0 }));
    sessionRemindersMock.mockResolvedValue(jsonResponse({ sent: 1 }));
    processSessionNotificationsMock.mockResolvedValue(jsonResponse({ sent: 0 }));
    processSessionNoShowsMock.mockResolvedValue(jsonResponse({ sent: 0 }));

    const response = await GET(cronRequest() as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(4);
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(body.results.find((r: { name: string }) => r.name === 'process-notifications').body).toEqual({
      processed: 3,
      sent: 3,
      failed: 0,
    });
  });

  it('still calls every sub-route even when one returns a non-ok response, and reports partial failure', async () => {
    processNotificationsMock.mockResolvedValue(jsonResponse({ error: 'Failed to fetch pending notifications' }, 500));
    sessionRemindersMock.mockResolvedValue(jsonResponse({ sent: 1 }));
    processSessionNotificationsMock.mockResolvedValue(jsonResponse({ sent: 0 }));
    processSessionNoShowsMock.mockResolvedValue(jsonResponse({ sent: 0 }));

    const response = await GET(cronRequest() as never);
    const body = await response.json();

    // Every sub-route was still called despite the first one failing.
    expect(sessionRemindersMock).toHaveBeenCalledTimes(1);
    expect(processSessionNotificationsMock).toHaveBeenCalledTimes(1);
    expect(processSessionNoShowsMock).toHaveBeenCalledTimes(1);

    expect(response.status).toBe(207);
    const failedResult = body.results.find((r: { name: string }) => r.name === 'process-notifications');
    expect(failedResult.ok).toBe(false);
    expect(failedResult.status).toBe(500);
  });

  it('still calls every sub-route even when one throws, and records it as a failure rather than aborting', async () => {
    processNotificationsMock.mockRejectedValue(new Error('transient connection drop'));
    sessionRemindersMock.mockResolvedValue(jsonResponse({ sent: 1 }));
    processSessionNotificationsMock.mockResolvedValue(jsonResponse({ sent: 0 }));
    processSessionNoShowsMock.mockResolvedValue(jsonResponse({ sent: 0 }));

    const response = await GET(cronRequest() as never);
    const body = await response.json();

    expect(sessionRemindersMock).toHaveBeenCalledTimes(1);
    expect(processSessionNotificationsMock).toHaveBeenCalledTimes(1);
    expect(processSessionNoShowsMock).toHaveBeenCalledTimes(1);

    expect(response.status).toBe(207);
    const thrownResult = body.results.find((r: { name: string }) => r.name === 'process-notifications');
    expect(thrownResult.ok).toBe(false);
    expect(thrownResult.error).toBe('transient connection drop');
  });
});
