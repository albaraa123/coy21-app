'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { bookSession, cancelBooking } from './actions';

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
