import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Structural coverage for Task 6 Step 3's shell exception: claim/ and
// register/ (served via (participant)/(bare)/layout.tsx) must NEVER
// render inside the full AppShell, while my-application/ and schedule/
// (served via (participant)/(shell)/layout.tsx) always do.
//
// WHY A SOURCE-INSPECTION TEST RATHER THAN A RENDERED-OUTPUT TEST: these
// are Next.js Server Components composed via the App Router's filesystem
// layout convention (a nested route-group layout.tsx implicitly wrapping
// page.tsx) — there is no user-space "call this function and get JSX
// back" entry point vitest can invoke outside a real Next.js request
// (the layout nesting itself is resolved by Next's own router, not by
// any code this repo owns). tests/shell/logout-live.test.ts's doc
// comment documents the same constraint for a 'use server' action
// needing next/headers' cookies(); layouts are the equivalent case for
// App Router's routing/rendering internals. Given that, the two
// meaningful, stable properties actually worth pinning are:
//   1. (bare)/layout.tsx's source never imports/renders AppShell.
//   2. (shell)/layout.tsx's source does import and render AppShell.
// Combined with `npm run build` (which resolves and compiles the real
// layout-nesting Next performs, so a wiring mistake like a stray
// layout.tsx at (participant)/ itself would surface as every claim/
// register test failing to type-check against a shell that shouldn't
// exist there) this is the correct-altitude test for a property that is
// fundamentally about file/directory structure, not runtime data.
const root = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

describe('participant shell exception (Task 6 Step 3)', () => {
  it('(bare)/layout.tsx (claim/register) does not import or render AppShell', () => {
    const source = read('src/app/[locale]/(participant)/(bare)/layout.tsx');
    // Checks the two things that actually matter at runtime — an import
    // statement pulling AppShell in, and JSX actually instantiating it —
    // rather than a blanket "AppShell" substring match, since this file's
    // own doc comments legitimately reference AppShell/app-shell.tsx by
    // name to explain WHY it is deliberately absent from the real code.
    expect(source).not.toMatch(/import\s*\{[^}]*\bAppShell\b[^}]*\}\s*from/);
    expect(source).not.toMatch(/<AppShell\b/);
  });

  it('(shell)/layout.tsx (my-application/schedule) imports and renders AppShell', () => {
    const source = read('src/app/[locale]/(participant)/(shell)/layout.tsx');
    expect(source).toMatch(/import\s*\{\s*AppShell\s*\}\s*from\s*'@\/components\/shell\/app-shell'/);
    expect(source).toMatch(/<AppShell/);
  });

  it('(admin)/layout.tsx imports and renders AppShell', () => {
    const source = read('src/app/[locale]/(admin)/layout.tsx');
    expect(source).toMatch(/import\s*\{\s*AppShell\s*\}\s*from\s*'@\/components\/shell\/app-shell'/);
    expect(source).toMatch(/<AppShell/);
  });

  it('there is no layout.tsx directly at (participant)/ that would wrap both (bare) and (shell)', () => {
    // If a layout.tsx existed at (participant)/layout.tsx it would sit
    // ABOVE both (bare)/ and (shell)/ in the filesystem/component
    // hierarchy and wrap both — silently reintroducing AppShell (or
    // whatever it rendered) around claim/register regardless of what
    // (bare)/layout.tsx itself does. This test fails loudly (ENOENT) if
    // that file is ever added back.
    expect(() => read('src/app/[locale]/(participant)/layout.tsx')).toThrow();
  });

  it('claim/page.tsx and register/page.tsx are NOT listed in the participant nav config\'s verified routes (they intentionally sit outside the shelled nav)', () => {
    const source = read('src/lib/nav/participant-nav-config.ts');
    expect(source).not.toMatch(/\/claim/);
    expect(source).not.toMatch(/\/register/);
  });
});
