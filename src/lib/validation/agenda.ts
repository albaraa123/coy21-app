import { z } from 'zod';

// Single source of truth for "is this profile.role allowed to manage the
// agenda". Separate from Phase 2's isAdmissionStaffRole — different phase,
// different role list, deliberately not shared.
export const AGENDA_STAFF_ROLES = ['agenda_allocation_manager', 'super_admin'] as const;
export function isAgendaStaffRole(role: string | null | undefined): boolean {
  return role != null && (AGENDA_STAFF_ROLES as readonly string[]).includes(role);
}

export const SESSION_STATUSES = ['draft', 'published', 'confirmed', 'cancelled', 'completed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// Linear forward progression with cancel-from-anywhere-except-completed.
// Mirrored exactly in the enforce_session_status_transition DB trigger.
export const SESSION_VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  draft: ['published', 'cancelled'],
  published: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  cancelled: [],
  completed: [],
};

export const sessionStatusTransitionSchema = z
  .object({
    from: z.enum(SESSION_STATUSES),
    to: z.enum(SESSION_STATUSES),
    cancellationReason: z.string().trim().min(1).optional(),
  })
  .refine((data) => SESSION_VALID_TRANSITIONS[data.from]?.includes(data.to), {
    message: 'This status transition is not permitted',
    path: ['to'],
  })
  .refine((data) => data.to !== 'cancelled' || (data.cancellationReason && data.cancellationReason.length > 0), {
    message: 'A cancellation reason is required when cancelling a session',
    path: ['cancellationReason'],
  });

export const weightSchema = z.number().min(0).max(1);

export const checkinWindowSchema = z
  .object({
    enableQrCheckin: z.boolean(),
    checkinOpensAt: z.string().datetime().nullable(),
    checkinClosesAt: z.string().datetime().nullable(),
  })
  .refine((data) => !data.enableQrCheckin || (data.checkinOpensAt !== null && data.checkinClosesAt !== null), {
    message: 'Check-in window is required when QR check-in is enabled',
    path: ['checkinOpensAt'],
  })
  .refine(
    (data) =>
      data.checkinOpensAt === null ||
      data.checkinClosesAt === null ||
      new Date(data.checkinOpensAt).getTime() < new Date(data.checkinClosesAt).getTime(),
    { message: 'Check-in opens time must be before closes time', path: ['checkinClosesAt'] }
  );

export const SESSION_PERSON_ROLES = ['speaker', 'guest', 'moderator', 'facilitator', 'trainer', 'session_lead'] as const;
export type SessionPersonRole = (typeof SESSION_PERSON_ROLES)[number];

export const SESSION_LANGUAGES = ['ar', 'en', 'bilingual'] as const;
export const SESSION_DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'all_levels'] as const;
