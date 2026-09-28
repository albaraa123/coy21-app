// src/lib/allocation/hard-constraints.ts
export type SessionLanguage = 'ar' | 'en' | 'bilingual';
export type SessionDifficulty = 'beginner' | 'intermediate' | 'advanced' | 'all_levels';
export type SessionStatus = 'draft' | 'published' | 'confirmed' | 'cancelled' | 'completed';

export interface SessionForConstraints {
  id: string;
  status: SessionStatus;
  includeInAllocation: boolean;
  language: SessionLanguage;
  difficultyLevel: SessionDifficulty;
  isMandatory: boolean;
}

export interface ParticipantForConstraints {
  applicationId: string;
  preferredLanguage: string | null;
  experienceLevel: string | null;
}

export interface ConstraintCheck {
  constraintType: 'confirmed_status' | 'include_in_allocation' | 'language_match' | 'difficulty_match';
  passed: boolean;
  detail: string;
}

export interface StaticConstraintResult {
  eligible: boolean;
  checks: ConstraintCheck[];
  excludedAsMandatory: boolean;
}

const RECOGNIZED_LANGUAGES = new Set(['ar', 'en']);

// none/beginner -> beginner, intermediate -> intermediate, expert -> advanced.
// Unrecognized/null falls back to 'beginner' — the most inclusive
// non-all_levels mapping (spec: Hard Constraints, constraint 5).
function experienceToTier(experienceLevel: string | null): SessionDifficulty {
  if (experienceLevel === 'intermediate') return 'intermediate';
  if (experienceLevel === 'expert') return 'advanced';
  return 'beginner'; // none, beginner, null, or unrecognized
}

const TIER_ORDER: SessionDifficulty[] = ['beginner', 'intermediate', 'advanced'];

function isAdjacentOrEqualTier(participantTier: SessionDifficulty, sessionTier: SessionDifficulty): boolean {
  if (sessionTier === 'all_levels') return true;
  const pIndex = TIER_ORDER.indexOf(participantTier);
  const sIndex = TIER_ORDER.indexOf(sessionTier);
  return Math.abs(pIndex - sIndex) <= 1;
}

// Static constraints only (1, 2, 4, 5 per spec) — capacity (3) is dynamic and
// checked during deferred acceptance / mandatory pass, not here.
export function checkStaticHardConstraints(
  participant: ParticipantForConstraints,
  session: SessionForConstraints
): StaticConstraintResult {
  const checks: ConstraintCheck[] = [];

  const confirmedStatus = session.status === 'confirmed';
  checks.push({
    constraintType: 'confirmed_status',
    passed: confirmedStatus,
    detail: confirmedStatus ? `Session status is 'confirmed'` : `Session status '${session.status}' is not 'confirmed'`,
  });

  checks.push({
    constraintType: 'include_in_allocation',
    passed: session.includeInAllocation,
    detail: session.includeInAllocation ? 'Session is included in allocation' : 'Session has include_in_allocation = false',
  });

  const langRecognized = participant.preferredLanguage != null && RECOGNIZED_LANGUAGES.has(participant.preferredLanguage);
  const languageMatches =
    !langRecognized || session.language === 'bilingual' || session.language === participant.preferredLanguage;
  checks.push({
    constraintType: 'language_match',
    passed: languageMatches,
    detail: !langRecognized
      ? `Participant has no recognized preferred_language — treated as matching any language`
      : languageMatches
        ? `Session language '${session.language}' matches applicant preferred_language '${participant.preferredLanguage}'`
        : `Session language '${session.language}' does not match applicant preferred_language '${participant.preferredLanguage}'`,
  });

  const participantTier = experienceToTier(participant.experienceLevel);
  const difficultyMatches = isAdjacentOrEqualTier(participantTier, session.difficultyLevel);
  checks.push({
    constraintType: 'difficulty_match',
    passed: difficultyMatches,
    detail: difficultyMatches
      ? `Participant tier '${participantTier}' is within one tier of session difficulty '${session.difficultyLevel}'`
      : `Participant tier '${participantTier}' is not within one tier of session difficulty '${session.difficultyLevel}'`,
  });

  return {
    eligible: checks.every((c) => c.passed),
    checks,
    excludedAsMandatory: session.isMandatory,
  };
}
