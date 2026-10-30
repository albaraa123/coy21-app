'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { bookSession, cancelBooking, joinWaitlist, leaveWaitlist } from './actions';

// ---------------------------------------------------------------------------
// BookButton — shown on the browse page next to each session
// ---------------------------------------------------------------------------
type BookButtonProps = {
  sessionId: string;
  isFull: boolean;
  isPastDeadline: boolean;
  // Compact rendering: a plain, small-footprint text button instead of the
  // full <Button size="sm"> (which carries px-3/py-1.5 padding plus its own
  // min line-height -- comfortably 32px+ tall on its own, before any
  // wrapping container padding). Added for the agenda time-grid's blocks
  // (browse/page.tsx), which can be as short as ~20px (a 15-minute slot at
  // MINUTE_HEIGHT_PX=1.6) -- the roomy card-era button does not fit there.
  // Defaults to false so every other existing caller (there are none today,
  // but this keeps the change additive/non-breaking) renders exactly as
  // before.
  compact?: boolean;
  // Text color for `compact` rendering, since a compact block sits
  // directly on an arbitrary track color (the agenda grid) rather than a
  // fixed page background -- white text fails contrast on several real
  // track colors (see readable-text-color.ts). AgendaTimeGrid computes
  // this per-block via pickReadableTextColor and forwards it through
  // renderBlock; defaults to white (the original hardcoded value) so this
  // stays non-breaking for any future non-grid caller that never passes
  // it. Ignored entirely when compact is false.
  compactTextColor?: string;
};

