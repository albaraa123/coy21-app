// src/components/scanner/scan-feedback.ts
//
// Lightweight, best-effort sound + haptic feedback for scan results.
// Every function here is a pure side-effect trigger that NEVER throws and
// NEVER blocks the scan flow — a feedback failure (autoplay blocked, API
// unsupported, permissions revoked) must be indistinguishable from
// "feedback simply didn't fire" from the caller's perspective. No
// third-party audio/analytics service; sounds are synthesized in-browser
// via the Web Audio API (a few short oscillator tones), so there is no
// audio asset to fetch/host/license and no network dependency.
'use client';

export type FeedbackSeverity = 'success' | 'attention' | 'denied';

const MUTE_STORAGE_KEY = 'rcoy-scanner-sound-muted';

export function isSoundMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setSoundMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? 'true' : 'false');
  } catch {
    // Muting is a convenience preference only — silently no-op if
    // localStorage is unavailable, never throw back into the scan flow.
  }
}

// Lazily created and reused across calls — creating a new AudioContext
// per scan would leak resources and some browsers cap how many can
// exist. Must be created/resumed from a real user-gesture context on
// first use (browser autoplay policy — the same constraint documented in
// use-qr-scanner.ts for video.play()); the first scan is always
// triggered by a camera decode or a manual-entry tap, both downstream of
// an earlier real user gesture (granting camera permission / tapping
// into the page), so in practice the context is already unlocked by the
// time a tone needs to play.
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioContext) {
    try {
      audioContext = new Ctor();
    } catch {
      return null;
    }
  }
  return audioContext;
}

// Short, subtle, non-looping tones — one or two notes, well under half a
// second total, deliberately not loud/annoying (per the approved scope:
// "subtle, not loud/annoying; no continuous sounds").
const TONE_PLANS: Record<FeedbackSeverity, Array<{ freq: number; startOffsetMs: number; durationMs: number }>> = {
  success: [{ freq: 880, startOffsetMs: 0, durationMs: 140 }],
  attention: [
    { freq: 660, startOffsetMs: 0, durationMs: 100 },
    { freq: 660, startOffsetMs: 140, durationMs: 100 },
  ],
  denied: [{ freq: 220, startOffsetMs: 0, durationMs: 220 }],
};

/**
 * Plays a short synthesized tone for the given severity. Never throws;
 * any failure (unsupported API, suspended/blocked context, mid-call
 * error) is swallowed silently — sound is a pure enhancement, never a
 * gate on scan functionality.
 */
export function playScanFeedbackSound(severity: FeedbackSeverity): void {
  if (isSoundMuted()) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      // Best-effort resume; if this rejects (autoplay still blocked),
      // the tones below simply won't be audible — no error surfaces.
      void ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    for (const tone of TONE_PLANS[severity]) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = tone.freq;
      // Quick fade in/out to avoid an audible click at tone start/end.
      const start = now + tone.startOffsetMs / 1000;
      const end = start + tone.durationMs / 1000;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.15, start + 0.01);
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }
  } catch {
    // Sound failure must never block scanning — swallow everything.
  }
}

// Distinct, short vibration patterns per severity — progressive
// enhancement only, feature-detected, never a security/state signal.
// iOS Safari/Chrome do not support navigator.vibrate() at all as of this
// writing; the feature-detect below makes that a silent no-op there,
// which is explicitly acceptable per the approved scope.
const VIBRATION_PATTERNS: Record<FeedbackSeverity, number | number[]> = {
  success: 30,
  attention: [30, 60, 30],
  denied: [80, 40, 80],
};

export function triggerScanFeedbackHaptic(severity: FeedbackSeverity): void {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    navigator.vibrate(VIBRATION_PATTERNS[severity]);
  } catch {
    // Never block scanning on haptic failure.
  }
}
