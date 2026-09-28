// tests/import/mapping-suggestion.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeHeader, suggestMapping, computeHeaderSignature } from '@/lib/import/mapping-suggestion';

describe('normalizeHeader', () => {
  it('trims, lowercases, and collapses internal whitespace', () => {
    expect(normalizeHeader('  Email   Address  ')).toBe('email address');
  });
});

describe('suggestMapping', () => {
  it('matches an exact English alias with high confidence', () => {
    const s = suggestMapping('Email Address');
    expect(s?.key).toBe('email');
    expect(s?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('matches an exact Arabic alias with high confidence', () => {
    const s = suggestMapping('البريد الإلكتروني');
    expect(s?.key).toBe('email');
    expect(s?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('strips invisible bidi control marks so a copy-pasted Arabic header still matches exactly', () => {
    // RLM (U+200F) is commonly injected by word processors/browsers around
    // RTL text on copy-paste — construct it via fromCharCode/String
    // concatenation rather than a literal in source, so the test doesn't
    // depend on any editor/terminal correctly round-tripping an invisible
    // character through the file itself.
    const rlm = String.fromCharCode(0x200f);
    const withBidiMarks = rlm + 'البريد الإلكتروني' + rlm;
    const s = suggestMapping(withBidiMarks);
    expect(s?.key).toBe('email');
    expect(s?.confidence).toBe(1); // exact match once bidi marks are stripped, not a degraded fuzzy match
  });

  it('matches a close-but-not-exact variant with moderate confidence', () => {
    const s = suggestMapping('E-mail');
    expect(s?.key).toBe('email');
    expect(s?.confidence).toBeGreaterThan(0.5);
  });

  it('returns null or low confidence for an unrecognized header', () => {
    const s = suggestMapping('Favorite Color XYZ123');
    expect(s === null || s.confidence < 0.7).toBe(true);
  });

  it('dampens a substring match by length ratio so a coincidental containment inside a long unrelated header scores low', () => {
    // "email" is contained as a substring, but the header is otherwise
    // unrelated and much longer — this must NOT score as high as a genuine
    // near-exact variant like "E-mail" (tested above, scores ~0.83), and
    // should fall below the review threshold given how little of the header
    // the alias actually accounts for.
    const s = suggestMapping('the corporate email address of the applicant maybe cc');
    if (s?.key === 'email') {
      expect(s.confidence).toBeLessThan(0.5);
    } else {
      expect(s).toBeNull();
    }
  });

  it('never returns a critical-identity match below the review threshold as auto-applicable', () => {
    // A deliberately garbled header that might fuzzy-match "email" weakly —
    // the caller (mapping UI, Task 12) must treat isCriticalIdentity fields
    // below threshold as mandatory-review regardless of the raw score.
    const s = suggestMapping('emial adress maybe');
    if (s?.key === 'email') {
      expect(s.confidence).toBeLessThan(0.9); // not falsely high-confidence
    }
  });
});

describe('computeHeaderSignature', () => {
  it('produces the same signature for the same header set regardless of case/whitespace', () => {
    const sig1 = computeHeaderSignature(['Email', 'Full Name', 'Phone']);
    const sig2 = computeHeaderSignature(['  email  ', 'full name', 'PHONE']);
    expect(sig1).toBe(sig2);
  });

  it('produces a different signature when headers actually differ', () => {
    const sig1 = computeHeaderSignature(['Email', 'Full Name']);
    const sig2 = computeHeaderSignature(['Email', 'Full Name', 'Phone']);
    expect(sig1).not.toBe(sig2);
  });
});
