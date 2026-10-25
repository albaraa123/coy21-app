// tests/participant/my-profile-accommodation-live.test.ts
//
// saveAccommodation runs inside a Server Action, which depends on Next.js's
// request-scoped cookies()/headers() context (via createClient() from
// '@/lib/supabase/server'). Outside a real request -- as here, invoked
// directly from a Vitest process -- calling cookies() throws ("called
// outside a request scope") rather than resolving to a null session. For
// that reason -- and mirroring saveIdentity's own ordering in
// tests/participant/my-profile-identity-live.test.ts -- the required-field
// check in saveAccommodation runs before createClient()/cookies() is ever
// called, so these two inputs are rejected by that same validation this
// task adds, without needing a real request scope or session.
//
// These assertions therefore prove the required-field validation itself
// (missing hotel_name / missing location_note both reject with an error),
// not the full authenticated-write path -- they cannot prove the ownership
// check or upsert ever run correctly for a real user. This is the same
// limitation documented for require*StaffCaller helpers in
// tests/auth/staff-roles-live.test.ts. Manual browser verification (done
// later, outside this task) is what proves the end-to-end required-field
// behavior for an authenticated user.
import { describe, expect, it } from 'vitest';
import { saveAccommodation } from '@/app/[locale]/(participant)/(shell)/my-profile/actions';

describe('saveAccommodation server action', () => {
  it('rejects when hotel_name is missing', async () => {
    const res = await saveAccommodation('fake-app-id', { hotel_name: '', location_note: 'near venue', room_number: '' });
    expect(res.error).toBeTruthy();
  });

  it('rejects when location_note is missing', async () => {
    const res = await saveAccommodation('fake-app-id', { hotel_name: 'Akra', location_note: '', room_number: '' });
    expect(res.error).toBeTruthy();
  });
});
