'use client';

// src/app/[locale]/(participant)/(shell)/my-application/confirmation-card.tsx
//
// Participant attendance confirmation UI — shown only for accepted applications.
// Two-tap flow: "Yes, I'll be there" or "I cannot attend".
// Optimistic update: the button text changes immediately on click, then the
// server action confirms. Error shown inline if the action fails.

import { useState, useTransition } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { updateAttendanceConfirmation, type ConfirmationStatus } from './actions';

type Props = {
  initialStatus: 'confirmed' | 'not_confirmed' | 'declined';
};

export function ConfirmationCard({ initialStatus }: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [pendingStatus, setPendingStatus] = useState<ConfirmationStatus | null>(null);

  function handleConfirm(newStatus: ConfirmationStatus) {
    setPendingStatus(newStatus);
    setError(null);
    startTransition(async () => {
      const result = await updateAttendanceConfirmation(newStatus);
      if (result.error) {
        setError(result.error);
        setPendingStatus(null);
      } else {
        setStatus(newStatus);
        setPendingStatus(null);
      }
    });
  }

  if (status === 'confirmed') {
    return (
      <Card className="border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950">
        <p className="text-sm font-medium text-green-800 dark:text-green-300">
          ✓ You have confirmed your attendance at COY21 Antalya.
        </p>
        <button
          onClick={() => handleConfirm('declined')}
          disabled={isPending}
          className="mt-2 text-xs text-charcoal/50 underline hover:text-charcoal/70 dark:text-gray-500"
        >
          I can no longer attend
        </button>
      </Card>
    );
  }

  if (status === 'declined') {
    return (
      <Card className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950">
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
          You indicated you cannot attend COY21.
        </p>
        <Button
          onClick={() => handleConfirm('confirmed')}
          disabled={isPending}
          className="mt-3"
        >
          {isPending && pendingStatus === 'confirmed' ? 'Updating…' : 'I changed my mind — I will attend'}
        </Button>
      </Card>
    );
  }

  // not_confirmed
  return (
    <Card>
      <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">
        Will you attend COY21 in Antalya?
      </h2>
      <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
        Please confirm so the organizing team can prepare for your arrival.
      </p>
      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Button
          onClick={() => handleConfirm('confirmed')}
          disabled={isPending}
          className="flex-1"
        >
          {isPending && pendingStatus === 'confirmed' ? 'Confirming…' : "Yes, I'll be there"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => handleConfirm('declined')}
          disabled={isPending}
          className="flex-1"
        >
          {isPending && pendingStatus === 'declined' ? 'Updating…' : 'I cannot attend'}
        </Button>
      </div>
    </Card>
  );
}
