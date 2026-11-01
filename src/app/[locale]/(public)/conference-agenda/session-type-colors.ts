// Session-card color, by session_types.code — shared between page.tsx
// (the legend) and agenda-schedule.tsx (each card's left border), so the
// two can never drift apart. Matches the real colors already stored on
// tracks.color
// (supabase/migrations/20261027150000_seed_coy21_conference_days_and_tracks.sql:
// PLN #1F3864, CUL #8E7CC3, SDE #E69138, BRK #8C8C8C) rather than
// inventing a separate palette. REG has no tracks row of its own (it is a
// session_type, not a track — resolves to a null track_id), so it isn't
// in that table at all; uses the site's own turquoise (--color-blue-sky,
// #019de6) to match the brand identity instead of inventing an unrelated
// color.
export const SESSION_TYPE_COLORS: Record<string, string> = {
  REG: 'var(--color-blue-sky)',
  PLN: '#1F3864',
  CUL: '#8E7CC3',
  SDE: '#E69138',
  BRK: '#8C8C8C',
};

export const DEFAULT_SESSION_TYPE_COLOR = 'var(--color-turquoise)';
