// src/components/scanner/scan-feedback.test.ts
//
// Pure unit tests for the sound/haptic feedback module. jsdom-free (see
// device-identifier.test.ts's own precedent) — window/AudioContext/
// navigator are stubbed minimally. The core guarantee under test: these
// functions never throw, regardless of API availability, mute state, or
// mid-call failures — feedback must never be able to block the scan
// flow.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('scan-feedback', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value;
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { navigator?: unknown }).navigator;
    vi.unstubAllGlobals();
  });

  describe('isSoundMuted / setSoundMuted', () => {
    it('defaults to unmuted when nothing is persisted', async () => {
      const { isSoundMuted } = await import('./scan-feedback');
      expect(isSoundMuted()).toBe(false);
    });

    it('persists and reflects the muted preference', async () => {
      const { isSoundMuted, setSoundMuted } = await import('./scan-feedback');
      setSoundMuted(true);
      expect(isSoundMuted()).toBe(true);
      setSoundMuted(false);
      expect(isSoundMuted()).toBe(false);
    });

    it('never throws if localStorage is unavailable', async () => {
      (globalThis as unknown as { window: unknown }).window = {
        get localStorage(): never {
          throw new Error('localStorage disabled');
        },
      };
      const { isSoundMuted, setSoundMuted } = await import('./scan-feedback');
      expect(() => setSoundMuted(true)).not.toThrow();
      expect(isSoundMuted()).toBe(false);
    });
  });

  describe('playScanFeedbackSound', () => {
    it('does nothing when muted (no AudioContext access)', async () => {
      store['rcoy-scanner-sound-muted'] = 'true';
      let constructed = false;
      (globalThis as unknown as { window: Record<string, unknown> }).window.AudioContext = class {
        constructor() {
          constructed = true;
        }
      };
      const { playScanFeedbackSound } = await import('./scan-feedback');
      expect(() => playScanFeedbackSound('success')).not.toThrow();
      expect(constructed).toBe(false);
    });

    it('never throws when AudioContext is unsupported', async () => {
      const { playScanFeedbackSound } = await import('./scan-feedback');
      expect(() => playScanFeedbackSound('success')).not.toThrow();
      expect(() => playScanFeedbackSound('attention')).not.toThrow();
      expect(() => playScanFeedbackSound('denied')).not.toThrow();
    });

    it('never throws if AudioContext construction/oscillator calls fail mid-way', async () => {
      (globalThis as unknown as { window: Record<string, unknown> }).window.AudioContext = class {
        currentTime = 0;
        state = 'running';
        createOscillator() {
          throw new Error('boom');
        }
        createGain() {
          return { gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }, connect: () => {} };
        }
        destination = {};
      };
      const { playScanFeedbackSound } = await import('./scan-feedback');
      expect(() => playScanFeedbackSound('success')).not.toThrow();
    });
  });

  describe('triggerScanFeedbackHaptic', () => {
    it('never throws when navigator.vibrate is unavailable', async () => {
      const { triggerScanFeedbackHaptic } = await import('./scan-feedback');
      expect(() => triggerScanFeedbackHaptic('success')).not.toThrow();
    });

    it('calls navigator.vibrate with a pattern when available', async () => {
      const vibrate = vi.fn();
      vi.stubGlobal('navigator', { vibrate });
      const { triggerScanFeedbackHaptic } = await import('./scan-feedback');
      triggerScanFeedbackHaptic('denied');
      expect(vibrate).toHaveBeenCalledWith([80, 40, 80]);
    });

    it('never throws if navigator.vibrate itself throws', async () => {
      vi.stubGlobal('navigator', {
        vibrate: () => {
          throw new Error('boom');
        },
      });
      const { triggerScanFeedbackHaptic } = await import('./scan-feedback');
      expect(() => triggerScanFeedbackHaptic('success')).not.toThrow();
    });
  });
});
