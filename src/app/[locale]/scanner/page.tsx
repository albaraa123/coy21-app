// src/app/[locale]/scanner/page.tsx
//
// Phase 7B — Scanner Operational Shell & Assignment Context. Establishes
// authenticated scanner -> authorized assignment -> current session ->
// room/session context -> scanner-ready state, per the approved scope.
// Explicitly does NOT implement camera decoding (Phase 7C) or QR
// submission (reuses the Phase 7A trusted server action only where a
// future phase wires it up).
//
// Authorization is NOT duplicated here: this page performs the exact
// same checks src/lib/scanner-device/server-helpers.ts's
// requireScannerDeviceCaller already does (auth.getUser() +
// isScannerDeviceRole(profile.role)) rather than reusing that helper
// directly, because requireScannerDeviceCaller throws (designed for a
// 'use server' action's error-propagation contract) where this page
// needs a renderable state instead — same distinction (admin)/layout.tsx
// draws between its own decideAdminAccess (renders UnauthorizedState)
// and each page's own throwing re-check. The single source of truth for
// "which roles count as scanner_device" remains isScannerDeviceRole
// (src/lib/validation/scanner-device.ts) — imported directly, not
// reimplemented.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isScannerDeviceRole } from '@/lib/validation/scanner-device';
import { loadScannerAssignmentContext } from '@/lib/attendance/scanner-assignment-context';
import { SessionSwitcher } from '@/components/scanner/session-switcher';
import { ErrorState } from '@/components/states/error-state';

export default async function ScannerPage() {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: 'scanner' });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile, error: profileError } = await service.from('profiles').select('role, full_name').eq('id', user.id).maybeSingle();

  if (profileError) {
    return (
      <ErrorState
        title={t('states.error.title')}
        description={t('states.error.description')}
      />
    );
  }

  if (!isScannerDeviceRole(profile?.role)) {
    return (
      <ErrorState title={t('states.unauthorized.title')} description={t('states.unauthorized.description')} />
    );
  }

  const context = await loadScannerAssignmentContext(service, user.id);

  if (context.kind === 'no_assignment') {
    return <ErrorState title={t('states.noAssignment.title')} description={t('states.noAssignment.description')} />;
  }

  if (context.kind === 'session_unavailable') {
    return <ErrorState title={t('states.sessionUnavailable.title')} description={t('states.sessionUnavailable.description')} />;
  }

  // Ready state — one or more confirmed sessions this device may scan
  // for right now. Phase 9.1: when more than one session is ready,
  // SessionSwitcher renders a picker and lets the operator choose which
  // session the camera submits against; with exactly one ready session
  // it renders no picker at all (same visual result as before this
  // change). See session-switcher.tsx's own header comment for why
  // switching sessions can never bypass authorization.
  const displayName = profile?.full_name || user.email || '';

  return (
    <div className="flex flex-col gap-4">
      <div className="text-center">
        <p className="text-xs text-charcoal/60 dark:text-gray-400">
          {t('signedInAs')} <span className="font-medium text-charcoal dark:text-gray-200">{displayName}</span>
        </p>
      </div>

      <SessionSwitcher sessions={context.sessions} locale={locale} />
    </div>
  );
}
