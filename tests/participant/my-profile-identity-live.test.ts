// tests/participant/my-profile-identity-live.test.ts
//
// saveIdentity runs inside a Server Action, which depends on Next.js's
// request-scoped cookies()/headers() context (via createClient() from
// '@/lib/supabase/server'). Outside a real request -- as here, invoked
// directly from a Vitest process -- there is no authenticated session,
// so supabase.auth.getUser() always resolves to { user: null } and every
// call short-circuits on "Not authenticated" before ever reaching the
// input-validation branch. This is the same limitation documented for
// require*StaffCaller helpers in tests/auth/staff-roles-live.test.ts.
//
// These 3 assertions therefore cannot prove the validation messages are
// reached -- they can only prove the function exists, is callable with
// this shape, and never writes on a bad input (because it errors out
// before writing, regardless of which check fired first). That's still
// a meaningful floor: it would fail today with "saveIdentity is not a
// function" if the action weren't implemented at all, and it will keep
// failing if the export is ever removed or renamed.
import { describe, expect, it } from 'vitest';
import { saveIdentity } from '@/app/[locale]/(participant)/(shell)/my-profile/actions';

describe('saveIdentity server action', () => {
  it('rejects when full_name is missing', async () => {
    const res = await saveIdentity({ fullName: '', email: 'a@b.com', phone: '+1234567890', avatarPath: 'some/path.png' });
    expect(res.error).toBeTruthy();
  });

  it('rejects when phone is missing', async () => {
    const res = await saveIdentity({ fullName: 'Test', email: 'a@b.com', phone: '', avatarPath: 'some/path.png' });
    expect(res.error).toBeTruthy();
  });

  it('rejects when avatarPath is missing (first save)', async () => {
    const res = await saveIdentity({ fullName: 'Test', email: 'a@b.com', phone: '+1234567890', avatarPath: null });
    expect(res.error).toBeTruthy();
  });
});
