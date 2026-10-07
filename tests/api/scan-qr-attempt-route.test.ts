// tests/api/scan-qr-attempt-route.test.ts
//
// Unit coverage for the scan-qr-attempt Route Handler
// (src/app/api/scan-qr-attempt/route.ts), matching this codebase's real,
// confirmed convention for Route Handler tests (tests/api/resend-webhook.
// test.ts is the existing precedent, importing its handler function
// directly from @/app/api/...), NOT co-located under src/app/api/.
//
// Mocks scanQrAttemptConfirmForCaller AND requireScannerDeviceCaller
// (both — the route now owns the auth call) to drive every classified
// outcome and assert the handler's HTTP response. Per spec line 184, the
// retryable/non-retryable distinction lives in the JSON body, never the
// HTTP status — every classified outcome (success, retryable,
// non-retryable, including an UpstreamUnavailableError thrown by the
// mocked requireScannerDeviceCaller) must return HTTP 200 with the
// outcome as the JSON body.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { scanQrAttemptConfirmForCallerMock, requireScannerDeviceCallerMock } = vi.hoisted(() => ({
  scanQrAttemptConfirmForCallerMock: vi.fn(),
  requireScannerDeviceCallerMock: vi.fn(),
}));

vi.mock('@/lib/attendance/scan-qr-attempt', () => ({
  scanQrAttemptConfirmForCaller: scanQrAttemptConfirmForCallerMock,
}));

vi.mock('@/lib/scanner-device/server-helpers', () => ({
  requireScannerDeviceCaller: requireScannerDeviceCallerMock,
}));

import { POST } from '@/app/api/scan-qr-attempt/route';
import { UpstreamUnavailableError } from '@/lib/supabase/upstream-error';

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/scan-qr-attempt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = () => ({
  qrPayload: 'rcoy:v1:' + 'A'.repeat(43),
  sessionId: randomUUID(),
  deviceIdentifier: 'device-1',
  idempotencyKey: randomUUID(),
});

beforeEach(() => {
  vi.clearAllMocks();
  requireScannerDeviceCallerMock.mockResolvedValue({ userId: randomUUID(), service: {} });
});

describe('POST /api/scan-qr-attempt', () => {
  it('returns 200 with the success outcome in the JSON body', async () => {
    const successOutcome = { ok: true, result: { result: 'flexible_admitted', scanAttemptId: randomUUID(), attendanceId: randomUUID(), participantSummary: null } };
    scanQrAttemptConfirmForCallerMock.mockResolvedValue(successOutcome);

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(successOutcome);
  });

  it('returns 200 with a retryable (upstream-unreachable) outcome in the JSON body', async () => {
    const outcome = { ok: false, retryable: true, reason: 'upstream-unreachable' };
    scanQrAttemptConfirmForCallerMock.mockResolvedValue(outcome);

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(outcome);
  });

  it('returns 200 with a retryable (lock-contention) outcome in the JSON body', async () => {
    const outcome = { ok: false, retryable: true, reason: 'lock-contention' };
    scanQrAttemptConfirmForCallerMock.mockResolvedValue(outcome);

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(outcome);
  });

  it('returns 200 with a non-retryable outcome in the JSON body', async () => {
    const outcome = { ok: false, retryable: false, message: 'Not authorized for this session/room' };
    scanQrAttemptConfirmForCallerMock.mockResolvedValue(outcome);

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(outcome);
  });

  it('returns 200 retryable when requireScannerDeviceCaller throws UpstreamUnavailableError, without ever calling the RPC-delegating function', async () => {
    requireScannerDeviceCallerMock.mockRejectedValue(new UpstreamUnavailableError('profiles lookup failed transiently'));

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, retryable: true, reason: 'upstream-unreachable' });
    expect(scanQrAttemptConfirmForCallerMock).not.toHaveBeenCalled();
  });

  it('returns 200 non-retryable when requireScannerDeviceCaller throws a genuine denial (plain Error), without ever calling the RPC-delegating function', async () => {
    requireScannerDeviceCallerMock.mockRejectedValue(new Error('Not authorized'));

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ ok: false, retryable: false, message: 'Not authorized' });
    expect(scanQrAttemptConfirmForCallerMock).not.toHaveBeenCalled();
  });

  it('returns 200 non-retryable for malformed JSON body, never throwing an uncaught 500', async () => {
    const response = await POST(jsonRequest('{not-valid-json'));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.retryable).toBe(false);
  });

  it('returns 200 non-retryable when required fields are missing from the body', async () => {
    const response = await POST(jsonRequest({ qrPayload: 'x' }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ ok: false, retryable: false, message: 'Invalid request' });
    expect(requireScannerDeviceCallerMock).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID sessionId before any auth/RPC call', async () => {
    const response = await POST(jsonRequest({ ...validBody(), sessionId: 'not-a-uuid' }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ ok: false, retryable: false, message: 'Invalid request' });
    expect(requireScannerDeviceCallerMock).not.toHaveBeenCalled();
    expect(scanQrAttemptConfirmForCallerMock).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID idempotencyKey before any auth/RPC call', async () => {
    const response = await POST(jsonRequest({ ...validBody(), idempotencyKey: 'not-a-uuid' }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ ok: false, retryable: false, message: 'Invalid request' });
    expect(requireScannerDeviceCallerMock).not.toHaveBeenCalled();
    expect(scanQrAttemptConfirmForCallerMock).not.toHaveBeenCalled();
  });

  it('forwards the idempotencyKey from the request body through to scanQrAttemptConfirmForCaller', async () => {
    scanQrAttemptConfirmForCallerMock.mockResolvedValue({ ok: false, retryable: false, message: 'irrelevant' });
    const body = validBody();

    await POST(jsonRequest(body));

    expect(scanQrAttemptConfirmForCallerMock).toHaveBeenCalledWith(
      { qrPayload: body.qrPayload, sessionId: body.sessionId, deviceIdentifier: body.deviceIdentifier },
      expect.anything(),
      body.idempotencyKey
    );
  });

  it('returns 200 non-retryable if scanQrAttemptConfirmForCaller itself throws unexpectedly', async () => {
    scanQrAttemptConfirmForCallerMock.mockRejectedValue(new Error('boom'));

    const response = await POST(jsonRequest(validBody()));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ ok: false, retryable: false, message: 'Unexpected error' });
  });
});
