// src/components/scanner/install-platform.test.ts
import { describe, expect, it } from 'vitest';
import { detectInstallPlatform } from './install-platform';

describe('detectInstallPlatform', () => {
  it('detects iPhone', () => {
    expect(detectInstallPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('ios');
  });

  it('detects iPad', () => {
    expect(detectInstallPlatform('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('ios');
  });

  it('detects Android', () => {
    expect(detectInstallPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0')).toBe('android');
  });

  it('falls back to "other" for desktop browsers', () => {
    expect(detectInstallPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0')).toBe('other');
  });

  it('falls back to "other" when userAgent is undefined (never throws)', () => {
    expect(detectInstallPlatform(undefined)).toBe('other');
  });
});
