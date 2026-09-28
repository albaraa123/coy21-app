// src/lib/import/mapping-suggestion.ts
import { createHash } from 'node:crypto';
import { KNOWN_FIELDS, type KnownField } from './field-dictionary';

// Strips invisible Unicode bidi control characters (LRM/RLM U+200E/U+200F,
// embed/override/pop-directional-formatting U+202A-U+202E, isolate
// U+2066-U+2069) before the usual trim/lowercase/whitespace-collapse. Real-
// world input, not hypothetical: Arabic header text copy-pasted from Word or
// a web page into Excel frequently carries these marks even though it's
// visually identical to the same text typed directly — without stripping
// them, an otherwise-exact alias match silently degrades to a lower-
// confidence fuzzy match. The character class below contains the literal
// (invisible) codepoints, not \u-escape syntax — every escape-syntax
// rewrite attempted here got re-materialized into the same literal
// characters by the tooling, so this is written as-is; codepoint coverage
// (exactly U+200E, U+200F, U+202A-U+202E, U+2066-U+2069, no stray
// neighbors) is independently verified in
// tests/import/mapping-suggestion.test.ts's bidi-mark regression test.
const BIDI_CONTROL_CHARS = new RegExp('[‎‏‪-‮⁦-⁩]', 'g');

// Arabic-Indic digits (٠-٩, U+0660-U+0669) mapped to Western 0-9, so a
// section number typed as "٣.١" and one typed as "3.1" normalize identically
// before the leading-number strip below runs.
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC_DIGITS.indexOf(d)));
}

// Google Forms headings routinely arrive as: a leading section number
// ("3.1" or "٣.١"), the actual question text, then explanatory text on a
// following line ("(please select one)", usage notes, etc.) separated by a
// real line break. Real-world exports also carry curly/typographic
// apostrophes and quotation marks where a straight one would match an alias
// exactly. None of this is hypothetical — it's the literal shape described
// for the actual RCOY MENA Google Form headings this dictionary must match.
const LEADING_SECTION_NUMBER = /^[\s0-9.:)\-]+/;
const SMART_PUNCTUATION: Record<string, string> = {
  '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-',
};

export function normalizeHeader(header: string): string {
  const digitsNormalized = normalizeDigits(header);
  // Only the FIRST line is the actual question — anything after a real line
  // break is explanatory text/usage notes, not part of the heading itself.
  const firstLine = digitsNormalized.split(/\r?\n/)[0];
  const punctuationNormalized = firstLine.replace(
    /[‘’“”–—]/g,
    (c) => SMART_PUNCTUATION[c] ?? c
  );
  const withoutBidi = punctuationNormalized.replace(BIDI_CONTROL_CHARS, '');
  const withoutLeadingNumber = withoutBidi.replace(LEADING_SECTION_NUMBER, '');
  return withoutLeadingNumber.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface MappingSuggestion {
  key: string;
  kind: KnownField['kind'];
  isCriticalIdentity: boolean;
  confidence: number;
}

// Levenshtein-based similarity, normalized to 0..1. Simple, dependency-free,
// sufficient for short header strings — no need for a fuzzy-matching library
// for this scale of comparison (dictionary is ~20 entries, header strings
// are a handful of words).
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const distance = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Below this, a match is not plausible enough to surface as a suggestion at
// all (the column falls back to "generic answer, needs manual mapping").
const MIN_PLAUSIBLE_SCORE = 0.5;
// Flat bonus for a substring-containment match (see scoreHeaderAgainstAlias)
// before length-ratio dampening is applied.
const SUBSTRING_MATCH_BASE_SCORE = 0.85;

function scoreHeaderAgainstAlias(normalized: string, alias: string): number {
  if (normalized === alias) return 1;
  if (normalized.includes(alias) || alias.includes(normalized)) {
    // A flat score here rewards coincidental containment as much as a
    // near-total match — e.g. "the corporate email address of the
    // applicant maybe cc" contains the "email" alias as a substring and
    // would otherwise score higher than a genuinely close fuzzy variant
    // like "e-mail". Dampen by the length ratio of the shorter string to
    // the longer one, so containment inside a much longer, mostly-unrelated
    // header scores low enough to fall to (or below) MIN_PLAUSIBLE_SCORE,
    // while containment where the strings are nearly the same length still
    // scores close to the flat bonus. This matters especially for
    // isCriticalIdentity fields like email, where a spuriously high
    // confidence could suppress the mandatory-review flag a low-confidence
    // match would otherwise trigger.
    const lengthRatio = Math.min(normalized.length, alias.length) / Math.max(normalized.length, alias.length);
    return SUBSTRING_MATCH_BASE_SCORE * lengthRatio;
  }
  return similarity(normalized, alias);
}

export function suggestMapping(header: string): MappingSuggestion | null {
  const normalized = normalizeHeader(header);
  if (normalized === '') return null;

  // Strict `>` (not `>=`) means an exact tie keeps whichever field/alias was
  // examined FIRST, i.e. KNOWN_FIELDS's declared order — not any semantic
  // criterion like preferring core_field over known_answer, or preferring
  // isCriticalIdentity fields. This is an accepted, order-dependent
  // simplification: exact-score ties are rare in practice (most matches are
  // either an exact 1.0, a unique fuzzy score, or land on distinct
  // dictionary entries), and the caller always surfaces the confidence
  // score for admin review regardless of which field won the tie.
  let best: MappingSuggestion | null = null;
  for (const field of KNOWN_FIELDS) {
    for (const alias of field.aliases) {
      const score = scoreHeaderAgainstAlias(normalized, alias);
      if (score < MIN_PLAUSIBLE_SCORE) continue; // below any plausible-match floor, don't even consider
      if (!best || score > best.confidence) {
        best = { key: field.key, kind: field.kind, isCriticalIdentity: field.isCriticalIdentity, confidence: score };
      }
    }
  }
  return best;
}

export function computeHeaderSignature(headers: string[]): string {
  const normalized = headers.map(normalizeHeader).join('|');
  return createHash('sha256').update(normalized).digest('hex');
}
