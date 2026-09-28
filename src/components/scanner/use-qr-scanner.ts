// src/components/scanner/use-qr-scanner.ts
//
// Thin React wrapper around qr-scanner (nimiq/qr-scanner) — the browser's
// ONLY job is capturing a decoded QR payload string; canonical parsing/
// hashing/validation stays entirely server-side
// (src/lib/attendance/qr-token-crypto.ts, called from
// src/lib/attendance/scan-qr-attempt.ts). This hook never inspects or
// validates the decoded string's shape — that would duplicate the
// canonical parser client-side, which the approved Phase 7C scope
// explicitly forbids.
//
// Decoding runs in qr-scanner's own Web Worker (or BarcodeDetector where
// natively available) — off the main thread, per the mobile-performance
// requirement to avoid unnecessary rerenders/main-thread work during
// camera frames. This hook itself never re-renders per frame: onDecode
// fires a plain callback, not state, on every decoded frame; the caller
// (scanner-client.tsx) is responsible for its own debounce/lock via
// scanStateReducer so identical repeated frames don't cause repeated
// callback-driven work.
import { useCallback, useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';

export type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'active'
  | 'permission_denied'
  | 'unavailable'
  | 'error';

export function useQrScanner(onDecode: (payload: string) => void) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');

  // Phase 7E — qr-scanner registers its OWN document-level
  // visibilitychange listener internally (verified by reading
  // node_modules/qr-scanner/qr-scanner.min.js's _onVisibilityChange):
  // on hide it calls this.pause() (video.pause() + track kept alive,
  // NOT track.stop()); on visible again it calls this.start() itself,
  // which resumes the SAME already-authorized stream via video.play()
  // on the existing srcObject rather than requesting a new
  // getUserMedia() stream. That is a materially different case from
  // the Phase 7C bug (constructing a brand-new QrScanner/stream after a
  // FULL stop() had released the track), and resuming playback on an
  // already-granted stream is not gated by the same strict
  // user-gesture requirement a fresh getUserMedia() prompt would be.
  // Deliberately NOT adding a second, competing visibilitychange
  // listener here — the library already owns this responsibility, and
  // wiring a second one that also calls start()/stop() while the
  // instance's own internal _paused/_active flags disagree with ours
  // would risk exactly the double-instance class of bug Phase 7C fixed.
  // Confirmed on real-device regression, see Phase 7E report.

  // Keep the latest onDecode in a ref so the QrScanner instance (created
  // once) always calls the current callback without needing to be
  // recreated whenever the caller's closure changes.
  const onDecodeRef = useRef(onDecode);
  useEffect(() => {
    onDecodeRef.current = onDecode;
  }, [onDecode]);

  const start = useCallback(async () => {
    if (!videoRef.current) return;

    // If a scanner instance from a previous start() is still around (e.g.
    // resuming after stop() paused decoding for a submission, or after
    // Scan Next Participant), reuse it via its own start() rather than
    // constructing a second instance on top of the same <video> element
    // — qr-scanner's start()/stop() pair is designed to be called
    // repeatedly on one instance; layering a second instance was the bug
    // that required a manual page refresh to recover the camera.
    if (scannerRef.current) {
      try {
        await scannerRef.current.start();
        setStatus('active');
        return;
      } catch {
        // Fall through and rebuild a fresh instance below if resuming
        // the existing one failed for any reason.
        scannerRef.current.destroy();
        scannerRef.current = null;
      }
    }

    setStatus('requesting');

    const hasCamera = await QrScanner.hasCamera().catch(() => false);
    if (!hasCamera) {
      setStatus('unavailable');
      return;
    }

    try {
      const scanner = new QrScanner(
        videoRef.current,
        (result) => onDecodeRef.current(result.data),
        {
          preferredCamera: 'environment',
          highlightScanRegion: true,
          highlightCodeOutline: true,
          // qr-scanner's own default max scan rate is already reasonable;
          // no explicit maxScansPerSecond override — the scan-state
          // reducer (not the camera library) is what actually prevents
          // duplicate submissions, so no need to fight the decoder here.
        }
      );
      scannerRef.current = scanner;
      await scanner.start();
      setStatus('active');
    } catch (err) {
      // qr-scanner surfaces both "permission denied" and "no camera
      // found" as thrown errors from start() in practice (in addition to
      // the hasCamera() pre-check above, which can be a false positive
      // on some browsers) — inspect the error name/message to distinguish
      // an explicit permission denial from any other failure. Widened to
      // cover iOS's system-level camera-permission revocation (Settings
      // -> [Browser] -> Camera -> off): confirmed on real-device testing
      // that this does NOT always surface as a standard
      // NotAllowedError/DOMException the way an in-page getUserMedia
      // permission-prompt denial does — some engines report it as a
      // more generic error whose name/message don't contain "permission"
      // at all, which previously fell through to the generic 'error'
      // status instead of the more accurate 'permission_denied' one.
      const name = err instanceof Error ? err.name : '';
      const message = err instanceof Error ? err.message : String(err);
      const isPermissionIssue =
        name === 'NotAllowedError' ||
        name === 'SecurityError' ||
        name === 'PermissionDeniedError' ||
        /permission/i.test(message) ||
        /denied/i.test(message) ||
        /not allowed/i.test(message);
      const isNoCameraIssue =
        name === 'NotFoundError' || name === 'DevicesNotFoundError' || /no camera/i.test(message) || /not found/i.test(message);
      if (isPermissionIssue) {
        setStatus('permission_denied');
      } else if (isNoCameraIssue) {
        setStatus('unavailable');
      } else {
        setStatus('error');
      }
    }
  }, []);

  const stop = useCallback(() => {
    scannerRef.current?.stop();
  }, []);

  const destroy = useCallback(() => {
    scannerRef.current?.destroy();
    scannerRef.current = null;
  }, []);

  // Clean shutdown on unmount / route change — releases the camera
  // stream so it never keeps running after the scanner page is left.
  useEffect(() => {
    return () => {
      destroy();
    };
  }, [destroy]);

  return { videoRef, status, start, stop, destroy };
}
