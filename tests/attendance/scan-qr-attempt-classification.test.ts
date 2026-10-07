// tests/attendance/scan-qr-attempt-classification.test.ts
//
// Pure classification-logic coverage for scanQrAttemptConfirmForCaller
// (src/lib/attendance/scan-qr-attempt.ts), per spec Testing Requirements
// 10 and 11 (docs/superpowers/specs/2026-10-06-offline-scanning-support-
// design.md). These two requirements need a test that calls the REAL
// ...ForCaller with a MOCKED `service` client underneath it — not a test
// that mocks ...ForCaller itself away (that belongs to the Route Handler
// test file, tests/api/scan-qr-attempt-route.test.ts, which cannot
// exercise this classification logic at all since it never reaches the
// real function body).
//
// Distinct from tests/attendance/scan-qr-attempt-server-boundary.test.ts,
// which drives the real function against the live disposable Supabase
// project to prove end-to-end authorization/parsing/contract behavior —
// this file only proves the error-classification branches that a live
// run cannot easily force (a genuinely transport-shaped error code, or
// the RPC's own LOCK_CONTENTION-prefixed P0001).
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { scanQrAttemptConfirmForCaller } from '@/lib/attendance/scan-qr-attempt';

describe('scanQrAttemptConfirmForCaller — classification logic (mocked service client)', () => {
  it('10. a transport-shaped failure on verifyScannerScope\'s sessions query returns upstream-unreachable, retryable (not a false "not found")', async () => {
    const service = {
      from: vi.fn((table: string) => {
        if (table === 'sessions') {
          return {
            select: () => ({
              eq: () => ({
                // A transport-shaped failure: empty code, not PGRST116.
                single: () => Promise.resolve({ data: null, error: { code: '' } }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      }),
      rpc: vi.fn(),
    };

    const outcome = await scanQrAttemptConfirmForCaller(
      { qrPayload: 'not-a-real-qr-payload', sessionId: randomUUID(), deviceIdentifier: null },
      { userId: randomUUID(), service: service as never },
      randomUUID()
    );

    expect(outcome).toEqual({ ok: false, retryable: true, reason: 'upstream-unreachable' });
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it('10b. a transport-shaped failure on verifyScannerScope\'s scanner_assignments count query also returns upstream-unreachable, retryable', async () => {
    const service = {
      from: vi.fn((table: string) => {
        if (table === 'sessions') {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { id: 'session-1', room_id: 'room-1' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'scanner_assignments') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  or: () => Promise.resolve({ count: null, error: { code: '' } }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      }),
      rpc: vi.fn(),
    };

    const outcome = await scanQrAttemptConfirmForCaller(
      { qrPayload: 'not-a-real-qr-payload', sessionId: randomUUID(), deviceIdentifier: null },
      { userId: randomUUID(), service: service as never },
      randomUUID()
    );

    expect(outcome).toEqual({ ok: false, retryable: true, reason: 'upstream-unreachable' });
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it('11. a mocked RPC response with a LOCK_CONTENTION-prefixed P0001 error returns lock-contention, retryable', async () => {
    const service = {
      from: vi.fn((table: string) => {
        if (table === 'sessions') {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { id: 'session-1', room_id: 'room-1' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'scanner_assignments') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  or: () => Promise.resolve({ count: 1, error: null }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      }),
      rpc: vi.fn(() => Promise.resolve({ data: null, error: { code: 'P0001', message: 'LOCK_CONTENTION: advisory lock exhausted' } })),
    };

    const outcome = await scanQrAttemptConfirmForCaller(
      { qrPayload: 'not-a-real-qr-payload', sessionId: randomUUID(), deviceIdentifier: null },
      { userId: randomUUID(), service: service as never },
      randomUUID()
    );

    expect(outcome).toEqual({ ok: false, retryable: true, reason: 'lock-contention' });
  });

  it('a mocked RPC response with a plain (non-lock-contention) P0001 error returns non-retryable, surfacing the message', async () => {
    const service = {
      from: vi.fn((table: string) => {
        if (table === 'sessions') {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { id: 'session-1', room_id: 'room-1' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'scanner_assignments') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  or: () => Promise.resolve({ count: 1, error: null }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      }),
      rpc: vi.fn(() => Promise.resolve({ data: null, error: { code: 'P0001', message: 'idempotency key mismatch' } })),
    };

    const outcome = await scanQrAttemptConfirmForCaller(
      { qrPayload: 'not-a-real-qr-payload', sessionId: randomUUID(), deviceIdentifier: null },
      { userId: randomUUID(), service: service as never },
      randomUUID()
    );

    expect(outcome).toEqual({ ok: false, retryable: false, message: 'idempotency key mismatch' });
  });
});
