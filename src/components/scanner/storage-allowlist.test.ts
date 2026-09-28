// src/components/scanner/storage-allowlist.test.ts
//
// Static-analysis guard for the Phase 7E storage-security requirement:
// every localStorage/sessionStorage key literal used anywhere under
// src/components/scanner/ must be one of the three allow-listed,
// non-sensitive preferences. This is deliberately a source-scanning
// test (not a runtime one) — its whole point is to catch a FUTURE
// change that introduces a new storage key (e.g. someone tempted to
// cache a QR payload or participant summary for "convenience") before
// it ships, not just to verify today's three known keys behave
// correctly.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCANNER_DIR = join(__dirname);

const ALLOWED_KEYS = ['rcoy-scanner-device-id', 'rcoy-scanner-sound-muted', 'rcoy-scanner-install-hint-dismissed'];

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return collectSourceFiles(join(dir, entry.name));
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) return [];
    return [join(dir, entry.name)];
  });
}

describe('scanner storage allow-list', () => {
  const files = collectSourceFiles(SCANNER_DIR);

  it('found at least one source file to scan (sanity check the scan itself is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every localStorage/sessionStorage key literal is on the allow-list', () => {
    const keyLiteralPattern = /(?:localStorage|sessionStorage)\.(?:get|set|remove)Item\(\s*['"]([^'"]+)['"]/g;
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(keyLiteralPattern)) {
        const key = match[1];
        if (!ALLOWED_KEYS.includes(key)) {
          offenders.push(`${file}: "${key}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
