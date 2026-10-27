// src/app/[locale]/(admin)/participants/care/actions.ts
//
// Thin 'use server' wrapper: requireParticipantCareStaffCaller() — this
// file's own real authorization gate, since the service-role client it
// hands back bypasses RLS entirely — plus a direct pass-through into the
// *ForCaller functions in health-info-management.ts, which hold all the
// actual logic and are what live tests exercise directly (same split as
// attendance/admissions/actions.ts and attendance/scanners/actions.ts).
'use server';

import { requireParticipantCareStaffCaller } from '@/lib/participant-care/server-helpers';
import {
  searchParticipantsForCareForCaller,
  fetchHealthInfoForCaller,
  updateHealthInfoForCaller,
  updateGuardianInfoForCaller,
  type HealthInfoUpdateInput,
  type GuardianUpdateInput,
} from '@/lib/participant-care/health-info-management';

export async function searchParticipantsForCare(term: string) {
  const caller = await requireParticipantCareStaffCaller();
  return searchParticipantsForCareForCaller(caller, term);
}

export async function fetchHealthInfo(applicationId: string) {
  const caller = await requireParticipantCareStaffCaller();
  return fetchHealthInfoForCaller(caller, applicationId);
}

export async function updateHealthInfo(applicationId: string, input: HealthInfoUpdateInput) {
  const caller = await requireParticipantCareStaffCaller();
  return updateHealthInfoForCaller(caller, applicationId, input);
}

export async function updateGuardianInfo(applicationId: string, input: GuardianUpdateInput) {
  const caller = await requireParticipantCareStaffCaller();
  return updateGuardianInfoForCaller(caller, applicationId, input);
}

export type { ParticipantSearchResult, HealthInfo, HealthInfoUpdateInput, GuardianInfo, GuardianUpdateInput } from '@/lib/participant-care/health-info-management';
