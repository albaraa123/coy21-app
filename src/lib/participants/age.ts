// src/lib/participants/age.ts
//
// Age in whole years computed from a `birth_date` ('YYYY-MM-DD', as
// stored in applications.birth_date) as of a given reference date.
// Returns null when birth_date is absent -- callers must never fall
// back to age_group's coarse bucket as a substitute for a real age
// (explicit product decision: an estimated age is worse than no age).
export function calculateAge(birthDate: string | null, asOf: Date = new Date()): number | null {
  if (!birthDate) return null;

  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return null;

  let age = asOf.getFullYear() - birth.getFullYear();
  const hasHadBirthdayThisYear =
    asOf.getMonth() > birth.getMonth() ||
    (asOf.getMonth() === birth.getMonth() && asOf.getDate() >= birth.getDate());
  if (!hasHadBirthdayThisYear) age -= 1;

  return age;
}
