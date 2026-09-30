// tests/email/send-guarded-routing-live.test.ts
//
// Static verification (not a live-DB test despite the file suffix
// convention — "live" here means "checks real repo file contents," not
// "hits a live Supabase project") that every email-sending call site in
// src/ routes through sendEmailGuarded rather than constructing its own
// Resend client. See docs/superpowers/specs/2026-09-30-email-sandbox-mode-design.md's
// Testing section for why the webhook route is explicitly excluded.
//
// Scope: this only scans src/, not tests/. Every real send call site lives
// under src/; test files legitimately mock `new Resend(...)` (e.g.
// tests/email/resend-send.test.ts's vi.mock('resend', ...) shim) and would
// be false positives if swept. Do not widen walk() to include tests/.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const EXCLUDED_FILES = [
  'src/lib/email/send-guarded.ts', // the guard itself, legitimately constructs Resend
  'src/app/api/webhooks/resend/route.ts', // signature verification only, never sends
];

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

describe('every email send call site routes through sendEmailGuarded', () => {
  it('no file outside the excluded list constructs its own Resend client or calls .emails.send() directly', () => {
    const violations: string[] = [];
    for (const file of walk('src')) {
      const relative = file.replace(/\\/g, '/');
      if (EXCLUDED_FILES.some((excluded) => relative.endsWith(excluded))) continue;
      const content = readFileSync(file, 'utf-8');
      if (/new Resend\(/.test(content) || /\.emails\.send\(/.test(content)) {
        violations.push(relative);
      }
    }
    expect(violations).toEqual([]);
  });
});
