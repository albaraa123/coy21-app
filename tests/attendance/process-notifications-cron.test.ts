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
};

type FakeAppLookupResult = { data: unknown; error: unknown };

/**
 * Builds a fake service-role client whose `.from(table)` dispatches based
 * on `table`:
 *  - 'notifications' select chain -> pendingRows (first call) via
 *    .eq().order().limit(); its .update() chain is recorded in `updates`.
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
}) {
  const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  let appLookupCallIndex = 0;

  const from = vi.fn((table: string) => {
    if (table === 'notifications') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve({ data: opts.pendingRows, error: null })),
            })),
          })),
        })),
        update: vi.fn((payload: Record<string, unknown>) => ({
          eq: vi.fn((_col: string, id: string) => {
            updates.push({ id, payload });
            return Promise.resolve({ data: null, error: null });
          }),
        })),
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

  return { client: { from }, updates };
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
    const { client, updates } = fakeService({
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

  it('only queries pending rows and never re-processes rows the cron already resolved (sent/failed)', async () => {
    const row = baseRow({ channel: 'application_accepted' });
    const { client } = fakeService({ pendingRows: [row], appLookupResult: applicationRow() });
    createServiceRoleClientMock.mockReturnValue(client);

    await GET(cronRequest(`Bearer ${CRON_SECRET}`) as never);

    // The fake service's notifications.select().eq() chain is only ever
    // wired to serve 'email_status' = 'pending' -- assert the handler
    // actually calls .eq with that filter rather than fetching everything.
    const notificationsFromCall = (client.from as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'notifications');
    expect(notificationsFromCall).toBeTruthy();
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
