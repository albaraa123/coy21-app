// src/app/[locale]/(participant)/(welcome)/layout.tsx
//
// A third sibling route group under (participant), alongside (shell) and
// (bare) -- see (bare)/layout.tsx's own header comment for the full
// explanation of why Next.js layout nesting follows filesystem position,
// not route group name: this file wraps ONLY welcome/, exactly like
// (shell) wraps only my-dashboard/my-agenda/etc. and (bare) wraps only
// claim/register/change-password.
//
// A full-width wrapper, not (bare)'s narrow max-w-md card -- that layout
// was built for short login-style forms; an 8-slide walkthrough needs the
// whole screen. No auth check here (same reasoning as (bare)/layout.tsx):
// welcome/page.tsx does its own getUser() check and redirect.
export default function ParticipantWelcomeLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-warm-white dark:bg-gray-950">{children}</div>;
}
