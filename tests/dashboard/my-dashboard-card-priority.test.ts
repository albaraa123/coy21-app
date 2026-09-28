import { describe, it, expect } from 'vitest';
import { computeDashboardCardOrder, type DashboardCardId } from '@/app/[locale]/(participant)/(shell)/my-dashboard/card-priority';

describe('computeDashboardCardOrder', () => {
  it('not-yet-accepted: application status first (large), program card dimmed/disabled', () => {
    const order = computeDashboardCardOrder({ applicationStatus: 'submitted', travelSubmitted: false, qrAvailable: false });
    expect(order[0]).toBe<DashboardCardId>('applicationStatus');
  });

  it('accepted, travel not submitted: travel-completion card first', () => {
    const order = computeDashboardCardOrder({ applicationStatus: 'accepted', travelSubmitted: false, qrAvailable: true });
    expect(order[0]).toBe<DashboardCardId>('completeTravelInfo');
  });

  it('accepted, travel complete, QR available: QR card first', () => {
    const order = computeDashboardCardOrder({ applicationStatus: 'accepted', travelSubmitted: true, qrAvailable: true });
    expect(order[0]).toBe<DashboardCardId>('myQr');
  });
});
