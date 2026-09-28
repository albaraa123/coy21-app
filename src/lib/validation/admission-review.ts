import { z } from 'zod';

export const APPLICATION_STATUSES = [
  'draft', 'submitted', 'under_review', 'accepted', 'waitlisted', 'rejected', 'withdrawn',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

// The full status state machine from the design spec. draft and withdrawn are
// never a valid target from any state reachable through this dashboard —
// draft is pre-submission, withdrawn has no UI path anywhere in the app yet.
export const VALID_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: [],
  submitted: ['under_review'],
  under_review: ['submitted', 'accepted', 'waitlisted', 'rejected'],
  accepted: ['waitlisted', 'rejected'],
  waitlisted: ['accepted', 'rejected'],
  rejected: ['accepted', 'waitlisted'],
  withdrawn: [],
};

export const statusTransitionSchema = z
  .object({
    from: z.enum(APPLICATION_STATUSES),
    to: z.enum(APPLICATION_STATUSES),
  })
  .refine((data) => VALID_TRANSITIONS[data.from]?.includes(data.to), {
    message: 'This status transition is not permitted',
    path: ['to'],
  });

export const noteBodySchema = z.object({
  body: z.string().trim().min(1, 'Note cannot be empty'),
});

// Single source of truth for "is this profile.role one of the roles allowed
// to act as admission-review staff". Import this everywhere the check is
// needed (page.tsx's page-level gate, actions.ts's requireStaffCaller, and
// the authorization test) instead of re-implementing the role list, so the
// two-role list only ever needs to change in one place.
export const ADMISSION_STAFF_ROLES = ['registration_admission_manager', 'super_admin'] as const;
export function isAdmissionStaffRole(role: string | null | undefined): boolean {
  return role != null && (ADMISSION_STAFF_ROLES as readonly string[]).includes(role);
}
