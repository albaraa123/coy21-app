import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRef } from 'react';
import { mockIntlLink } from '../support/mock-intl-link';

// Same SSR-markup approach as tests/components/shell/mobile-drawer.test.tsx
// (renderToStaticMarkup, environment: 'node', no jsdom): these assertions
// cover structural rendering (open/closed markup, ARIA attributes, which
// data is displayed, disabled state of the submit button as a function of
// props) — anything requiring real typing/click simulation is instead
// covered by publish-confirmation-logic.test.ts's pure-function tests,
// per this repo's established split (see that file's and
// mobile-drawer-logic.ts's doc comments).

vi.mock('@/i18n/routing', () => mockIntlLink());
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => {
    const dict: Record<string, string> = {
      requiredPhrase: 'PUBLISH',
      title: 'Final confirmation required',
      irreversibleWarning: 'This is the last step before publication. Once confirmed, this action cannot be undone through the platform.',
      affectedParticipants: 'Affected participants',
      draftReference: 'Draft / source reference',
      supersedeWarning: 'The currently published schedules for these participants will be superseded immediately.',
      noUndo: 'This action cannot be undone through the platform.',
      typePrompt: 'Type {phrase} to confirm',
      matchConfirmed: 'Confirmation phrase matches.',
      matchPending: 'Does not match yet — check spelling and capitalization.',
      cancel: 'Cancel',
      confirm: 'Publish',
      submitting: 'Publishing...',
    };
    return (key: string, vars?: Record<string, string>) => {
      let value = dict[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) value = value.replace(`{${k}}`, v);
      }
      return value;
    };
  },
}));

import { PublishConfirmationDialog } from '@/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/publish-confirmation-dialog';

function renderDialog(overrides: Partial<Parameters<typeof PublishConfirmationDialog>[0]> = {}) {
  const triggerRef = createRef<HTMLButtonElement>();
  const props = {
    open: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    triggerRef,
    canConfirm: true,
    submitting: false,
    affectedParticipantCount: 12,
    draftReference: 'fp-abc123',
    ...overrides,
  };
  const html = renderToStaticMarkup(<PublishConfirmationDialog {...props} />);
  return { html, props };
}

describe('PublishConfirmationDialog (SSR markup)', () => {
  it('renders nothing when closed', () => {
    const { html } = renderDialog({ open: false });
    expect(html).toBe('');
  });

  it('opens with correct dialog semantics: role=dialog, aria-modal=true, labelled, and described by the warning copy', () => {
    const { html } = renderDialog();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="publish-confirmation-title"');
    expect(html).toContain('aria-describedby="publish-confirmation-warning"');
    expect(html).toContain('id="publish-confirmation-warning"');
  });

  it('renders a warning icon next to the title for extra visual escalation beyond the inline red Card', () => {
    const { html } = renderDialog();
    expect(html).toContain('<svg');
  });

  it('displays the affected participant count and draft reference', () => {
    const { html } = renderDialog({ affectedParticipantCount: 42, draftReference: 'fp-xyz789' });
    expect(html).toContain('42');
    expect(html).toContain('fp-xyz789');
  });

  it('displays the supersede warning and the cannot-be-undone statement', () => {
    const { html } = renderDialog();
    expect(html).toContain('superseded');
    expect(html).toContain('cannot be undone through the platform');
  });

  it('displays the required typed phrase as a prompt (sourced from i18n, not hardcoded)', () => {
    const { html } = renderDialog();
    expect(html).toContain('PUBLISH');
  });

  it('renders the confirm button disabled when canConfirm is false (blockers not resolved / ack missing)', () => {
    const { html } = renderDialog({ canConfirm: false });
    // Two buttons render: Cancel (always enabled unless submitting) and
    // Publish (disabled here). Assert a disabled button exists.
    expect(html).toContain('disabled=""');
  });

  it('renders the confirm button disabled while submitting, and shows the busy label', () => {
    const { html } = renderDialog({ submitting: true });
    expect(html).toContain('disabled=""');
    expect(html).toContain('Publishing...');
  });

  it('renders the input and both action buttons when open', () => {
    const { html } = renderDialog();
    expect(html).toContain('id="publish-confirmation-input"');
    expect(html).toContain('Cancel');
    expect(html).toContain('Publish');
  });

  it('does not show inline match/mismatch feedback before anything is typed (uncontrolled input has no value prop passed here, so this covers the default empty state)', () => {
    const { html } = renderDialog();
    expect(html).not.toContain('Confirmation phrase matches.');
    expect(html).not.toContain('Does not match yet');
  });
});
