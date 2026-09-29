import { describe, it, expect } from 'vitest';
import {
  sessionStatusTransitionSchema, SESSION_VALID_TRANSITIONS,
  weightSchema, checkinWindowSchema,
} from '@/lib/validation/agenda';

describe('SESSION_VALID_TRANSITIONS state machine', () => {
  it('draft can only go to published', () => {
    expect(SESSION_VALID_TRANSITIONS.draft).toEqual(expect.arrayContaining(['published']));
    expect(SESSION_VALID_TRANSITIONS.draft).not.toContain('confirmed');
    expect(SESSION_VALID_TRANSITIONS.draft).not.toContain('completed');
  });
  it('published can go to confirmed or cancelled', () => {
    expect(SESSION_VALID_TRANSITIONS.published).toEqual(expect.arrayContaining(['confirmed', 'cancelled']));
  });
  it('confirmed can go to completed or cancelled', () => {
    expect(SESSION_VALID_TRANSITIONS.confirmed).toEqual(expect.arrayContaining(['completed', 'cancelled']));
  });
  it('cancelled and completed are terminal', () => {
    expect(SESSION_VALID_TRANSITIONS.cancelled).toEqual([]);
    expect(SESSION_VALID_TRANSITIONS.completed).toEqual([]);
  });
  it('draft can also be cancelled directly', () => {
    expect(SESSION_VALID_TRANSITIONS.draft).toContain('cancelled');
  });
});

describe('sessionStatusTransitionSchema', () => {
  it('accepts a valid transition', () => {
    const result = sessionStatusTransitionSchema.safeParse({ from: 'draft', to: 'published' });
    expect(result.success).toBe(true);
  });
  it('rejects an invalid transition', () => {
    const result = sessionStatusTransitionSchema.safeParse({ from: 'draft', to: 'confirmed' });
    expect(result.success).toBe(false);
  });
  it('requires cancellation_reason when transitioning to cancelled', () => {
    const withoutReason = sessionStatusTransitionSchema.safeParse({ from: 'published', to: 'cancelled' });
    expect(withoutReason.success).toBe(false);
    const withReason = sessionStatusTransitionSchema.safeParse({ from: 'published', to: 'cancelled', cancellationReason: 'Speaker withdrew' });
    expect(withReason.success).toBe(true);
  });
});

describe('weightSchema', () => {
  it('accepts 0, 0.5, and 1', () => {
    expect(weightSchema.safeParse(0).success).toBe(true);
    expect(weightSchema.safeParse(0.5).success).toBe(true);
    expect(weightSchema.safeParse(1).success).toBe(true);
  });
  it('rejects negative and >1', () => {
    expect(weightSchema.safeParse(-0.1).success).toBe(false);
    expect(weightSchema.safeParse(1.1).success).toBe(false);
  });
});

describe('checkinWindowSchema', () => {
  it('accepts both null when QR check-in is disabled', () => {
    const result = checkinWindowSchema.safeParse({ enableQrCheckin: false, checkinOpensAt: null, checkinClosesAt: null });
    expect(result.success).toBe(true);
  });
  it('rejects enabled with a missing window', () => {
    const result = checkinWindowSchema.safeParse({ enableQrCheckin: true, checkinOpensAt: null, checkinClosesAt: null });
    expect(result.success).toBe(false);
  });
  it('rejects opens >= closes', () => {
    const now = new Date().toISOString();
    const result = checkinWindowSchema.safeParse({ enableQrCheckin: true, checkinOpensAt: now, checkinClosesAt: now });
    expect(result.success).toBe(false);
  });
  it('accepts a valid enabled window', () => {
    const opens = new Date(Date.now()).toISOString();
    const closes = new Date(Date.now() + 3600_000).toISOString();
    const result = checkinWindowSchema.safeParse({ enableQrCheckin: true, checkinOpensAt: opens, checkinClosesAt: closes });
    expect(result.success).toBe(true);
  });
  it('accepts opens without milliseconds and closes with milliseconds when opens is genuinely earlier (regression: string comparison bug)', () => {
    // '2026-01-01T10:00:00Z' < '2026-01-01T10:00:00.001Z' is false under plain
    // string comparison (Z sorts after '.'), even though 10:00:00.000 is
    // chronologically before 10:00:00.001. A Date-based comparison must accept this.
    const result = checkinWindowSchema.safeParse({
      enableQrCheckin: true,
      checkinOpensAt: '2026-01-01T10:00:00Z',
      checkinClosesAt: '2026-01-01T10:00:00.001Z',
    });
    expect(result.success).toBe(true);
  });
  it('rejects opens after closes even with mismatched fractional-second precision', () => {
    // Opens is genuinely later than closes here (10:00:01 > 10:00:00.999), so this
    // must still be rejected after switching to Date-based comparison.
    const result = checkinWindowSchema.safeParse({
      enableQrCheckin: true,
      checkinOpensAt: '2026-01-01T10:00:01Z',
      checkinClosesAt: '2026-01-01T10:00:00.999Z',
    });
    expect(result.success).toBe(false);
  });
});
