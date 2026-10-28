import { describe, it, expect } from 'vitest';
import { arrayFieldToInput, inputToArrayField } from './general-info-array-field';

describe('arrayFieldToInput', () => {
  it('joins a populated array with ", "', () => {
    expect(arrayFieldToInput(['climate policy', 'youth engagement'])).toBe('climate policy, youth engagement');
  });
  it('returns an empty string for null', () => {
    expect(arrayFieldToInput(null)).toBe('');
  });
  it('returns an empty string for an empty array', () => {
    expect(arrayFieldToInput([])).toBe('');
  });
});

describe('inputToArrayField', () => {
  it('splits a comma-separated string, trimming each element', () => {
    expect(inputToArrayField('climate policy, youth engagement ,renewable energy')).toEqual([
      'climate policy', 'youth engagement', 'renewable energy',
    ]);
  });
  it('returns an empty array for an empty/whitespace-only string', () => {
    expect(inputToArrayField('')).toEqual([]);
    expect(inputToArrayField('   ')).toEqual([]);
  });
  it('drops a trailing comma without producing a stray empty-string element', () => {
    expect(inputToArrayField('a, b,')).toEqual(['a', 'b']);
  });
  it('drops a leading comma without producing a stray empty-string element', () => {
    expect(inputToArrayField(',a, b')).toEqual(['a', 'b']);
  });
  it('round-trips through arrayFieldToInput', () => {
    const original = ['one', 'two', 'three'];
    expect(inputToArrayField(arrayFieldToInput(original))).toEqual(original);
  });
});
