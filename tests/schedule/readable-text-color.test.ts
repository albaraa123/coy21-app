import { describe, expect, it } from 'vitest';
import { pickReadableTextColor } from '@/lib/schedule/readable-text-color';

describe('pickReadableTextColor', () => {
  it('picks white text for a dark background (the real Plenary navy)', () => {
    expect(pickReadableTextColor('#1F3864')).toBe('#ffffff');
  });

  it('picks dark text for a mid-tone background that fails white contrast (the real Side Event orange)', () => {
    expect(pickReadableTextColor('#E69138')).toBe('#0a1a2e');
  });

  it('picks dark text for the real Break gray', () => {
    expect(pickReadableTextColor('#8C8C8C')).toBe('#0a1a2e');
  });

  it('picks dark text for the real Culture purple', () => {
    expect(pickReadableTextColor('#8E7CC3')).toBe('#0a1a2e');
  });

  it('picks the better of the two options even when neither cleanly passes AA (the real Registration teal)', () => {
    // #0E8C82 fails both >=4.5:1 by a small margin on this codebase's own
    // dataviz-skill validator -- confirms this function still returns
    // SOME answer (the higher-contrast one) rather than throwing/defaulting
    // blindly to white when a color is genuinely awkward.
    expect(pickReadableTextColor('#0E8C82')).toBe('#0a1a2e');
  });

  it('picks white text for true black', () => {
    expect(pickReadableTextColor('#000000')).toBe('#ffffff');
  });

  it('picks dark text for true white', () => {
    expect(pickReadableTextColor('#ffffff')).toBe('#0a1a2e');
  });

  it('handles a 3-digit shorthand hex the same as its 6-digit expansion', () => {
    expect(pickReadableTextColor('#fff')).toBe(pickReadableTextColor('#ffffff'));
    expect(pickReadableTextColor('#000')).toBe(pickReadableTextColor('#000000'));
  });
});
