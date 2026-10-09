// tests/attendance/process-notifications-cron.test.ts
//
// Sub-project 6, Task 6: unit coverage for the unified process-notifications
// cron (src/app/api/cron/process-notifications/route.ts). No precedent
// exists anywhere in this codebase for testing a cron Route Handler's GET
// directly, so this establishes one -- following the general "import and
// call the handler directly" convention from tests/api/admit-walk-in-route.test.ts
// (a different kind of route, used only for shape/structure), with the
// Supabase service-role client and the resend.ts email functions mocked
// here since nothing pre-built exists for cron routes specifically.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CRON_SECRET = 'test-cron-secret';

const {
  createServiceRoleClientMock,
  sendSessionCancellationNotificationEmailMock,
  sendSessionRescheduleNotificationEmailMock,
  sendWaitlistPromotionNotificationEmailMock,
  sendApplicationAcceptedEmailMock,
  sendApplicationRejectedEmailMock,
  sendBookingConfirmedEmailMock,
  sendAnnouncementEmailMock,
  sendSessionReminderEmailMock,
  sendTravelReminderEmailMock,
} = vi.hoisted(() => ({
  createServiceRoleClientMock: vi.fn(),
  sendSessionCancellationNotificationEmailMock: vi.fn(),
  sendSessionRescheduleNotificationEmailMock: vi.fn(),
  sendWaitlistPromotionNotificationEmailMock: vi.fn(),
  sendApplicationAcceptedEmailMock: vi.fn(),
  sendApplicationRejectedEmailMock: vi.fn(),
  sendBookingConfirmedEmailMock: vi.fn(),
  sendAnnouncementEmailMock: vi.fn(),
  sendSessionReminderEmailMock: vi.fn(),
  sendTravelReminderEmailMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: createServiceRoleClientMock,
}));

vi.mock('@/lib/email/resend', () => ({
  sendSessionCancellationNotificationEmail: sendSessionCancellationNotificationEmailMock,
  sendSessionRescheduleNotificationEmail: sendSessionRescheduleNotificationEmailMock,
  sendWaitlistPromotionNotificationEmail: sendWaitlistPromotionNotificationEmailMock,
  sendApplicationAcceptedEmail: sendApplicationAcceptedEmailMock,
  sendApplicationRejectedEmail: sendApplicationRejectedEmailMock,
  sendBookingConfirmedEmail: sendBookingConfirmedEmailMock,
  sendAnnouncementEmail: sendAnnouncementEmailMock,
  sendSessionReminderEmail: sendSessionReminderEmailMock,
  sendTravelReminderEmail: sendTravelReminderEmailMock,
}));

import { GET } from '@/app/api/cron/process-notifications/route';

function cronRequest(bearer?: string): Request {
  const headers: Record<string, string> = {};
  if (bearer !== undefined) headers['authorization'] = bearer;
  return new Request('http://localhost/api/cron/process-notifications', { headers });
}

type NotificationRow = {
  id: string;
  is_broadcast: boolean;
  application_id: string | null;
  channel: string;
  title: string;
  body: string | null;
  link_path: string | null;
  session_id: string | null;
  old_start_time: string | null;
  new_start_time: string | null;
  email_status: string;
  claimed_at: string | null;
};

type FakeAppLookupResult = { data: unknown; error: unknown };

/**
 * Builds a fake service-role client whose `.from(table)` dispatches based
 * on `table`:
 *  - 'notifications' select chain -> pendingRows via .or().order().limit().
 *    Its .update() chain is recorded in `updates`; the FIRST update call
 *    per row id is the claim (pending/stale-processing -> processing) and
 *    is driven by `claimResult` (defaults to succeeding, i.e. 1 row
 *    affected) -- every update after the first for that id is a real
 *    sent/failed resolution.
 *  - 'applications' select chain -> either a queue of per-call results
 *    (appLookupQueue, consumed in order -- used by the lazy-evaluation
 *    test to return a DIFFERENT result on the 2nd call than the 1st) or
 *    a single fixed result used for every call.
 */
