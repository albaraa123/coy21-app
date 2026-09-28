// src/lib/auth/find-user-by-email.ts
//
// Extracted from src/lib/import/invitation.ts (Phase C, design doc section
// 14.1/14.3) so the admin-controlled account-provisioning flow can reuse
// the exact same lookup the pre-existing email-invite flow already relies
// on, instead of a second, independently-maintained copy. Behavior is
// unchanged from the original — see the doc comment below for the full
// rationale, preserved verbatim from invitation.ts.
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

/**
 * listUsers() scaling investigation (originally Task 20, src/lib/import/invitation.ts).
 *
 * Checked this project's actual @supabase/auth-js version
 * (node_modules/@supabase/auth-js/dist/main/GoTrueAdminApi.d.ts):
 *
 *   - listUsers(params?: PageParams): "Defaults to return 50 users per
 *     page." An unparameterized call is NOT "all users" — it silently
 *     truncates, so a naive existing-user check would false-negative on
 *     any project with more than 50 Auth users.
 *   - There is no direct getUserByEmail-equivalent on GoTrueAdminApi in
 *     this SDK version (only getUserById, which needs the id we don't have
 *     yet — that's the whole problem).
 *
 * Resolution: paginate through every page via `page`/`perPage` until a page
 * comes back short of `perPage`, rather than trusting `lastPage`/`total`.
 * Uses a generous perPage (1000) to keep the page count small for a
 * project with thousands of imported participants.
 *
 * Known residual gap: GoTrue orders listUsers by created_at DESC. A user
 * created concurrently with this scan lands at the FRONT of the list,
 * shifting every not-yet-fetched page's window by one — so a genuinely
 * existing user positioned near a page boundary can be skipped, a false
 * negative on exactly the check this function exists to provide. Low
 * probability, and the durable fix is a DB-side unique guard rather than a
 * list-and-scan — every caller of this function must have a recoverable
 * path for a missed collision (GoTrue itself enforces email uniqueness at
 * the createUser layer, so a missed collision surfaces as a create failure,
 * not a silent duplicate account).
 */
export async function findExistingAuthUserByEmail(service: ServiceClient, email: string): Promise<User | null> {
  const normalized = email.toLowerCase();
  const perPage = 1000;
  let page = 1;
  for (;;) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Failed to list existing Auth users: ${error.message}`);
    const match = data.users.find((u) => u.email?.toLowerCase() === normalized);
    if (match) return match;
    if (data.users.length < perPage) return null; // short page — this was the last one
    page += 1;
  }
}
