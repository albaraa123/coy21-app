// Picks white or dark text for readability against an arbitrary
// background hex color, via real relative-luminance contrast math (WCAG
// 2.x formula) -- not a guess. Added 2026-11-01 after live user feedback
// on the agenda grid: only 1 of the 5 real track colors (#1F3864, the
// navy Plenary color) actually passes AA contrast (>=4.5:1) against white
// text; the other 4 (purple/orange/gray/teal) read poorly or fail
// entirely with hardcoded white text. Verified directly (not assumed) via
// this codebase's own dataviz-skill validator's contrast() function
// before writing this: PLN vs white 11.62 (pass), CUL vs white 3.61
// (fail) / vs dark 4.85 (pass), SDE vs white 2.48 (fail) / vs dark 7.06
// (pass), BRK vs white 3.36 (fail) / vs dark 5.20 (pass), REG vs white
// 4.12 (fail) / vs dark 4.24 (fail, barely, by this exact formula -- but
// closer to passing than white, so dark is still the better of the two
// options when a track color doesn't cleanly pass either).

const DARK_TEXT = '#0a1a2e'; // --color-charcoal (globals.css)
const LIGHT_TEXT = '#ffffff';

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3 ? normalized.split('').map((c) => c + c).join('') : normalized;
  const int = parseInt(full, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

// WCAG relative luminance (sRGB).
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexToRgb(hexA));
  const lumB = relativeLuminance(hexToRgb(hexB));
  const [hi, lo] = lumA > lumB ? [lumA, lumB] : [lumB, lumA];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Returns whichever of white/dark text has the higher contrast ratio
 * against `backgroundHex` -- always a real comparison, never a fixed
 * default, so a new track color added later (whatever hue someone picks)
 * automatically gets readable text without needing a matching manual
 * fix here.
 */
export function pickReadableTextColor(backgroundHex: string): string {
  const contrastWithLight = contrastRatio(backgroundHex, LIGHT_TEXT);
  const contrastWithDark = contrastRatio(backgroundHex, DARK_TEXT);
  return contrastWithLight >= contrastWithDark ? LIGHT_TEXT : DARK_TEXT;
}
