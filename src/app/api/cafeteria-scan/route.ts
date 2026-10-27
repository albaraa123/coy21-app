// src/app/api/cafeteria-scan/route.ts
//
// Thin Route Handler boundary — performs requireScannerDeviceCaller auth
// first, then delegates to confirmCafeteriaLunchScanForCaller
// (src/lib/cafeteria/lunch-scan.ts), which is unit-testable without a
// request context. Mirrors src/app/api/scan-qr-attempt/route.ts's shape.
// Always responds 200 with an { ok, ... } body — the retryable/
// non-retryable distinction (and client/server failure classification)
// lives in the body, never the HTTP status, matching this codebase's
// existing scan-route convention.
import { NextResponse } from 'next/server';
import { confirmCafeteriaLunchScanForCaller } from '@/lib/cafeteria/lunch-scan';
import { requireScannerDeviceCaller } from '@/lib/scanner-device/server-helpers';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { qrPayload } = body ?? {};
    if (typeof qrPayload !== 'string') {
      return NextResponse.json({ ok: false, message: 'Invalid request' }, { status: 200 });
    }

    let caller;
    try {
      caller = await requireScannerDeviceCaller();
    } catch (err) {
      return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : 'Not authorized' }, { status: 200 });
    }

    const outcome = await confirmCafeteriaLunchScanForCaller({ qrPayload }, caller);
    return NextResponse.json(outcome, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, message: 'Unexpected error' }, { status: 200 });
  }
}
