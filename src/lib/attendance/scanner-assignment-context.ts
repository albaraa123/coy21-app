// src/lib/attendance/scanner-assignment-context.ts
//
// Server-only read of what a scanner_device/super_admin caller is
// currently authorized to scan for — the trusted data source for the
// /scanner page's "which session/room am I scanning right now" display.
// Deliberately narrow (allow-list select, same discipline as
// participant-summary.ts): never exposes anything beyond what an
// operator needs to see before scanning.
//
// This does NOT replace verifyScannerScope (scan-attempt.ts,
// scan-qr-attempt.ts) — that remains the authoritative, independently
// re-checked gate on every actual scan submission. This module only
// answers "what should the page display", and is read-only.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

export interface ScannerSessionContext {
  sessionId: string;
  titleAr: string;
  titleEn: string;
  startTime: string;
  endTime: string;
  status: string;
  roomId: string;
  roomCode: string;
  roomNameAr: string;
  roomNameEn: string;
}

export type ScannerAssignmentContext =
  | { kind: 'no_assignment' }
  | { kind: 'session_unavailable'; sessionCount: number }
  | { kind: 'ready'; sessions: ScannerSessionContext[] };

/**
 * Loads every session the caller's active scanner_assignments rows cover
 * right now (session-scoped assignments directly; room-scoped
 * assignments expand to every session in that room), per the same
 * session_id/room_id OR-of-two-paths shape verifyScannerScope already
 * uses. Sessions with status other than 'confirmed' are excluded from
 * the 'ready' set — a scanner has nothing scannable if its only
 * assigned session(s) are draft/cancelled/completed, which is
 * distinguished from having no assignment at all.
 */
export async function loadScannerAssignmentContext(service: ServiceClient, userId: string): Promise<ScannerAssignmentContext> {
  const { data: assignments, error: assignmentsError } = await service
    .from('scanner_assignments')
    .select('session_id, room_id')
    .eq('scanner_user_id', userId)
    .eq('is_active', true);
  if (assignmentsError || !assignments || assignments.length === 0) {
    return { kind: 'no_assignment' };
  }

  const sessionIds = assignments.map((a) => a.session_id).filter((id): id is string => id != null);
  const roomIds = assignments.map((a) => a.room_id).filter((id): id is string => id != null);

  const orConditions: string[] = [];
  if (sessionIds.length > 0) orConditions.push(`id.in.(${sessionIds.join(',')})`);
  if (roomIds.length > 0) orConditions.push(`room_id.in.(${roomIds.join(',')})`);
  if (orConditions.length === 0) {
    return { kind: 'no_assignment' };
  }

  const { data: sessions, error: sessionsError } = await service
    .from('sessions')
    .select('id, title_ar, title_en, start_time, end_time, status, room_id, rooms(code, name_ar, name_en)')
    .or(orConditions.join(','));
  if (sessionsError || !sessions) {
    return { kind: 'no_assignment' };
  }

  const readySessions: ScannerSessionContext[] = sessions
    .filter((s) => s.status === 'confirmed')
    .map((s) => ({
      sessionId: s.id,
      titleAr: s.title_ar,
      titleEn: s.title_en,
      startTime: s.start_time,
      endTime: s.end_time,
      status: s.status,
      roomId: s.room_id,
      roomCode: s.rooms?.code ?? '',
      roomNameAr: s.rooms?.name_ar ?? '',
      roomNameEn: s.rooms?.name_en ?? '',
    }));

  if (readySessions.length === 0) {
    return { kind: 'session_unavailable', sessionCount: sessions.length };
  }

  return { kind: 'ready', sessions: readySessions };
}
