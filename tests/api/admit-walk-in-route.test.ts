// tests/api/admit-walk-in-route.test.ts
//
// Unit coverage for the walk-in admission Route Handler
// (src/app/api/admit-walk-in/route.ts), mirroring Task 3's
// scan-qr-attempt-route.test.ts structure but for the walk-in outcome
// shape ({ ok: true, bookingId } | { ok: false, retryable, message }).
// Per the design spec's Walk-In Admin Page section, this handler uses
// the exact same three-layer classification scheme as the scanner's
// Route Handler, so every classified outcome (success, retryable,
// non-retryable, including an UpstreamUnavailableError thrown by the
// mocked requireAdmissionStaffCaller) must return HTTP 200 with the
// outcome as the JSON body.
//
// Mocks requireAdmissionStaffCaller (the auth boundary) and the
// `service`/`session` clients it returns, so this test can drive the
// identifier-lookup branches (accepted/ambiguous/not-found/transport-
// failure) and the RPC call's own outcome independently, without a real
// Supabase project.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAdmissionStaffCallerMock } = vi.hoisted(() => ({
  requireAdmissionStaffCallerMock: vi.fn(),
}));

vi.mock('@/lib/admission/server-helpers', () => ({
  requireAdmissionStaffCaller: requireAdmissionStaffCallerMock,
}));

import { POST } from '@/app/api/admit-walk-in/route';
import { UpstreamUnavailableError } from '@/lib/supabase/upstream-error';

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/admit-walk-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const sessionId = randomUUID();
const idempotencyKey = randomUUID();
const validBody = () => ({
  identifier: 'APP-00123',
  sessionId,
  idempotencyKey,
});

// Builds a fake `service` client whose `.from('applications').select().or().limit()`
// chain resolves to the given { data, error }.
function fakeService(lookupResult: { data: unknown; error: unknown }) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        or: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(lookupResult)),
        })),
      })),
    })),
  };
}

