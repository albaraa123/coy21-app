// src/lib/attendance/qr-image.ts
//
// Server-only QR image rendering. Deliberately server-side, not
// client-side: the browser receives only the final PNG data URI, never
// the raw canonical payload string as selectable/inspectable DOM text —
// minimizes where the plaintext bearer credential is ever represented as
// text rather than as pixels, on top of the existing rule that it must
// never be logged/persisted. Uses `qrcode` (the smallest well-known
// server-capable QR encoder in the npm ecosystem, no React/DOM
// dependency), the same library already used to generate the scannable
// test fixtures throughout Phase 7's own device testing.
import QRCode from 'qrcode';

/**
 * Renders the given payload as a high-contrast, generously-quiet-zoned
 * PNG data URI sized for a phone screen. High error-correction level
 * ('H') and an explicit quiet zone (`margin`) are both scan-reliability
 * requirements, not aesthetic choices — matches the exact settings this
 * codebase's own device-testing fixtures used successfully throughout
 * Phase 7C/7D/7E's real-device QR scans.
 */
export async function renderQrDataUri(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'H',
    margin: 4,
    width: 600,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });
}
