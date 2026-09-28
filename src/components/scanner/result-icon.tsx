// src/components/scanner/result-icon.tsx
//
// Severity icon for the scanner result screen. Icons are DECORATIVE
// (aria-hidden) — the accessible name comes from the adjacent headline
// text (role="status" on the h2 in scanner-client.tsx), matching the
// "icons decorative or labeled correctly" accessibility requirement:
// this icon never carries meaning on its own, it reinforces text that
// already exists. No icon library dependency (none exists in this
// codebase — see scanner-viewport.tsx's own inline-SVG precedent);
// three small hand-drawn SVGs match that established convention.
import type { ResultSeverity } from './result-presentation';

const SEVERITY_COLOR_CLASSES: Record<ResultSeverity, string> = {
  success: 'text-turquoise-dark dark:text-turquoise',
  attention: 'text-amber-600 dark:text-amber-400',
  denied: 'text-red-700 dark:text-red-400',
};

export function ResultIcon({ severity }: { severity: ResultSeverity }) {
  const className = `h-14 w-14 ${SEVERITY_COLOR_CLASSES[severity]}`;

  if (severity === 'success') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="12" cy="12" r="10" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 12.5l2.5 2.5L16 9.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (severity === 'attention') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M12 3.5L21.5 20h-19L12 3.5z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 10v4" strokeLinecap="round" />
        <circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" strokeLinecap="round" />
    </svg>
  );
}