function fakeSession(rpcResult: { data: unknown; error: unknown }) {
  return {
    rpc: vi.fn(() => Promise.resolve(rpcResult)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/admit-walk-in', () => {
  it('returns 200 with the bookingId in the JSON body on success', async () => {
    const applicationId = randomUUID();
    const bookingId = randomUUID();
    requireAdmissionStaffCallerMock.mockResolvedValue({
      userId: randomUUID(),
      service: fakeService({ data: [{ id: applicationId, status: 'accepted' }], error: null }),
      session: fakeSession({ data: bookingId, error: null }),
    });

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, bookingId });
  });

  it('returns 200 retryable (upstream-unreachable) when requireAdmissionStaffCaller throws UpstreamUnavailableError', async () => {
    requireAdmissionStaffCallerMock.mockRejectedValue(new UpstreamUnavailableError('profiles lookup failed transiently'));

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, retryable: true, message: 'Upstream unavailable' });
  });

  it('returns 200 non-retryable when requireAdmissionStaffCaller throws a genuine denial (plain Error)', async () => {
    requireAdmissionStaffCallerMock.mockRejectedValue(new Error('Not authorized'));

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, retryable: false, message: 'Not authorized' });
  });

  it('returns 200 retryable (upstream-unreachable) when the identifier-lookup query itself fails (transport-shaped error)', async () => {
    requireAdmissionStaffCallerMock.mockResolvedValue({
      userId: randomUUID(),
      service: fakeService({ data: null, error: { code: '' } }),
      session: fakeSession({ data: null, error: null }),
    });

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, retryable: true, message: 'Upstream unavailable' });
  });

  it('returns 200 non-retryable when no accepted application matches the identifier', async () => {
    requireAdmissionStaffCallerMock.mockResolvedValue({
      userId: randomUUID(),
      service: fakeService({ data: [], error: null }),
      session: fakeSession({ data: null, error: null }),
    });

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.retryable).toBe(false);
    expect(json.message).toMatch(/No accepted application/);
  });

  it('returns 200 non-retryable when multiple accepted applications match the identifier', async () => {
    requireAdmissionStaffCallerMock.mockResolvedValue({
      userId: randomUUID(),
      service: fakeService({
        data: [
          { id: randomUUID(), status: 'accepted' },
          { id: randomUUID(), status: 'accepted' },
        ],
        error: null,
      }),
      session: fakeSession({ data: null, error: null }),
    });

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.retryable).toBe(false);
    expect(json.message).toMatch(/Multiple accepted applications/);
  });

  it('returns 200 non-retryable when the RPC call itself raises a deterministic error', async () => {
    requireAdmissionStaffCallerMock.mockResolvedValue({
      userId: randomUUID(),
      service: fakeService({ data: [{ id: randomUUID(), status: 'accepted' }], error: null }),
      session: fakeSession({ data: null, error: { code: 'P0001', message: 'This participant already has a booking for this session' } }),
    });

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      retryable: false,
      message: 'This participant already has a booking for this session',
    });
  });

  it('returns 200 retryable when the RPC call itself fails transiently', async () => {
    requireAdmissionStaffCallerMock.mockResolvedValue({
      userId: randomUUID(),
      service: fakeService({ data: [{ id: randomUUID(), status: 'accepted' }], error: null }),
      session: fakeSession({ data: null, error: { code: '57014' } }),
    });

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, retryable: true, message: 'Upstream unavailable' });
  });

  it('calls the RPC through the session client, never the service client', async () => {
    const applicationId = randomUUID();
    const bookingId = randomUUID();
    const service = fakeService({ data: [{ id: applicationId, status: 'accepted' }], error: null });
    const session = fakeSession({ data: bookingId, error: null });
    requireAdmissionStaffCallerMock.mockResolvedValue({ userId: randomUUID(), service, session });
    // Service client has no rpc() at all in this mock -- if the handler
    // tried to call service.rpc(...), this would throw a TypeError.
    expect((service as unknown as { rpc?: unknown }).rpc).toBeUndefined();

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    expect(session.rpc).toHaveBeenCalledWith('admit_walk_in', {
      p_application_id: applicationId,
      p_session_id: sessionId,
      p_idempotency_key: idempotencyKey,
    });
  });

  it('returns 200 non-retryable for malformed JSON body, never throwing an uncaught 500', async () => {
    const response = await POST(jsonRequest('{not-valid-json'));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.retryable).toBe(false);
  });

  it('returns 200 non-retryable when required fields are missing from the body', async () => {
    const response = await POST(jsonRequest({ identifier: 'x' }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ ok: false, retryable: false, message: 'Invalid request' });
    expect(requireAdmissionStaffCallerMock).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID sessionId before any auth/RPC call', async () => {
    const response = await POST(jsonRequest({ ...validBody(), sessionId: 'not-a-uuid' }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ ok: false, retryable: false, message: 'Invalid request' });
    expect(requireAdmissionStaffCallerMock).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID idempotencyKey before any auth/RPC call', async () => {
    const response = await POST(jsonRequest({ ...validBody(), idempotencyKey: 'not-a-uuid' }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ ok: false, retryable: false, message: 'Invalid request' });
    expect(requireAdmissionStaffCallerMock).not.toHaveBeenCalled();
  });

  it('rejects an empty/blank identifier before any auth/RPC call', async () => {
    const response = await POST(jsonRequest({ ...validBody(), identifier: '   ' }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.retryable).toBe(false);
    expect(requireAdmissionStaffCallerMock).not.toHaveBeenCalled();
  });

  it('returns 200 non-retryable if the identifier-lookup query itself throws unexpectedly (not just rejects with an error object)', async () => {
    requireAdmissionStaffCallerMock.mockResolvedValue({
      userId: randomUUID(),
      service: {
        from: vi.fn(() => {
          throw new Error('boom');
        }),
      },
      session: fakeSession({ data: null, error: null }),
    });

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ ok: false, retryable: false, message: 'Unexpected error' });
  });
});
