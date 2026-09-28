// src/components/scanner/device-identifier.test.ts
//
// Pure unit tests for getOrCreateDeviceIdentifier — jsdom-free (this
// project has no @testing-library/jsdom dependency), so `window` is
// stubbed minimally via a plain object assigned to globalThis.window
// rather than a real DOM environment.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getOrCreateDeviceIdentifier', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    // Minimal localStorage stand-in — only the two methods this module
    // actually calls.
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value;
        },
      },
    };
    // globalThis.crypto is a read-only native getter in Node — stub it
    // rather than assign directly.
    vi.stubGlobal('crypto', { randomUUID: () => 'generated-uuid-1234' });
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.unstubAllGlobals();
  });

  it('generates and persists a new id on first call', async () => {
    const { getOrCreateDeviceIdentifier } = await import('./device-identifier');
    const id = getOrCreateDeviceIdentifier();
    expect(id).toBe('generated-uuid-1234');
    expect(store['rcoy-scanner-device-id']).toBe('generated-uuid-1234');
  });

  it('reuses the existing persisted id on subsequent calls, never generating a new one', async () => {
    store['rcoy-scanner-device-id'] = 'already-there';
    const { getOrCreateDeviceIdentifier } = await import('./device-identifier');
    const id = getOrCreateDeviceIdentifier();
    expect(id).toBe('already-there');
  });

  it('falls back to null (never throws) if localStorage is unavailable', async () => {
    (globalThis as unknown as { window: unknown }).window = {
      get localStorage(): never {
        throw new Error('localStorage disabled');
      },
    };
    const { getOrCreateDeviceIdentifier } = await import('./device-identifier');
    expect(() => getOrCreateDeviceIdentifier()).not.toThrow();
    expect(getOrCreateDeviceIdentifier()).toBeNull();
  });
});
