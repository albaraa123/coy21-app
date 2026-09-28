// src/app/[locale]/(admin)/participants/travel/actions.ts
//
// Thin 'use server' wrapper: requireTravelOpsStaffCaller() — this file's
// own real authorization gate — plus a direct pass-through into the
// *ForCaller functions in travel-info-management.ts, which hold all the
// actual logic (same split as participants/care/actions.ts).
'use server';

import { requireTravelOpsStaffCaller } from '@/lib/travel-ops/server-helpers';
import {
  searchParticipantsForTravelForCaller,
  fetchTravelInfoForCaller,
  updateTravelInfoForCaller,
  type TravelInfoUpdateInput,
} from '@/lib/travel-ops/travel-info-management';

export async function searchParticipantsForTravel(term: string) {
  const caller = await requireTravelOpsStaffCaller();
  return searchParticipantsForTravelForCaller(caller, term);
}

export async function fetchTravelInfo(applicationId: string) {
  const caller = await requireTravelOpsStaffCaller();
  return fetchTravelInfoForCaller(caller, applicationId);
}

export async function updateTravelInfo(applicationId: string, input: TravelInfoUpdateInput) {
  const caller = await requireTravelOpsStaffCaller();
  return updateTravelInfoForCaller(caller, applicationId, input);
}

export type { ParticipantSearchResult, TravelInfo, TravelInfoUpdateInput } from '@/lib/travel-ops/travel-info-management';
