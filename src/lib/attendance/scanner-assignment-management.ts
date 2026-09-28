// src/lib/attendance/scanner-assignment-management.ts
//
// Phase 7F — trusted server logic for managing scanner_assignments,
// factored out of the 'use server' action file
// (src/app/[locale]/(admin)/attendance/scanners/actions.ts) specifically
// so it can be exercised by live tests with an injected caller, the same
// way scanQrAttemptConfirmForCaller (scan-qr-attempt.ts) separates real
// logic from requireScannerDeviceCaller()'s own un-forgeable
// next/headers-cookie dependency. requireProgramAttendanceStaffCaller()'s
// own body is a simple auth.uid() + isProgramAttendanceStaffRole(role)
// check, already proven sufficient by other role-boundary live tests
// (e.g. scanner-device-access-live.test.ts's pattern) — every *ForCaller
// function below takes { userId, service } directly so its authorization-
// ADJACENT logic (resource validation, duplicate detection, audit
// writes) gets full live-database coverage without needing a real
// Next.js request context.
//
// No new RPC, no schema change: scanner_assignments' existing scope
// check (verifyScannerScope, scan-attempt.ts/scan-qr-attempt.ts) and read
// model (scanner-assignment-context.ts) are both left completely
// untouched. This module only adds the missing admin-facing CRUD surface
// for the table those modules already read.
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/types/database';
import { writeAuditLog } from '@/lib/agenda/server-helpers';
import { isScannerDeviceRole } from '@/lib/validation/scanner-device';

type ServiceClient = SupabaseClient<Database>;
type Caller = { userId: string; service: ServiceClient };

