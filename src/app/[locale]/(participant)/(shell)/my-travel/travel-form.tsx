'use client';

import { useState, useTransition } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { saveTravelLeg, deleteTravelLeg, type TravelLegInput } from './actions';
import type { Database } from '@/types/database';

type LegType = Database['public']['Enums']['travel_leg_type'];
type Leg = Database['public']['Tables']['travel_legs']['Row'];

const LEG_LABELS: Record<LegType, string> = {
  outbound: 'Outbound (to Antalya)',
  return: 'Return (from Antalya)',
  connecting: 'Connecting flight',
};

const EMPTY_FORM: TravelLegInput = {
  leg_type: 'outbound',
  flight_number: '',
  departure_airport: '',
  arrival_airport: '',
  departure_datetime: '',
  arrival_datetime: '',
  notes: '',
};

type Props = { initialLegs: Leg[] };

export function TravelForm({ initialLegs }: Props) {
  const [legs, setLegs] = useState<Leg[]>(initialLegs);
  const [editing, setEditing] = useState<string | null>(null); // leg id or 'new'
  const [form, setForm] = useState<TravelLegInput>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function openNew() {
    setForm(EMPTY_FORM);
    setEditing('new');
    setError(null);
  }

  function openEdit(leg: Leg) {
    setForm({
      leg_type: leg.leg_type,
      flight_number: leg.flight_number ?? '',
      departure_airport: leg.departure_airport ?? '',
      arrival_airport: leg.arrival_airport ?? '',
      departure_datetime: leg.departure_datetime ? leg.departure_datetime.slice(0, 16) : '',
      arrival_datetime: leg.arrival_datetime ? leg.arrival_datetime.slice(0, 16) : '',
      notes: leg.notes ?? '',
    });
    setEditing(leg.id);
    setError(null);
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await saveTravelLeg(editing === 'new' ? null : editing, form);
      if (result.error) { setError(result.error); return; }
      // Refresh by reloading the page — simple, avoids stale closure issues
      window.location.reload();
    });
  }

  function handleDelete(legId: string) {
    startTransition(async () => {
      const result = await deleteTravelLeg(legId);
      if (result.error) { setError(result.error); return; }
      setLegs((prev) => prev.filter((l) => l.id !== legId));
    });
  }

  function field(label: string, key: keyof TravelLegInput, type = 'text') {
    return (
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-charcoal/70 dark:text-gray-400">{label}</span>
        <input
          type={type}
          value={form[key] as string}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          className="rounded-md border border-charcoal/20 bg-white px-3 py-2 text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-charcoal/30 dark:border-white/20 dark:bg-white/5 dark:text-gray-100"
        />
      </label>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Existing legs */}
      {legs.length === 0 && editing === null && (
        <p className="text-sm text-charcoal/50 dark:text-gray-500">
          No flight legs added yet. Add your itinerary below.
        </p>
      )}

      {legs.map((leg) =>
        editing === leg.id ? (
          <LegEditCard
            key={leg.id}
            form={form}
            setForm={setForm}
            onSave={handleSave}
            onCancel={() => setEditing(null)}
            isPending={isPending}
            error={error}
            field={field}
          />
        ) : (
          <Card key={leg.id} className="flex flex-row items-start gap-3 py-3">
            <div className="flex flex-1 flex-col gap-0.5">
              <p className="text-sm font-medium text-charcoal dark:text-gray-100">
                {LEG_LABELS[leg.leg_type]}
                {leg.flight_number ? ` · ${leg.flight_number}` : ''}
              </p>
              {(leg.departure_airport || leg.arrival_airport) && (
                <p className="text-xs text-charcoal/60 dark:text-gray-400">
                  {leg.departure_airport ?? '?'} → {leg.arrival_airport ?? '?'}
                </p>
              )}
              {leg.arrival_datetime && (
                <p className="text-xs text-charcoal/50 dark:text-gray-500">
                  Arrives: {new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Istanbul' }).format(new Date(leg.arrival_datetime))}
                </p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={() => openEdit(leg)}
                className="text-xs text-charcoal/50 underline hover:text-charcoal dark:text-gray-500"
              >
                Edit
              </button>
              <button
                onClick={() => handleDelete(leg.id)}
                disabled={isPending}
                className="text-xs text-red-500 underline hover:text-red-700 disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          </Card>
        )
      )}

      {/* New leg form */}
      {editing === 'new' ? (
        <LegEditCard
          form={form}
          setForm={setForm}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
          isPending={isPending}
          error={error}
          field={field}
        />
      ) : (
        <Button variant="secondary" size="sm" onClick={openNew} className="self-start">
          + Add flight leg
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline edit card (shared between new and edit modes)
// ---------------------------------------------------------------------------
type EditCardProps = {
  form: TravelLegInput;
  setForm: React.Dispatch<React.SetStateAction<TravelLegInput>>;
  onSave: () => void;
  onCancel: () => void;
  isPending: boolean;
  error: string | null;
  field: (label: string, key: keyof TravelLegInput, type?: string) => React.ReactNode;
};

function LegEditCard({ form, setForm, onSave, onCancel, isPending, error, field }: EditCardProps) {
  return (
    <Card className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-charcoal/70 dark:text-gray-400">Leg type</span>
        <select
          value={form.leg_type}
          onChange={(e) => setForm((f) => ({ ...f, leg_type: e.target.value as LegType }))}
          className="rounded-md border border-charcoal/20 bg-white px-3 py-2 text-sm text-charcoal focus:outline-none dark:border-white/20 dark:bg-white/5 dark:text-gray-100"
        >
          <option value="outbound">Outbound (to Antalya)</option>
          <option value="return">Return (from Antalya)</option>
          <option value="connecting">Connecting flight</option>
        </select>
      </label>
      {field('Flight number', 'flight_number')}
      <div className="grid grid-cols-2 gap-3">
        {field('From (airport)', 'departure_airport')}
        {field('To (airport)', 'arrival_airport')}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {field('Departure date & time', 'departure_datetime', 'datetime-local')}
        {field('Arrival date & time', 'arrival_datetime', 'datetime-local')}
      </div>
      {field('Notes (optional)', 'notes')}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={onSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
