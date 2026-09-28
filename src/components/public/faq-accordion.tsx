/**
 * Minimal accessible accordion for the public FAQ page.
 *
 * No accordion primitive exists in package.json (checked: only
 * @hookform/resolvers, react-hook-form, zod, etc. — no Radix/Headless UI/
 * any disclosure-widget library), so per the task brief this is a small
 * hand-built implementation rather than a new dependency.
 *
 * a11y: each trigger is a real <button> (native keyboard support — Enter
 * and Space both activate a button with no extra key handling needed),
 * wired with aria-expanded reflecting open state and aria-controls
 * pointing at the matching panel id; each panel carries a matching id and
 * role="region" + aria-labelledby pointing back at its trigger, so the
 * relationship is announced in both directions. Multiple entries may be
 * open at once (independent state per item) rather than force-collapsing
 * others — nothing in the design spec calls for single-open-only
 * behavior, and independent state is the simpler, less surprising default
 * for a FAQ list.
 */
'use client';

import { useId, useState } from 'react';

export interface FaqEntry {
  /** Stable identity for React's list key — independent of question text,
   *  which could theoretically collide or change wording later. */
  id: string;
  question: string;
  answer: string;
}

function FaqItem({ entry, defaultOpen = false }: { entry: FaqEntry; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const panelId = `${baseId}-panel`;

  return (
    <div className="border-b border-charcoal/10 py-2">
      <h3>
        <button
          type="button"
          id={triggerId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between gap-4 rounded-md px-2 py-3 text-start text-sm font-medium text-charcoal transition-colors hover:bg-charcoal/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise"
        >
          <span>{entry.question}</span>
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 text-charcoal/60 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </h3>
      <div
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        hidden={!open}
        className="px-2 pb-3 pt-1 text-sm text-charcoal/70"
      >
        {entry.answer}
      </div>
    </div>
  );
}

export function FaqAccordion({ entries }: { entries: FaqEntry[] }) {
  return (
    <div className="divide-y divide-charcoal/10">
      {entries.map((entry) => (
        <FaqItem key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