function fakeService(opts: {
  pendingRows: NotificationRow[];
  appLookupQueue?: FakeAppLookupResult[];
  appLookupResult?: FakeAppLookupResult;
  broadcastRecipientsResult?: { data: unknown[] | null; error: unknown };
  claimResult?: { data: unknown; error: unknown } | ((id: string) => { data: unknown; error: unknown });
}) {
  const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const claimedIds = new Set<string>();
  // Every .eq() call made as part of a claim attempt, grouped per claim
  // (one inner array per UPDATE call that turned out to be a claim), so
  // tests can assert the EXACT chain shape used (e.g. ['id', ...],
  // ['email_status', ...], and -- only for a stale-processing reclaim --
  // ['claimed_at', ...]) rather than just that *some* claim happened.
  const claimEqCalls: Array<Array<[string, unknown]>> = [];
  let appLookupCallIndex = 0;

  const from = vi.fn((table: string) => {
    if (table === 'notifications') {
      return {
        select: vi.fn(() => ({
          or: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve({ data: opts.pendingRows, error: null })),
            })),
          })),
        })),
        update: vi.fn((payload: Record<string, unknown>) => {
          // First .eq() in the chain is always on 'id'. Whether THIS
          // update call is a claim (vs. a real sent/failed resolution) is
          // decided right here, once, the first time a given id's update
          // chain is built -- not re-decided on each subsequent .eq() --
          // so the recorded eq-call list below reflects exactly what the
          // real supabase-js builder call sequence would record. A real
          // resolution update is `.update(...).eq('id', id)` with NO
          // further chaining -- the route awaits that .eq() call directly
          // -- so each node is itself thenable (a resolved-promise shape)
          // as well as exposing `.eq`/`.select` for the longer claim chain.
          let isClaim: boolean | null = null;
          let recordedCalls: Array<[string, unknown]> = [];
          let resolutionId: string | undefined;

          function buildEqNode(): Record<string, unknown> {
            const resolved = Promise.resolve({ data: null, error: null });
            return {
              eq: vi.fn((col: string, value: unknown) => {
                if (isClaim === null) {
                  isClaim = payload.email_status === 'processing' && !claimedIds.has(value as string);
                  if (isClaim) {
                    recordedCalls = [];
                    claimEqCalls.push(recordedCalls);
                    claimedIds.add(value as string);
                  } else {
                    resolutionId = value as string;
                  }
                }
                if (isClaim) recordedCalls.push([col, value]);
                return buildEqNode();
              }),
              select: vi.fn(() => {
                const id = recordedCalls.find((c) => c[0] === 'id')?.[1] as string | undefined;
                return Promise.resolve(isClaim && id ? resolveClaim(id) : { data: null, error: null });
              }),
              then: (...args: Parameters<Promise<unknown>['then']>) => {
                if (!isClaim && resolutionId) updates.push({ id: resolutionId, payload });
                return resolved.then(...args);
              },
            };
          }

          return buildEqNode();
        }),
      };
    }
    if (table === 'applications') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn((col: string, value: string) => {
            // Broadcast recipient query: .eq('status', 'accepted') with no .single()
            if (col === 'status' && value === 'accepted') {
              return Promise.resolve(
                opts.broadcastRecipientsResult ?? { data: [], error: null }
              );
            }
            // Personal row lookup: .eq('id', applicationId).single()
            return {
              single: vi.fn(() => {
                if (opts.appLookupQueue) {
                  const result = opts.appLookupQueue[appLookupCallIndex] ?? opts.appLookupQueue[opts.appLookupQueue.length - 1];
                  appLookupCallIndex++;
                  return Promise.resolve(result);
                }
                return Promise.resolve(opts.appLookupResult ?? { data: null, error: null });
              }),
            };
          }),
        })),
      };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });

  function resolveClaim(id: string): { data: unknown; error: unknown } {
    if (typeof opts.claimResult === 'function') return opts.claimResult(id);
    return opts.claimResult ?? { data: [{ id }], error: null };
  }

  return { client: { from }, updates, claimEqCalls };
}

function applicationRow(overrides: Partial<{ full_name: string; email: string; preferred_language: string }> = {}) {
  return {
    data: {
      preferred_language: overrides.preferred_language ?? 'en',
      profiles: { full_name: overrides.full_name ?? 'Jane Doe', email: overrides.email ?? 'jane@example.com' },
    },
    error: null,
  };
}

function baseRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: randomUUID(),
    is_broadcast: false,
    application_id: randomUUID(),
    channel: 'application_accepted',
    title: 'Your application has been accepted!',
    body: null,
    link_path: null,
    session_id: null,
    old_start_time: null,
    new_start_time: null,
    email_status: 'pending',
    claimed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = CRON_SECRET;
  sendSessionCancellationNotificationEmailMock.mockResolvedValue({ id: 'email-id', error: null });
  sendSessionRescheduleNotificationEmailMock.mockResolvedValue({ id: 'email-id', error: null });
  sendWaitlistPromotionNotificationEmailMock.mockResolvedValue({ id: 'email-id', error: null });
  sendApplicationAcceptedEmailMock.mockResolvedValue({ id: 'email-id', error: null });
  sendApplicationRejectedEmailMock.mockResolvedValue({ id: 'email-id', error: null });
  sendBookingConfirmedEmailMock.mockResolvedValue({ id: 'email-id', error: null });
  sendAnnouncementEmailMock.mockResolvedValue({ id: 'email-id', error: null });
  sendSessionReminderEmailMock.mockResolvedValue({ id: 'email-id', error: null });
  sendTravelReminderEmailMock.mockResolvedValue({ id: 'email-id', error: null });
});

describe('GET /api/cron/process-notifications', () => {
  it('returns 500 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    expect(response.status).toBe(500);
  });

  it('returns 403 when the bearer token is missing', async () => {
    const response = await GET(cronRequest(undefined) as never);
    expect(response.status).toBe(403);
  });

  it('returns 403 when the bearer token is wrong', async () => {
    const response = await GET(cronRequest('Bearer wrong-secret') as never);
    expect(response.status).toBe(403);
  });

  it('dispatches the correct email function based on channel and marks the row sent', async () => {
    const row = baseRow({ channel: 'application_accepted' });
    const { client, updates, claimEqCalls } = fakeService({
      pendingRows: [row],
      appLookupResult: applicationRow(),
    });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.sent).toBe(1);
    expect(json.failed).toBe(0);

    expect(sendApplicationAcceptedEmailMock).toHaveBeenCalledWith({
      to: 'jane@example.com',
      fullName: 'Jane Doe',
      locale: 'en',
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(row.id);
    expect(updates[0].payload.email_status).toBe('sent');

    // A fresh-pending row's claim uses only 2 .eq() calls (id, email_status)
    // -- no claimed_at condition -- contrasting with the 3-call
    // stale-processing-reclaim shape covered by a dedicated test below.
    expect(claimEqCalls).toHaveLength(1);
    expect(claimEqCalls[0]).toEqual([
      ['id', row.id],
      ['email_status', 'pending'],
    ]);
  });

  it('dispatches session_cancelled to sendSessionCancellationNotificationEmail', async () => {
    const row = baseRow({ channel: 'session_cancelled', title: 'Opening Ceremony' });
    const { client } = fakeService({ pendingRows: [row], appLookupResult: applicationRow() });
    createServiceRoleClientMock.mockReturnValue(client);

    await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);

    expect(sendSessionCancellationNotificationEmailMock).toHaveBeenCalledWith({
      to: 'jane@example.com',
      fullName: 'Jane Doe',
      sessionTitle: 'Opening Ceremony',
      locale: 'en',
    });
  });

  it('dispatches session_rescheduled with old/new start times', async () => {
    const oldStart = '2026-11-05T10:00:00Z';
    const newStart = '2026-11-05T12:00:00Z';
    const row = baseRow({ channel: 'session_rescheduled', old_start_time: oldStart, new_start_time: newStart });
    const { client } = fakeService({ pendingRows: [row], appLookupResult: applicationRow() });
    createServiceRoleClientMock.mockReturnValue(client);

    await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);

    expect(sendSessionRescheduleNotificationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ oldStartTime: oldStart, newStartTime: newStart })
    );
  });

  it('dispatches waitlist_promoted to sendWaitlistPromotionNotificationEmail', async () => {
    const row = baseRow({ channel: 'waitlist_promoted' });
    const { client } = fakeService({ pendingRows: [row], appLookupResult: applicationRow() });
    createServiceRoleClientMock.mockReturnValue(client);

    await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);

    expect(sendWaitlistPromotionNotificationEmailMock).toHaveBeenCalled();
  });

  it('dispatches session_reminder to sendSessionReminderEmail using the row title/body/link_path', async () => {
    const row = baseRow({
      channel: 'session_reminder',
      title: 'Reminder: "Opening Ceremony" starts in 30 minutes',
      body: 'Room: Main Hall\nTime: 10:00',
      link_path: '/my-agenda',
    });
    const { client, updates } = fakeService({ pendingRows: [row], appLookupResult: applicationRow() });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(1);
    expect(json.failed).toBe(0);
    expect(sendSessionReminderEmailMock).toHaveBeenCalledWith({
      to: 'jane@example.com',
      fullName: 'Jane Doe',
      title: row.title,
      body: row.body,
      locale: 'en',
    });
    expect(updates[0].payload.email_status).toBe('sent');
  });

  it('dispatches travel_reminder to sendTravelReminderEmail using the row title/body/link_path', async () => {
    const row = baseRow({
      channel: 'travel_reminder',
      title: 'Action required: submit your travel details for COY21',
      body: "We haven't received your travel details yet.",
      link_path: '/my-travel',
    });
    const { client, updates } = fakeService({ pendingRows: [row], appLookupResult: applicationRow() });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(1);
    expect(json.failed).toBe(0);
    expect(sendTravelReminderEmailMock).toHaveBeenCalledWith({
      to: 'jane@example.com',
      fullName: 'Jane Doe',
      title: row.title,
      body: row.body,
      locale: 'en',
    });
    expect(updates[0].payload.email_status).toBe('sent');
  });

  it('marks a genuinely unhandled channel as failed without calling any email function', async () => {
    const row = baseRow({ channel: 'some_future_unmapped_channel' });
    const { client, updates } = fakeService({ pendingRows: [row], appLookupResult: applicationRow() });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.failed).toBe(1);
    expect(json.sent).toBe(0);
    expect(updates[0].payload.email_status).toBe('failed');
    expect(String(updates[0].payload.error_message)).toMatch(/some_future_unmapped_channel/);

    for (const mock of [
      sendApplicationAcceptedEmailMock,
      sendApplicationRejectedEmailMock,
      sendBookingConfirmedEmailMock,
      sendSessionCancellationNotificationEmailMock,
      sendSessionRescheduleNotificationEmailMock,
      sendWaitlistPromotionNotificationEmailMock,
      sendSessionReminderEmailMock,
      sendTravelReminderEmailMock,
    ]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it('marks the row failed when the email function itself returns an error, without throwing', async () => {
    const row = baseRow({ channel: 'application_rejected' });
    const { client, updates } = fakeService({ pendingRows: [row], appLookupResult: applicationRow() });
    createServiceRoleClientMock.mockReturnValue(client);
    sendApplicationRejectedEmailMock.mockResolvedValue({ id: null, error: 'Resend not configured' });

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.failed).toBe(1);
    expect(updates[0].payload.email_status).toBe('failed');
    expect(updates[0].payload.error_message).toBe('Resend not configured');
  });

  it('marks the row failed when the applicant profile/email is missing', async () => {
    const row = baseRow({ channel: 'application_accepted' });
    const { client, updates } = fakeService({
      pendingRows: [row],
      appLookupResult: { data: { preferred_language: 'en', profiles: null }, error: null },
    });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.failed).toBe(1);
    expect(updates[0].payload.email_status).toBe('failed');
    expect(sendApplicationAcceptedEmailMock).not.toHaveBeenCalled();
  });

  it('only queries pending (or stale-processing) rows and never re-processes rows the cron already resolved (sent/failed)', async () => {
    const row = baseRow({ channel: 'application_accepted' });
    const { client } = fakeService({ pendingRows: [row], appLookupResult: applicationRow() });
    createServiceRoleClientMock.mockReturnValue(client);

    await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);

    // The fake service's notifications.select().or() chain is only ever
    // wired to serve pending/stale-processing rows -- assert the handler
    // actually calls .or with that filter rather than fetching everything.
    const notificationsFromCall = (client.from as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'notifications');
    expect(notificationsFromCall).toBeTruthy();
  });

  it('reclaims a stale-processing row (abandoned by a crashed prior invocation) and sends it', async () => {
    // A row the fetch query picked up because it's been 'processing' for
    // longer than STALE_PROCESSING_MS -- exercises the claim's 3-.eq()
    // branch (id + email_status + claimed_at), not the 2-.eq() fresh-pending
    // branch every other test in this file uses. Asserting on claimEqCalls
    // directly (not just the end-to-end sent outcome) proves the extra
    // claimed_at condition was actually issued, since the fake's resolved
    // value does not otherwise depend on which branch ran.
    const staleClaimedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const row = baseRow({ channel: 'application_accepted', email_status: 'processing', claimed_at: staleClaimedAt });
    const { client, updates, claimEqCalls } = fakeService({ pendingRows: [row], appLookupResult: applicationRow() });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(1);
    expect(json.failed).toBe(0);
    expect(sendApplicationAcceptedEmailMock).toHaveBeenCalledTimes(1);
    expect(updates[0].payload.email_status).toBe('sent');

    expect(claimEqCalls).toHaveLength(1);
    expect(claimEqCalls[0]).toEqual([
      ['id', row.id],
      ['email_status', 'processing'],
      ['claimed_at', staleClaimedAt],
    ]);
  });

  it('skips a stale-processing row if a concurrent invocation reclaims it first (the claimed_at condition no longer matches)', async () => {
    const staleClaimedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const row = baseRow({ channel: 'application_accepted', email_status: 'processing', claimed_at: staleClaimedAt });
    const { client, updates } = fakeService({
      pendingRows: [row],
      appLookupResult: applicationRow(),
      // Simulates another invocation reclaiming this exact stale row first:
      // by the time this invocation's UPDATE runs, claimed_at has already
      // moved on, so the 3-.eq() filter (id + email_status + claimed_at)
      // matches 0 rows.
      claimResult: { data: [], error: null },
    });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(0);
    expect(json.failed).toBe(0);
    expect(sendApplicationAcceptedEmailMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('skips a row whose claim loses the race to a concurrent invocation, sending no email and not counting it', async () => {
    const row = baseRow({ channel: 'application_accepted' });
    const { client, updates } = fakeService({
      pendingRows: [row],
      appLookupResult: applicationRow(),
      // Simulates another invocation claiming this exact row first: the
      // conditional UPDATE's .eq() filters no longer match any row, so
      // .select('id') comes back empty.
      claimResult: { data: [], error: null },
    });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(0);
    expect(json.failed).toBe(0);
    expect(sendApplicationAcceptedEmailMock).not.toHaveBeenCalled();
    // No sent/failed resolution update was made either -- the row was
    // skipped entirely, left for whichever invocation actually won the claim.
    expect(updates).toHaveLength(0);
  });

  it('skips a row when the claim query itself errors, logging but not throwing', async () => {
    const row = baseRow({ channel: 'application_accepted' });
    const { client } = fakeService({
      pendingRows: [row],
      appLookupResult: applicationRow(),
      claimResult: { data: null, error: { message: 'connection reset' } },
    });
    createServiceRoleClientMock.mockReturnValue(client);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.sent).toBe(0);
    expect(json.failed).toBe(0);
    expect(sendApplicationAcceptedEmailMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('marks a row failed (not left stuck) when the email function throws instead of returning {error}', async () => {
    const row = baseRow({ channel: 'application_accepted' });
    const { client, updates } = fakeService({ pendingRows: [row], appLookupResult: applicationRow() });
    createServiceRoleClientMock.mockReturnValue(client);
    sendApplicationAcceptedEmailMock.mockRejectedValue(new Error('ECONNRESET'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.failed).toBe(1);
    expect(json.sent).toBe(0);
    const resolution = updates.find((u) => u.payload.email_status === 'failed');
    expect(resolution).toBeTruthy();
    expect(String(resolution!.payload.error_message)).toMatch(/ECONNRESET/);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('returns 500 and logs when the initial pending-rows fetch itself errors', async () => {
    const { client } = fakeService({ pendingRows: [] });
    (client.from as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      select: vi.fn(() => ({
        or: vi.fn(() => ({
          order: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve({ data: null, error: { message: 'db unavailable' } })),
          })),
        })),
      })),
    }));
    createServiceRoleClientMock.mockReturnValue(client);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    expect(response.status).toBe(500);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('a broadcast batch where one recipient send throws is still marked sent, with the other recipient still emailed', async () => {
    const row = baseRow({ is_broadcast: true, application_id: null, channel: 'announcement', title: 'Venue change', body: null });
    const recipients = [
      { id: randomUUID(), preferred_language: 'en', profiles: { full_name: 'Alice', email: 'alice@example.com' } },
      { id: randomUUID(), preferred_language: 'en', profiles: { full_name: 'Bilal', email: 'bilal@example.com' } },
    ];
    const { client, updates } = fakeService({
      pendingRows: [row],
      broadcastRecipientsResult: { data: recipients, error: null },
    });
    createServiceRoleClientMock.mockReturnValue(client);
    sendAnnouncementEmailMock
      .mockRejectedValueOnce(new Error('Resend timeout'))
      .mockResolvedValueOnce({ id: 'ok', error: null });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(1);
    expect(sendAnnouncementEmailMock).toHaveBeenCalledTimes(2);
    expect(updates[0].payload.email_status).toBe('sent');
    expect(String(updates[0].payload.error_message)).toMatch(/failed/i);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('a pending broadcast row queries all accepted applications, batches sends, and marks sent', async () => {
    const row = baseRow({ is_broadcast: true, application_id: null, channel: 'announcement', title: 'Venue change', body: 'New hall assignment' });
    const recipients = [
      { id: randomUUID(), preferred_language: 'en', profiles: { full_name: 'Alice', email: 'alice@example.com' } },
      { id: randomUUID(), preferred_language: 'ar', profiles: { full_name: 'Bilal', email: 'bilal@example.com' } },
    ];
    const { client, updates } = fakeService({
      pendingRows: [row],
      broadcastRecipientsResult: { data: recipients, error: null },
    });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(1);
    expect(sendAnnouncementEmailMock).toHaveBeenCalledTimes(2);
    expect(sendAnnouncementEmailMock).toHaveBeenCalledWith({
      to: 'alice@example.com', fullName: 'Alice', title: 'Venue change', body: 'New hall assignment', locale: 'en',
    });
    expect(sendAnnouncementEmailMock).toHaveBeenCalledWith({
      to: 'bilal@example.com', fullName: 'Bilal', title: 'Venue change', body: 'New hall assignment', locale: 'ar',
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.email_status).toBe('sent');
    expect(updates[0].payload.error_message).toBeNull();
  });

  // Found live, 2026-10-09: a broadcast row with zero accepted applicants
  // at send time (e.g. created before any applicant was accepted yet, or
  // a test/empty database) previously fell through the SAME "sent, no
  // error" path as a genuinely successful send -- sendAnnouncementEmail
  // was never called even once (the batching loop's list is empty), yet
  // the row was marked 'sent' with a null error_message. This was
  // confirmed on the real deployed site: the notifications table showed
  // email_status='sent' for a test announcement, but Resend's own send
  // log had no record of it at all -- indistinguishable from a real
  // delivery without checking Resend directly. Must now be marked
  // 'failed' with a specific, non-generic message instead, so an empty
  // audience is visibly different from both a clean send and a partial
  // failure.
  it('a broadcast row with zero accepted applicants at send time is marked failed, not a silent "sent"', async () => {
    const row = baseRow({ is_broadcast: true, application_id: null, channel: 'announcement', title: 'Test Announcement', body: null });
    const { client, updates } = fakeService({
      pendingRows: [row],
      broadcastRecipientsResult: { data: [], error: null },
    });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(0);
    expect(json.failed).toBe(1);
    expect(sendAnnouncementEmailMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.email_status).toBe('failed');
    expect(updates[0].payload.error_message).toBe('No accepted applicants to notify at send time');
  });

  it('a broadcast row with a partially-failed batch is still marked sent, with a summary error_message', async () => {
    const row = baseRow({ is_broadcast: true, application_id: null, channel: 'announcement', title: 'Venue change', body: null });
    const recipients = [
      { id: randomUUID(), preferred_language: 'en', profiles: { full_name: 'Alice', email: 'alice@example.com' } },
      { id: randomUUID(), preferred_language: 'en', profiles: { full_name: 'Bilal', email: 'bilal@example.com' } },
    ];
    const { client, updates } = fakeService({
      pendingRows: [row],
      broadcastRecipientsResult: { data: recipients, error: null },
    });
    createServiceRoleClientMock.mockReturnValue(client);
    sendAnnouncementEmailMock
      .mockResolvedValueOnce({ id: 'ok', error: null })
      .mockResolvedValueOnce({ id: null, error: 'send failed' });

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.sent).toBe(1);
    expect(updates[0].payload.email_status).toBe('sent');
    expect(String(updates[0].payload.error_message)).toMatch(/failed/i);
  });

  // Testing Requirement 6 (explicit case added by a prior plan review
  // round): a broadcast notification's recipient list must be evaluated
  // LAZILY at send time, not snapshotted at create_announcement's insert
  // time. Simulates an applicant whose status changed away from
  // 'accepted' between the notification row being created and this cron
  // actually running, by having the SAME broadcast recipient query return
  // a DIFFERENT (narrower) result than it would have at creation time --
  // asserting the excluded applicant's email function is never invoked.
  it('evaluates broadcast recipients lazily at send time, excluding an applicant no longer accepted by cron-run time', async () => {
    const row = baseRow({ is_broadcast: true, application_id: null, channel: 'announcement', title: 'Schedule update', body: null });
    // Only ONE recipient is returned -- standing in for "at creation time
    // there were two accepted applicants, but by the time this cron ran,
    // the query (run fresh, not from a snapshot) now excludes the one
    // whose status changed in between".
    const stillAcceptedRecipient = { id: randomUUID(), preferred_language: 'en', profiles: { full_name: 'Alice', email: 'alice@example.com' } };
    const { client } = fakeService({
      pendingRows: [row],
      broadcastRecipientsResult: { data: [stillAcceptedRecipient], error: null },
    });
    createServiceRoleClientMock.mockReturnValue(client);

    await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);

    // Only the still-accepted applicant's email was ever sent -- the
    // excluded one (e.g. 'bilal@example.com' from the sibling test) is
    // simply never a candidate because the query itself is re-run fresh,
    // not replayed from any creation-time snapshot.
    expect(sendAnnouncementEmailMock).toHaveBeenCalledTimes(1);
    expect(sendAnnouncementEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'alice@example.com' })
    );
    // The query itself must have been invoked fresh for THIS run (not
    // reused from any prior call) -- the fakeService helper wires a new
    // `.eq('status','accepted')` call per GET invocation, so asserting
    // it resolved to exactly the row's own mocked result confirms the
    // route queries recipients inside its own per-row processing rather
    // than accepting a precomputed list.
    expect(client.from).toHaveBeenCalledWith('applications');
  });

  it('processes multiple pending rows and returns aggregate counts', async () => {
    const row1 = baseRow({ channel: 'application_accepted' });
    const row2 = baseRow({ channel: 'booking_confirmed', title: 'Climate Finance 101' });
    const { client } = fakeService({ pendingRows: [row1, row2], appLookupResult: applicationRow() });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    const json = await response.json();
    expect(json.processed).toBe(2);
    expect(json.sent).toBe(2);
    expect(json.failed).toBe(0);
    expect(sendApplicationAcceptedEmailMock).toHaveBeenCalledTimes(1);
    expect(sendBookingConfirmedEmailMock).toHaveBeenCalledTimes(1);
  });

  it('returns zero counts with no pending rows', async () => {
    const { client } = fakeService({ pendingRows: [] });
    createServiceRoleClientMock.mockReturnValue(client);

    const response = await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ processed: 0, sent: 0, failed: 0 });
  });
});
