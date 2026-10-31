# "Add Participant" Form (super_admin) — Design Spec

**Date:** 2026-11-01
**Status:** Approved by user.

## Problem

There is currently no way to create a single new `applications` row
directly from the admin UI. The only existing creation path is the
multi-step CSV import pipeline (`/participants/import/...`), which is
overkill for a one-off manual addition. `/applications` (the real
participant list page, `/participants` is a transparent redirect to it)
has no "Add" or "New" entry point at all today.

## What already exists and will be reused unchanged

- **`requireSuperAdmin()`** (`src/lib/auth/require-super-admin.ts`) —
  the existing super_admin-only Server Action guard, already used by
  `staff/actions.ts`. Reused as-is for the new create action.
- **`next_application_number()`** — existing Postgres function that
  assigns the next sequential application number. Reused as-is; this
  form never lets the admin type one in.
- **The existing invitation system** (`src/lib/import/invitation.ts`'s
  `sendInvitation`, already wired into
  `participants/[applicationId]/invitation-controls.tsx` on the
  application detail page) — reused completely unchanged. Creating the
  application here does NOT send an invitation itself; the super_admin
  lands on the new application's detail page afterward and clicks the
  already-existing "Send Invitation" button there, exactly as they
  would for an imported row.

## What's new

### 1. "Add Participant" button

Added to `/applications` (the real list page), which currently has no
such entry point. Links to a new `/applications/new` page.

### 2. `/applications/new` page + form

Gated identically to `staff/page.tsx`'s pattern: `requireSuperAdmin`-
equivalent page-level check (`profile.role !== 'super_admin'` →
`notFound()`), so this page 404s for anyone who isn't a super_admin
(including general `staff` accounts) — intentionally narrower than the
general `isStaffRole` check most of `/applications`'s other admin pages
use, matching the user's explicit "super_admin" framing for this task.

**Form fields:**
- Full name (required)
- Email (required) — becomes `imported_email`, the same column the CSV
  import pipeline populates and `sendInvitation` reads from.
- Participant type (required) — `delegate` / `volunteer` /
  `knowledge_partner` / `youngo` / `speaker` (the real
  `participant_type` enum, same values `staff-manager.tsx`'s STAFF_ROLES
  pattern — not that enum, but the same "const array + Select options"
  shape — would use).
- Phone, country, nationality, organization (all optional) — the
  smallest useful subset of the import pipeline's optional columns, not
  its full ~20-column spread.

No status field in the form — the created row is always inserted with
`status: 'accepted'` directly (not `'draft'`), since an admin manually
adding someone has, by construction, already decided to accept them;
there is no meaningful "manually add as draft" use case this task needs
to support.

### 3. New Server Action: `createParticipantApplication`

```
'use server'
requireSuperAdmin() guard
zod-validated input (fullName, email, participantType, + optional fields)
1. Call next_application_number() via RPC for the new application_number
2. Insert into `applications`: application_number, full_name, imported_email,
   participant_type, status: 'accepted', applicant_id: null, plus whatever
   optional fields were filled in
3. Return the new application's id
```

The page then redirects (client-side, via the existing
`useRouter()`-after-server-action pattern `staff-manager.tsx` already
uses) to `/applications/{newId}`, where the existing detail page and its
existing "Send Invitation" button take over.

## Explicitly out of scope

- No new invitation-sending code — the existing system handles it once
  the admin reaches the detail page.
- No bulk/multi-row creation — this is strictly a single-record form,
  the CSV import pipeline remains the tool for bulk additions.
- No full field parity with the CSV import's ~20+ optional columns —
  only the handful listed above. An admin who needs to fill in more
  detail can do so afterward on the existing application-detail edit
  forms (`general-info-controls.tsx` and friends), which already cover
  every other field.
- No change to `requireSuperAdmin`, `next_application_number()`, or any
  part of the invitation system.