export const createSessionAssignmentSchema = z.object({
  scannerUserId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

export const createRoomAssignmentSchema = z.object({
  scannerUserId: z.string().uuid(),
  roomId: z.string().uuid(),
});

async function assertScannerTarget(service: ServiceClient, scannerUserId: string) {
  const { data: scannerProfile } = await service.from('profiles').select('role').eq('id', scannerUserId).maybeSingle();
  if (!scannerProfile) throw new Error('Scanner account not found');
  if (!isScannerDeviceRole(scannerProfile.role)) throw new Error('Target account is not a scanner device');
}

export interface AssignmentWarning {
  code: 'exact_duplicate' | 'covered_by_room';
  message: string;
}

/**
 * Pre-flight check surfaced to the UI BEFORE submission, so the manager
 * sees the warning inline rather than as a rejected-save error. Never
 * blocks by itself; callers decide whether to proceed. Matches the
 * approved multi-assignment policy: multiple active assignments per
 * scanner are ALLOWED, exact duplicates are BLOCKED at the create step,
 * room+contained-session overlap is ALLOWED with an informational
 * warning only.
 */
export async function checkSessionAssignmentWarningForCaller(
  caller: Caller,
  scannerUserId: string,
  sessionId: string
): Promise<AssignmentWarning | null> {
  const { service } = caller;

  const { data: exactDuplicate } = await service
    .from('scanner_assignments')
    .select('id')
    .eq('scanner_user_id', scannerUserId)
    .eq('session_id', sessionId)
    .eq('is_active', true)
    .maybeSingle();
  if (exactDuplicate) {
    return { code: 'exact_duplicate', message: 'This scanner already has an active assignment for this exact session.' };
  }

  const { data: session } = await service.from('sessions').select('room_id').eq('id', sessionId).maybeSingle();
  if (session?.room_id) {
    const { data: coveringRoomAssignment } = await service
      .from('scanner_assignments')
      .select('id')
      .eq('scanner_user_id', scannerUserId)
      .eq('room_id', session.room_id)
      .eq('is_active', true)
      .maybeSingle();
    if (coveringRoomAssignment) {
      return { code: 'covered_by_room', message: 'This scanner is already authorized for this session through its room assignment.' };
    }
  }

  return null;
}

export async function createSessionAssignmentForCaller(caller: Caller, input: z.infer<typeof createSessionAssignmentSchema>) {
  const { userId, service } = caller;
  const parsed = createSessionAssignmentSchema.parse(input);

  await assertScannerTarget(service, parsed.scannerUserId);

  const { data: session } = await service.from('sessions').select('id, status').eq('id', parsed.sessionId).maybeSingle();
  if (!session) throw new Error('Session not found');
  // Matches scanner-assignment-context.ts's own 'confirmed'-only rule for
  // what counts as scannable — creating an assignment against a
  // draft/published/cancelled/completed session would silently produce a
  // scope the operator can never actually use (session_unavailable), so
  // this is rejected here rather than left as a confusing dead
  // assignment the manager has to debug later.
  if (session.status !== 'confirmed') {
    throw new Error('Session is not confirmed — assignment would not be usable yet');
  }

  const { data: existing } = await service
    .from('scanner_assignments')
    .select('id')
    .eq('scanner_user_id', parsed.scannerUserId)
    .eq('session_id', parsed.sessionId)
    .eq('is_active', true)
    .maybeSingle();
  if (existing) throw new Error('This scanner already has an active assignment for this exact session');

  const { data: assignment, error } = await service
    .from('scanner_assignments')
    .insert({ scanner_user_id: parsed.scannerUserId, session_id: parsed.sessionId, assigned_by: userId })
    .select('id')
    .single();
  if (error || !assignment) {
    console.error('createSessionAssignmentForCaller: insert failed', { input: parsed, userId, error });
    throw error ?? new Error('Failed to create assignment');
  }

  await writeAuditLog(service, {
    entityType: 'scanner_assignment',
    entityId: assignment.id,
    action: 'create_session_assignment',
    actorId: userId,
    newValues: { scannerUserId: parsed.scannerUserId, sessionId: parsed.sessionId },
  });
  return { id: assignment.id as string };
}

export async function createRoomAssignmentForCaller(caller: Caller, input: z.infer<typeof createRoomAssignmentSchema>) {
  const { userId, service } = caller;
  const parsed = createRoomAssignmentSchema.parse(input);

  await assertScannerTarget(service, parsed.scannerUserId);

  const { data: room } = await service.from('rooms').select('id, is_active').eq('id', parsed.roomId).maybeSingle();
  if (!room) throw new Error('Room not found');
  if (!room.is_active) throw new Error('Room is not active');

  const { data: existing } = await service
    .from('scanner_assignments')
    .select('id')
    .eq('scanner_user_id', parsed.scannerUserId)
    .eq('room_id', parsed.roomId)
    .eq('is_active', true)
    .maybeSingle();
  if (existing) throw new Error('This scanner already has an active assignment for this exact room');

  const { data: assignment, error } = await service
    .from('scanner_assignments')
    .insert({ scanner_user_id: parsed.scannerUserId, room_id: parsed.roomId, assigned_by: userId })
    .select('id')
    .single();
  if (error || !assignment) {
    console.error('createRoomAssignmentForCaller: insert failed', { input: parsed, userId, error });
    throw error ?? new Error('Failed to create assignment');
  }

  await writeAuditLog(service, {
    entityType: 'scanner_assignment',
    entityId: assignment.id,
    action: 'create_room_assignment',
    actorId: userId,
    newValues: { scannerUserId: parsed.scannerUserId, roomId: parsed.roomId },
  });
  return { id: assignment.id as string };
}

export async function deactivateAssignmentForCaller(caller: Caller, id: string) {
  const { userId, service } = caller;

  const { data: existing } = await service
    .from('scanner_assignments')
    .select('id, is_active, scanner_user_id, session_id, room_id')
    .eq('id', id)
    .maybeSingle();
  if (!existing) throw new Error('Assignment not found');

  const { error } = await service.from('scanner_assignments').update({ is_active: false }).eq('id', id);
  if (error) {
    console.error('deactivateAssignmentForCaller: update failed', { id, userId, error });
    throw error;
  }

  await writeAuditLog(service, {
    entityType: 'scanner_assignment',
    entityId: id,
    action: 'deactivate',
    actorId: userId,
    oldValues: { isActive: existing.is_active },
    newValues: { isActive: false },
  });
  return { id };
}

/**
 * Reassign = deactivate the old assignment, then create a fresh one in
 * its place. Deliberately sequential (deactivate, THEN create) rather
 * than a single UPDATE that repoints the old row's session_id/room_id:
 * that would silently erase the old scope from assignment HISTORY
 * (audit_logs old_values would just show the current row's new fields
 * with no trace the row used to mean something else), where this
 * codebase's established convention (rooms/deactivate+reactivate,
 * scan_attempts append-only history) is lifecycle-safe mutation over
 * in-place identity reuse. There is a real, brief window where the old
 * assignment is deactivated but the new one doesn't exist yet if the
 * second call fails — acceptable per the brief ("smallest transaction/
 * RPC necessary"; a full transactional RPC was not introduced solely for
 * this, since the failure mode is "scanner temporarily has less scope
 * than intended," not "scanner retains unauthorized scope" — the
 * fail-safe direction).
 */
export async function reassignToSessionForCaller(caller: Caller, oldAssignmentId: string, scannerUserId: string, sessionId: string) {
  await deactivateAssignmentForCaller(caller, oldAssignmentId);
  return createSessionAssignmentForCaller(caller, { scannerUserId, sessionId });
}

export async function reassignToRoomForCaller(caller: Caller, oldAssignmentId: string, scannerUserId: string, roomId: string) {
  await deactivateAssignmentForCaller(caller, oldAssignmentId);
  return createRoomAssignmentForCaller(caller, { scannerUserId, roomId });
}
