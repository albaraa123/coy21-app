// src/app/api/cafeteria-coffee-balance/route.ts
//
// Thin Route Handler, mirrors src/app/api/cafeteria-scan/route.ts's
// shape exactly.
import { NextResponse } from 'next/server';
import { checkCafeteriaCoffeeBalanceForCaller } from '@/lib/cafeteria/coffee-scan';
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

    const outcome = await checkCafeteriaCoffeeBalanceForCaller({ qrPayload }, caller);
    return NextResponse.json(outcome, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, message: 'Unexpected error' }, { status: 200 });
  }
}
