// src/app/[locale]/(admin)/attendance/scanners/actions.ts
//
// Thin 'use server' wrapper: requireProgramAttendanceStaffCaller() —
// this file's own real authorization gate, since the service-role client
// it hands back bypasses RLS entirely — plus a direct pass-through into
// the *ForCaller functions in scanner-assignment-management.ts, which
// hold all the actual logic and are what tests/attendance's live
// coverage exercises directly (see that module's own doc comment for why
// the split exists).
'use server';

import { requireProgramAttendanceStaffCaller } from '@/lib/program-attendance/server-helpers';
import {
  checkSessionAssignmentWarningForCaller,
  createSessionAssignmentForCaller,
  createRoomAssignmentForCaller,
  deactivateAssignmentForCaller,
  reassignToSessionForCaller,
  reassignToRoomForCaller,
  type createSessionAssignmentSchema,
  type createRoomAssignmentSchema,
} from '@/lib/attendance/scanner-assignment-management';
import type { z } from 'zod';

export async function checkSessionAssignmentWarning(scannerUserId: string, sessionId: string) {
  const caller = await requireProgramAttendanceStaffCaller();
  return checkSessionAssignmentWarningForCaller(caller, scannerUserId, sessionId);
}

export async function createSessionAssignment(input: z.infer<typeof createSessionAssignmentSchema>) {
  const caller = await requireProgramAttendanceStaffCaller();
  return createSessionAssignmentForCaller(caller, input);
}

export async function createRoomAssignment(input: z.infer<typeof createRoomAssignmentSchema>) {
  const caller = await requireProgramAttendanceStaffCaller();
  return createRoomAssignmentForCaller(caller, input);
}

export async function deactivateAssignment(id: string) {
  const caller = await requireProgramAttendanceStaffCaller();
  return deactivateAssignmentForCaller(caller, id);
}

export async function reassignToSession(oldAssignmentId: string, scannerUserId: string, sessionId: string) {
  const caller = await requireProgramAttendanceStaffCaller();
  return reassignToSessionForCaller(caller, oldAssignmentId, scannerUserId, sessionId);
}

export async function reassignToRoom(oldAssignmentId: string, scannerUserId: string, roomId: string) {
  const caller = await requireProgramAttendanceStaffCaller();
  return reassignToRoomForCaller(caller, oldAssignmentId, scannerUserId, roomId);
}
