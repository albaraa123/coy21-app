// Single source of truth for "is this applicant a minor (under 18)",
// used identically by the admin participant-detail page and the
// participant's own My Profile page so the under-18 rule can never
// drift between the two surfaces that gate on it.
//
// Reference date is the CONFERENCE start date, not "today": a minor who
// turns 18 between now and the conference is still a minor -- and still
// needs a contactable guardian -- while physically attending. No
// existing CONFERENCE_START_DATE-style constant exists elsewhere in
// this codebase, so this file defines its own local one.
export const CONFERENCE_START_DATE = '2026-11-05';

export function isApplicationMinor(application: {
  age_group: string | null;
  birth_date: string | null;
}): boolean {
  if (application.age_group != null) {
    return application.age_group === 'under_18';
  }

  if (application.birth_date != null) {
    return ageAsOf(application.birth_date, CONFERENCE_START_DATE) < 18;
  }

  // Both null: should not occur for self-registered applications (the
  // registration schema's .refine requires one of the two), but
  // imported applications can bypass that schema entirely -- resolve to
  // false rather than throw, matching this codebase's general
  // fail-closed-but-non-crashing convention for defensive branches.
  return false;
}

function ageAsOf(birthDate: string, asOfDate: string): number {
  const birth = new Date(birthDate + 'T00:00:00Z');
  const asOf = new Date(asOfDate + 'T00:00:00Z');

  let age = asOf.getUTCFullYear() - birth.getUTCFullYear();
  const hasHadBirthdayByAsOf =
    asOf.getUTCMonth() > birth.getUTCMonth() ||
    (asOf.getUTCMonth() === birth.getUTCMonth() && asOf.getUTCDate() >= birth.getUTCDate());
  if (!hasHadBirthdayByAsOf) age -= 1;

  return age;
}
