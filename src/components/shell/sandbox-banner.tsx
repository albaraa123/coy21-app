// src/components/shell/sandbox-banner.tsx
//
// Persistent, full-width notice shown across every admin page while
// sandbox mode is on (Task 6). Rendered by (admin)/layout.tsx only —
// AppShell itself stays agnostic (see app-shell.tsx's `sandboxBanner`
// prop doc: it just renders whatever ReactNode it's handed, or nothing).
//
// Server component, same convention as
// src/components/schedule/status-banner.tsx: `getTranslations` +
// role="alert" + the codebase's established amber warning-banner
// classes (including dark-mode variants), rather than the plain
// hardcoded-English/no-dark-mode draft in the implementation plan.
import { getTranslations } from 'next-intl/server';

export async function SandboxBanner({ locale, recipientEmail }: { locale: string; recipientEmail: string | null }) {
  const t = await getTranslations({ locale, namespace: 'shell.sandboxBanner' });

  return (
    <div
      role="alert"
      className="w-full border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
    >
      {recipientEmail ? t('activeWithRecipient', { email: recipientEmail }) : t('activeWithoutRecipient')}
    </div>
  );
}
