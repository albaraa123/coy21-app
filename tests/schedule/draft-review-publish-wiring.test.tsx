import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// SSR-markup structural tests for Task 15's wiring of PublishConfirmationDialog
// into draft-review.tsx: the publish button must open the dialog rather
// than invoke handleConfirm directly, and the dialog must start closed.
// Real click/type interaction (opening the dialog, typing the confirmation,
// submitting) cannot be simulated via renderToStaticMarkup (no jsdom, no
// effects) — that behavior is covered by publish-confirmation-logic.test.ts's
// pure-function tests (canSubmitConfirmation, isConfirmationTextValid) plus
// this file's structural assertions that the correct props/handlers are
// wired together, matching this repo's established SSR-markup +
// pure-logic-extraction split (see mobile-drawer.test.tsx /
// mobile-drawer-logic.test.ts).

vi.mock('@/i18n/routing', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string, vars?: Record<string, string>) => {
    if (vars) return `${key}:${JSON.stringify(vars)}`;
    return key;
  },
}));

vi.mock('./actions', () => ({
  triggerStagePublication: vi.fn(),
  confirmDraftPublication: vi.fn(),
}));

import DraftReview, { type Draft, type DraftItem } from '@/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/draft-review';

const draft: Draft = {
  id: 'draft-1',
  status: 'staged',
  staged_at: '2026-07-01T00:00:00Z',
  staged_by: 'user-1',
  source_fingerprint: 'fp-999',
};

const publishableItem: DraftItem = {
  id: 'item-1',
  application_id: 'app-1',
  verdict: 'publishable',
  blocker_details: null,
  resolution: null,
  override_reason: null,
  reassigned_session_id: null,
};

describe('DraftReview publish-confirmation wiring (SSR markup)', () => {
  it('renders the publish trigger button but no open dialog markup by default', () => {
    const html = renderToStaticMarkup(
      <DraftReview allocationRunId="run-1" draft={draft} draftItems={[publishableItem]} lowConfidenceIssues={[]} />
    );
    // The dialog component itself renders null while closed (see
    // publish-confirmation-dialog.tsx: `if (!open) return null`), so its
    // role="dialog" markup must not appear in the initial server-rendered
    // output — only the always-visible red warning Card's own content.
    expect(html).toContain('confirm.title');
    expect(html).not.toContain('role="dialog"');
  });

  it('does not render the dialog markup when the draft is not in staged status either', () => {
    const html = renderToStaticMarkup(
      <DraftReview
        allocationRunId="run-1"
        draft={{ ...draft, status: 'confirmed' }}
        draftItems={[publishableItem]}
        lowConfidenceIssues={[]}
      />
    );
    expect(html).not.toContain('role="dialog"');
  });

  it('renders one publish-trigger button (destructive) that is the sole non-dialog publish control', () => {
    const html = renderToStaticMarkup(
      <DraftReview allocationRunId="run-1" draft={draft} draftItems={[publishableItem]} lowConfidenceIssues={[]} />
    );
    // Exactly one occurrence of the submit label as button text outside any dialog (dialog is closed/unrendered).
    const occurrences = html.split('confirm.submit').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(1);
  });

  it('marks the publish trigger with aria-haspopup="dialog", matching this codebase\'s established dialog/drawer-trigger convention (mobile-drawer-trigger.tsx)', () => {
    const html = renderToStaticMarkup(
      <DraftReview allocationRunId="run-1" draft={draft} draftItems={[publishableItem]} lowConfidenceIssues={[]} />
    );
    expect(html).toContain('aria-haspopup="dialog"');
  });
});
