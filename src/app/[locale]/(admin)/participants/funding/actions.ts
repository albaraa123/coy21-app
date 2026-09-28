// src/app/[locale]/(admin)/participants/funding/actions.ts
//
// Thin 'use server' wrapper: requireFundingStaffCaller() / require
// AttendanceConfirmationReadCaller() — this file's own real authorization
// gates — plus a direct pass-through into the *ForCaller functions in
// funding-management.ts, which hold all the actual logic (same split as
// participants/travel/actions.ts).
'use server';

import { requireFundingStaffCaller, requireAttendanceConfirmationReadCaller } from '@/lib/funding/server-helpers';
import {
  searchParticipantsForFundingForCaller,
  searchParticipantsForCareForCaller,
  updateFundingTypeForCaller,
  updateAttendanceConfirmationForCaller,
  fetchAttendanceConfirmationCountsForCaller,
} from '@/lib/funding/funding-management';
import type { FundingType, AttendanceConfirmation } from '@/lib/validation/funding-type';

export async function searchParticipantsForFunding(term: string) {
  const caller = await requireFundingStaffCaller();
  return searchParticipantsForFundingForCaller(caller, term);
}

// Read-only path for participant_care_staff — never returns funding_type.
export async function searchParticipantsForAttendanceConfirmation(term: string) {
  const caller = await requireAttendanceConfirmationReadCaller();
  return searchParticipantsForCareForCaller(caller, term);
}

export async function updateFundingType(applicationId: string, fundingType: FundingType | null) {
  const caller = await requireFundingStaffCaller();
  return updateFundingTypeForCaller(caller, applicationId, fundingType);
}

export async function updateAttendanceConfirmation(applicationId: string, attendanceConfirmation: AttendanceConfirmation) {
  const caller = await requireFundingStaffCaller();
  return updateAttendanceConfirmationForCaller(caller, applicationId, attendanceConfirmation);
}

export async function fetchAttendanceConfirmationCounts() {
  const caller = await requireAttendanceConfirmationReadCaller();
  return fetchAttendanceConfirmationCountsForCaller(caller);
}

export type { ParticipantSearchResult, ParticipantCareSearchResult } from '@/lib/funding/funding-management';
export type { FundingType, AttendanceConfirmation } from '@/lib/validation/funding-type';
