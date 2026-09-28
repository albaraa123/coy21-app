import { describe, expect, it } from 'vitest';
import { classifyVerdict } from '@/lib/schedule/fingerprint';

describe('classifyVerdict', () => {
  it('blocks when a mandatory slot has an unassigned issue', () => {
    const result = classifyVerdict({
      issues: [{ issueType: 'unassigned', sessionIsMandatory: true }],
      contentDiffersFromActive: true,
    });
    expect(result).toBe('blocked_mandatory');
  });

  it('does not block when the unassigned issue is for an elective session', () => {
    const result = classifyVerdict({
      issues: [{ issueType: 'unassigned', sessionIsMandatory: false }],
      contentDiffersFromActive: true,
    });
    expect(result).toBe('publishable');
  });

  it('is publishable when only low_confidence issues are present', () => {
    const result = classifyVerdict({
      issues: [{ issueType: 'low_confidence', sessionIsMandatory: false }],
      contentDiffersFromActive: true,
    });
    expect(result).toBe('publishable');
  });

  it('is no_change when content is identical to the active revision and there are no blocking issues', () => {
    const result = classifyVerdict({ issues: [], contentDiffersFromActive: false });
    expect(result).toBe('no_change');
  });
});
