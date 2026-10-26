// tests/participant/my-profile-identity-live.test.ts
//
// saveIdentity validates its required fields (fullName/email/phone/
// avatarPath) as the very first statement in the function body, before
// it ever calls createClient() -- which depends on Next.js's
// request-scoped cookies()/headers() context and would throw outside a
// real request (as here, invoked directly from a Vitest process). That
// ordering means these 3 assertions DO genuinely exercise the real
// required-field validation branch, not a "Not authenticated"
// short-circuit -- unlike what an earlier version of this comment
// claimed. saveAccommodation (my-profile-accommodation-live.test.ts)
// follows this same validate-before-createClient() ordering, for the
// identical reason.
//
// What these assertions still cannot prove: the ownership check or the
// actual profiles/auth.updateUser() write path for a real authenticated
// user -- that requires a real request context, which only manual
// browser verification or a future Playwright-style test can provide.
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
