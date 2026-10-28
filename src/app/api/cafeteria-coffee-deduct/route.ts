// src/app/api/cafeteria-coffee-deduct/route.ts
import { NextResponse } from 'next/server';
import { confirmCafeteriaCoffeeDeductionForCaller } from '@/lib/cafeteria/coffee-scan';
import { requireScannerDeviceCaller } from '@/lib/scanner-device/server-helpers';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { qrPayload, amount } = body ?? {};
    if (typeof qrPayload !== 'string' || typeof amount !== 'number') {
      return NextResponse.json({ ok: false, message: 'Invalid request' }, { status: 200 });
    }

    let caller;
    try {
      caller = await requireScannerDeviceCaller();
    } catch (err) {
      return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : 'Not authorized' }, { status: 200 });
    }

    const outcome = await confirmCafeteriaCoffeeDeductionForCaller({ qrPayload, amount }, caller);
    return NextResponse.json(outcome, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, message: 'Unexpected error' }, { status: 200 });
  }
}
