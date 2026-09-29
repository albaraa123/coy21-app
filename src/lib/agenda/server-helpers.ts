// src/lib/agenda/server-helpers.ts
//
// NOTE: `import 'server-only'` is intentionally omitted here. The `server-only`
// package is not currently an installed dependency of this project (verified
// via `npm ls server-only`, which resolves to nothing), and the plan's
// documented fallback for that case is to omit the import rather than add a
// new dependency without checking first. This module is only ever imported
// from `'use server'` action files, matching the same convention Phase 1/2
// already rely on.
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import type { Json } from '@/types/database';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

// The service-role client bypasses RLS entirely, so this role check — not
// RLS — is the actual authorization gate for every write made by callers of
// this helper. Every exported agenda server action must call this before any
// service-role read/write, and must not contain an early return that skips
// it. Mirrors Phase 2's requireStaffCaller in
// src/app/[locale]/(admin)/applications/[id]/actions.ts.
export async function requireAgendaStaffCaller(): Promise<{ userId: string; service: ServiceClient }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
  // Single source of truth for this check is isStaffRole
  // (src/lib/auth/is-staff-role.ts) — update that helper, not this call
  // site, if the allowed role set changes.
  if (!isStaffRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, service };
}

export async function writeAuditLog(
  service: ServiceClient,
  entry: {
    entityType: string;
    entityId: string;
    action: string;
    actorId: string;
    requestId?: string;
    metadata?: Record<string, unknown>;
    oldValues?: Record<string, unknown> | null;
    newValues?: Record<string, unknown> | null;
  }
): Promise<void> {
  // Wrapped in try/catch, not just an error-return check: supabase-js
  // serializes the insert payload via JSON.stringify under the hood, which
  // throws synchronously (not via the returned `error`) on a circular
  // reference in metadata/oldValues/newValues. Without this wrapper, that
  // throw would propagate out of writeAuditLog and break its documented
  // "logs and continues, never throws" contract for every caller.
  try {
    const { error } = await service.from('audit_logs').insert({
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      action: entry.action,
      actor_type: 'admin',
      actor_id: entry.actorId,
      request_id: entry.requestId ?? null,
      // Record<string, unknown> isn't structurally assignable to the generated
      // Json type (unknown isn't assignable to Json), even though any plain
      // JSON-serializable object satisfies it at runtime. Callers are
      // responsible for only passing JSON-serializable values.
      metadata: (entry.metadata ?? null) as Json | null,
      old_values: (entry.oldValues ?? null) as Json | null,
      new_values: (entry.newValues ?? null) as Json | null,
    });
    if (error) {
      // Audit log failure should not silently corrupt the caller's understanding
      // of whether the underlying write succeeded — log loudly, but the caller
      // decides whether a failed audit write should fail the whole operation
      // (see each entity action; the default is: log and continue, same as
      // Phase 1/2's email_log/history-insert failure handling, since the
      // primary write already succeeded and blocking on audit-log failure would
      // make agenda editing hostage to a secondary system).
      console.error('writeAuditLog: failed to insert audit log row', { entry, error });
    }
  } catch (err) {
    console.error('writeAuditLog: threw while inserting audit log row', { entry, err });
  }
}
