import type { ReactNode } from 'react';

type BadgeVariant = 'mandatory' | 'elective' | 'cancelled' | 'sessionCancelled' | 'waitlisted' | 'changed' | 'pending' | 'neutral' | 'noShow';

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  // Solid gold fill: required/urgent.
  mandatory: 'bg-gold text-charcoal font-semibold dark:bg-amber-900/40 dark:text-amber-200',
  // Muted charcoal fill: default/no special status.
  elective: 'bg-charcoal/10 text-charcoal dark:bg-gray-800 dark:text-gray-300',
  // Muted charcoal, low opacity text + strikethrough: no longer relevant.
  cancelled: 'bg-charcoal/10 text-charcoal/60 line-through dark:bg-red-900/40 dark:text-red-200',
  // Solid red fill, no strikethrough: distinct from `cancelled` above --
  // this marks a participant's own booking as cancelled BY STAFF (the
  // session itself was cancelled), which needs to read as an active
  // warning the participant should notice, not a muted/no-longer-relevant
  // list item. Occupies the same slot a "Cancel" action button would, so
  // it needs equivalent visual weight, not a de-emphasized treatment.
  sessionCancelled: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  // Turquoise outline only (no fill): awaiting action like `pending`, but
  // kept visually distinct since it sits next to a "Leave waitlist" action
  // rather than a passive status.
  waitlisted: 'border border-turquoise text-turquoise bg-transparent dark:border-blue-400 dark:text-blue-300',
  // Solid turquoise fill: content has changed, draws the eye.
  changed: 'bg-turquoise text-white font-semibold dark:bg-blue-900/40 dark:text-blue-200',
  // Gold outline only (no fill): awaiting action, same hue family as
  // mandatory but a distinct outline-vs-fill treatment.
  pending: 'border border-gold text-charcoal bg-transparent dark:border-amber-700 dark:text-amber-200',
  // Charcoal outline only (no fill), lower emphasis than elective's fill.
  neutral: 'border border-charcoal/30 text-charcoal/70 bg-transparent dark:border-gray-600 dark:text-gray-400',
  // Muted amber fill, no strikethrough: informational/past-tense like
  // `cancelled`, not an action-required warning like `sessionCancelled` --
  // the participant didn't act, the system marked it after the fact. No
  // strikethrough because the booking still represents something genuinely
  // scheduled and attended-but-missed, not voided. Amber (not red, which is
  // reserved for `sessionCancelled`'s staff-initiated warning) and a
  // distinct fill from `cancelled` so "I cancelled this" reads differently
  // from "I didn't show up to this" at a glance. Dark-mode values are
  // deliberately lower-contrast/desaturated relative to `mandatory`'s dark
  // treatment (bg-amber-900/40, text-amber-200) -- same amber hue family,
  // but `mandatory` needs to read as urgent/required while `noShow` needs
  // to read as muted/past-tense, so this stays visually quieter.
  noShow: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-400/80',
};

export function Badge({ variant, children }: { variant: BadgeVariant; children: ReactNode }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${VARIANT_CLASSES[variant]}`}>
      {children}
    </span>
  );
}
