// src/lib/auth/require-super-admin.ts
//
// Extracted from src/app/[locale]/(admin)/staff/actions.ts and
// src/app/[locale]/(admin)/staff/assignments/actions.ts. These two
// files' local copies were NOT identical before this extraction —
// assignments/actions.ts's version also returned `userId` (the caller's
// own profile id, used for `created_by` on inserts) and queried
// `profiles.select('id, role')` instead of just `role`. This shared
// version uses assignments/actions.ts's superset shape so both files'
// existing usages keep working: staff/actions.ts's 3 call sites only
// ever destructured `{ service }` and are unaffected by the extra field.
//
// Any Server Action that must be callable by super_admin only (not any
// staff role) uses this — do not use isStaffRole/is_staff() for this
// purpose, which is deliberately broader.
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export async function requireSuperAdmin() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    throw new Error('Unauthenticated');
  }
  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('id, role').eq('id', user.id).single();
  if (!profile || profile.role !== 'super_admin') {
    throw new Error('Forbidden: super_admin only');
  }
  return { service, userId: profile.id };
}
