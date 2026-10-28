import { describe, it, expect } from 'vitest';
import { classifyDelegateCode } from './delegate-code-classification';

describe('classifyDelegateCode', () => {
  const cases: Array<[string, { participantType: string; registrationCategory: string } | null]> = [
    ['DEL-INT-001', { participantType: 'delegate', registrationCategory: 'Delegates' }],
    ['VOL-TUR-001', { participantType: 'volunteer', registrationCategory: 'Onground Volunteers' }],
    ['VOL-YNG-049', { participantType: 'volunteer', registrationCategory: 'COY21 Organizing Team Volunteers' }],
    ['DEL-UNW-375', { participantType: 'delegate', registrationCategory: 'UN Women Delegates' }],
    ['DEL-IOM-390', { participantType: 'delegate', registrationCategory: 'IOM Youth Delegates' }],
    ['DEL-PYCC-397', { participantType: 'delegate', registrationCategory: 'PYCC Delegates' }],
    ['DEL-YNG-001', { participantType: 'delegate', registrationCategory: 'Policy Team On-ground Delegates' }],
    ['DEL-LCOY-001', { participantType: 'delegate', registrationCategory: 'LCOY Delegates' }],
    ['DEL-RCOY-001', { participantType: 'delegate', registrationCategory: 'RCOY Delegates' }],
  ];

  it.each(cases)('classifies %s correctly', (code, expected) => {
    expect(classifyDelegateCode(code)).toEqual(expected);
  });

  it('returns null for an unrecognized prefix', () => {
    expect(classifyDelegateCode('XYZ-001')).toBeNull();
  });

  it('returns null for an empty or malformed string', () => {
    expect(classifyDelegateCode('')).toBeNull();
    expect(classifyDelegateCode('DEL')).toBeNull();
  });
});
