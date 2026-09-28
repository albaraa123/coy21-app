// src/components/scanner/install-guidance.tsx
//
// Phase 7E — lightweight, dismissible "Add to Home Screen" guidance.
// Never forces a native install prompt (Android's beforeinstallprompt
// is only ever shown on an explicit tap of the button this renders,
// never auto-triggered); iOS has no programmatic install API at all,
// so that path is copy-only instructions. Dismissal is remembered so
// the hint doesn't reappear every session — the scanner remains fully
// usable in ordinary browser tabs whether or not this is ever acted on.
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { detectInstallPlatform, type InstallPlatform } from './install-platform';

const DISMISS_KEY = 'rcoy-scanner-install-hint-dismissed';

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS Safari's own non-standard flag; matchMedia is the standards-
  // track signal everywhere else (including installed Android Chrome).
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
}

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, 'true');
  } catch {
    // Non-critical preference — fine to silently no-op.
  }
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

export function InstallGuidance() {
  const t = useTranslations('scanner.install');
  const [platform, setPlatform] = useState<InstallPlatform>('other');
  const [dismissed, setDismissed] = useState(true);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    setPlatform(detectInstallPlatform(typeof navigator === 'undefined' ? undefined : navigator.userAgent));
    setDismissed(readDismissed() || isStandalone());

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  const handleDismiss = useCallback(() => {
    writeDismissed();
    setDismissed(true);
  }, []);

  const handleInstallClick = useCallback(() => {
    if (!deferredPrompt) return;
    // Only ever fires from this direct click — never auto-invoked.
    void deferredPrompt.prompt().finally(() => setDeferredPrompt(null));
  }, [deferredPrompt]);

  if (dismissed) return null;
  if (platform === 'other' && !deferredPrompt) return null;

  return (
    <div className="flex w-full items-start gap-2 rounded-md border border-turquoise/30 bg-turquoise/10 px-3 py-2 text-xs text-charcoal dark:border-turquoise/20 dark:bg-turquoise/5 dark:text-gray-200">
      <p className="flex-1">{platform === 'ios' ? t('iosInstructions') : t('androidInstructions')}</p>
      <div className="flex shrink-0 items-center gap-2">
        {deferredPrompt && (
          <button type="button" onClick={handleInstallClick} className="font-semibold text-turquoise-dark underline dark:text-turquoise">
            {t('installAction')}
          </button>
        )}
        <button type="button" onClick={handleDismiss} aria-label={t('dismiss')} className="text-charcoal/50 hover:text-charcoal dark:text-gray-500">
          &times;
        </button>
      </div>
    </div>
  );
}