export function BookButton({ sessionId, isFull, isPastDeadline, compact = false, compactTextColor = '#ffffff' }: BookButtonProps) {
  const [booked, setBooked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (booked) {
    return compact ? (
      <span className="text-[10px] font-medium" style={{ color: compactTextColor }}>
        Booked ✓
      </span>
    ) : (
      <span className="text-sm font-medium text-green-600 dark:text-green-400">Booked ✓</span>
    );
  }

  if (isPastDeadline) {
    return compact ? (
      <span className="text-[10px]" style={{ color: compactTextColor, opacity: 0.7 }}>
        Closed
      </span>
    ) : (
      <span className="text-xs text-charcoal/40 dark:text-gray-500">Closed</span>
    );
  }

  if (isFull) {
    return compact ? (
      <span className="text-[10px]" style={{ color: compactTextColor, opacity: 0.7 }}>
        Full
      </span>
    ) : (
      <span className="rounded-full bg-charcoal/10 px-2 py-0.5 text-xs text-charcoal/50 dark:bg-white/10 dark:text-gray-400">Full</span>
    );
  }

  if (compact) {
    return (
      <button
        type="button"
        disabled={isPending}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setError(null);
          startTransition(async () => {
            const result = await bookSession(sessionId);
            if (result.error) setError(result.error);
            else setBooked(true);
          });
        }}
        className="text-[10px] font-semibold underline underline-offset-1 disabled:opacity-60"
        style={{ color: compactTextColor, textDecorationColor: `color-mix(in srgb, ${compactTextColor} 60%, transparent)` }}
      >
        {isPending ? 'Booking…' : error ? 'Retry' : 'Book'}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={isPending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await bookSession(sessionId);
            if (result.error) setError(result.error);
            else setBooked(true);
          });
        }}
      >
        {isPending ? 'Booking…' : 'Book'}
      </Button>
      {error && <p className="max-w-[160px] text-right text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CancelButton — shown on my-agenda next to each booked session
// ---------------------------------------------------------------------------
type CancelButtonProps = {
  bookingId: string;
  isPastDeadline: boolean;
  onCancelled: () => void;
};

export function CancelButton({ bookingId, isPastDeadline, onCancelled }: CancelButtonProps) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (isPastDeadline) {
    return <span className="text-xs text-charcoal/40 dark:text-gray-500">Deadline passed</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        disabled={isPending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await cancelBooking(bookingId);
            if (result.error) setError(result.error);
            else onCancelled();
          });
        }}
        className="text-xs text-charcoal/50 underline hover:text-red-600 disabled:opacity-50 dark:text-gray-500"
      >
        {isPending ? 'Cancelling…' : 'Cancel'}
      </button>
      {error && <p className="max-w-[160px] text-right text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WaitlistButton — shown on the browse page (and my-agenda) for full,
// waitlist-enabled sessions; toggles between "Join waitlist" and the
// "On waitlist" / "Leave waitlist" state.
// ---------------------------------------------------------------------------
type WaitlistButtonProps = {
  sessionId: string;
  isWaitlisted: boolean;
  // Gates only the "not yet waitlisted" (Join waitlist) branch below --
  // mirrors BookButton's isPastDeadline check/rendering above. join_waitlist
  // rejects a past-deadline join server-side, so without this guard a caller
  // that ever passes isWaitlisted={false} on a past-deadline session would
  // render a live-looking "Join waitlist" button guaranteed to fail on
  // click. Deliberately NOT applied to the "already waitlisted" (Leave
  // waitlist) branch -- leave_waitlist has no deadline check (withdrawing
  // must always be allowed); see the matching comment in browse/page.tsx.
  isPastDeadline: boolean;
  // Called after a successful leave, in addition to this component's own
  // internal state flip. Needed on my-agenda, where this component is
  // reused purely for its already-waitlisted branch (see page.tsx) --
  // without this, a successful leave would locally flip to the
  // "Join waitlist" branch while staying rendered under a stale
  // "Waitlisted" badge in a row that should have disappeared entirely,
  // mirroring the onCancelled callback CancelButton already uses for the
  // same reason (AgendaDay filters cancelled bookings out of view).
  // Optional: the browse page's "not yet waitlisted" usage has no row to
  // remove, so it has no need to pass this.
  onLeft?: () => void;
  // See BookButton's `compact` doc above -- same rationale, same prop name,
  // same default (false, non-breaking for the existing waitlisted-sessions.tsx
  // caller).
  compact?: boolean;
  // See BookButton's `compactTextColor` doc above -- same rationale, same
  // default (white), ignored when compact is false.
  compactTextColor?: string;
};

export function WaitlistButton({
  sessionId,
  isWaitlisted: initialWaitlisted,
  isPastDeadline,
  onLeft,
  compact = false,
  compactTextColor = '#ffffff',
}: WaitlistButtonProps) {
  const [waitlisted, setWaitlisted] = useState(initialWaitlisted);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (waitlisted) {
    if (compact) {
      return (
        <button
          type="button"
          disabled={isPending}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setError(null);
            startTransition(async () => {
              const result = await leaveWaitlist(sessionId);
              if (result.error) setError(result.error);
              else if (onLeft) onLeft();
              else setWaitlisted(false);
            });
          }}
          className="text-[10px] font-semibold underline underline-offset-1 disabled:opacity-60"
          style={{ color: compactTextColor, textDecorationColor: `color-mix(in srgb, ${compactTextColor} 60%, transparent)` }}
        >
          {isPending ? 'Leaving…' : error ? 'Retry' : 'On waitlist ✕'}
        </button>
      );
    }
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-sm font-medium text-turquoise dark:text-blue-300">On waitlist</span>
        <button
          disabled={isPending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await leaveWaitlist(sessionId);
              if (result.error) setError(result.error);
              else if (onLeft) onLeft();
              else setWaitlisted(false);
            });
          }}
          className="text-xs text-charcoal/50 underline hover:text-red-600 disabled:opacity-50 dark:text-gray-500"
        >
          {isPending ? 'Leaving…' : 'Leave waitlist'}
        </button>
        {error && <p className="max-w-[160px] text-right text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  if (isPastDeadline) {
    return compact ? (
      <span className="text-[10px]" style={{ color: compactTextColor, opacity: 0.7 }}>
        Closed
      </span>
    ) : (
      <span className="text-xs text-charcoal/40 dark:text-gray-500">Closed</span>
    );
  }

  if (compact) {
    return (
      <button
        type="button"
        disabled={isPending}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setError(null);
          startTransition(async () => {
            const result = await joinWaitlist(sessionId);
            if (result.error) setError(result.error);
            else setWaitlisted(true);
          });
        }}
        className="text-[10px] font-semibold underline underline-offset-1 disabled:opacity-60"
        style={{ color: compactTextColor, textDecorationColor: `color-mix(in srgb, ${compactTextColor} 60%, transparent)` }}
      >
        {isPending ? 'Joining…' : error ? 'Retry' : 'Join waitlist'}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={isPending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await joinWaitlist(sessionId);
            if (result.error) setError(result.error);
            else setWaitlisted(true);
          });
        }}
      >
        {isPending ? 'Joining…' : 'Join waitlist'}
      </Button>
      {error && <p className="max-w-[160px] text-right text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
