// src/app/manifest.test.ts
//
// Smoke test for the PWA manifest — validates the fields Phase 7E's
// installability requirement actually depends on, without needing a
// browser: name/short_name present, start_url points at the scanner
// entry point (not a locale-hardcoded path), standalone display mode,
// and at least one non-maskable 512x512 icon (the size most install
// prompts/app switchers actually use).
import { describe, expect, it } from 'vitest';
import manifest from './manifest';

describe('manifest', () => {
  const result = manifest();

  it('has a name and short_name', () => {
    expect(result.name).toBeTruthy();
    expect(result.short_name).toBeTruthy();
  });

  it('start_url points at /scanner without a hardcoded locale', () => {
    expect(result.start_url).toBe('/scanner');
    expect(result.start_url).not.toMatch(/\/(ar|en)\//);
  });

  it('uses standalone display mode', () => {
    expect(result.display).toBe('standalone');
  });

  it('includes a 512x512 non-maskable icon and a maskable variant', () => {
    const icons = result.icons ?? [];
    const plain512 = icons.find((icon) => icon.sizes === '512x512' && icon.purpose === undefined);
    const maskable512 = icons.find((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable');
    expect(plain512).toBeTruthy();
    expect(maskable512).toBeTruthy();
  });

  it('scope covers the locale-redirected destination, not just the launch URL', () => {
    expect(result.scope).toBe('/');
  });
});
