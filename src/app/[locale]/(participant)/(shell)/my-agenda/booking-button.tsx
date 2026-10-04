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
};

export function BookButton({ sessionId, isFull, isPastDeadline }: BookButtonProps) {
  const [booked, setBooked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (booked) {
    return <span className="text-sm font-medium text-green-600 dark:text-green-400">Booked ✓</span>;
  }

  if (isPastDeadline) {
    return <span className="text-xs text-charcoal/40 dark:text-gray-500">Closed</span>;
  }

  if (isFull) {
    return (
      <span className="rounded-full bg-charcoal/10 px-2 py-0.5 text-xs text-charcoal/50 dark:bg-white/10 dark:text-gray-400">
        Full
      </span>
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
};

export function WaitlistButton({ sessionId, isWaitlisted: initialWaitlisted, onLeft }: WaitlistButtonProps) {
  const [waitlisted, setWaitlisted] = useState(initialWaitlisted);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (waitlisted) {
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
