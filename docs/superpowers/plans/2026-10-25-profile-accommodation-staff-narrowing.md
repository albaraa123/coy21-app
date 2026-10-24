# Profile Fields, Accommodation Requirements, Local Info Cleanup, and Staff Role Narrowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 required identity fields to My Profile, require 2 of 3 Accommodation fields, clean up 3 Local Info Hub content rows, and narrow the `staff` role down to scanner + attendance access only (reversing last month's broad consolidation).

**Architecture:** Six mostly-independent tasks. Tasks 1-3 are additive feature/content work in the participant-facing app. Task 4 is the large one: 8 defense-in-depth layers (route allowlist predicate, nav visibility, middleware pathname forwarding + layout redirect, post-login destination, API route guards, Server Action helper patches including one helper split, RLS policy migration, and live-test fixes) that together redefine what `staff` can reach. Task 5 is final verification against the full original 7-part request. Each task is a separate commit; Task 4 is further split into sequential sub-steps since its layers depend on each other (the predicate must exist before anything can call it).

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + RLS + Storage + Auth), TypeScript, Vitest, next-intl.

**Spec:** `docs/superpowers/specs/2026-10-25-profile-accommodation-staff-narrowing-design.md` (read this first — it has the full reasoning behind every decision below; this plan only restates what's needed to execute).

---

## Before starting

This plan was written in worktree `.worktrees/profile-accommodation-staff-cr` (branch `feature/profile-accommodation-staff-cr`), which already exists with the spec committed. Continue working in this worktree — do not create a new one.

**Project-wide standing rules** (from CLAUDE.md / established session discipline — still apply):
- Never store/handle real user passwords directly.
- Never use Docker for this project.
- Before any live Supabase action, verify the linked project via `supabase projects list` (must show `vfwcbkjvinbtcntwjrzq` — this is the one and only real COY21 project; a different project ref showing up means something is misconfigured, stop and ask).
- `supabase db push` has a known FK bug on this project — use `supabase db query --linked --file <path>` instead, or hand the SQL to the user to run via the Supabase Dashboard SQL Editor if the CLI auth token is stale.
- Every commit ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

### Task 1: My Profile — add Name, Email, Phone, Profile Picture (required)

**Files:**
- Modify: `src/app/[locale]/(participant)/(shell)/my-profile/page.tsx` (add identity data fetch + render `IdentityForm`)
- Modify: `src/app/[locale]/(participant)/(shell)/my-profile/profile-forms.tsx` (add `IdentityForm` export)
- Modify: `src/app/[locale]/(participant)/(shell)/my-profile/actions.ts` (add `saveIdentity`, `IdentityInput` type)
- Create: `supabase/migrations/20261025000000_add_profile_identity_fields.sql`
- Create: `supabase/migrations/20261025000100_avatars_bucket.sql`
- Create: `supabase/migrations/20261025000200_narrow_profiles_email_grant.sql`
- Create: `supabase/migrations/20261025000300_sync_profile_email_on_confirm.sql`
- Test: `tests/participant/my-profile-identity-live.test.ts`

This task has 5 steps because it touches DB schema, Storage, Auth triggers, and UI. Work through them in order — later steps depend on earlier ones existing in the live database.

#### Step 1.1: Add `profiles.phone` and `profiles.avatar_path` columns

- [ ] Write the migration:

```sql
-- supabase/migrations/20261025000000_add_profile_identity_fields.sql
--
-- My Profile gains editable Name/Email/Phone/Photo fields (see
-- docs/superpowers/specs/2026-10-25-profile-accommodation-staff-narrowing-design.md
-- Item 1). full_name and email already exist on profiles (set once at
-- signup by handle_new_user(), never previously user-editable). phone and
-- avatar_path are new. Both nullable -- "required" is enforced at the
-- application layer only (client + server validation in actions.ts),
-- matching this codebase's existing pattern for every other "required"
-- field (e.g. the admin manager forms) -- not a DB-level NOT NULL, to
-- avoid breaking any existing profile row.
alter table profiles add column phone text;
alter table profiles add column avatar_path text;
```

- [ ] Verify the linked project before running anything live: `supabase projects list` (confirm `vfwcbkjvinbtcntwjrzq`).
- [ ] Apply via `supabase db query --linked --file supabase/migrations/20261025000000_add_profile_identity_fields.sql` (the established workaround for this project's `db push` FK bug). If the CLI auth token is stale, hand the exact SQL to the user to run via the Supabase Dashboard SQL Editor, with the instruction: "if error, stop and send me the exact message, don't retry."
- [ ] Commit:

```bash
git add supabase/migrations/20261025000000_add_profile_identity_fields.sql
git commit -m "feat: add profiles.phone and profiles.avatar_path columns

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 1.2: Create the `avatars` Storage bucket

Template: `supabase/migrations/20260823000000_participant_documents_bucket.sql` (read it — folder-prefix path convention, explicit `file_size_limit`/`allowed_mime_types`, one `for all`-shaped policy per role). The avatar bucket needs a new `is_super_admin()` helper (built in Task 4, Step 4.8 below) for its staff/admin read-all policy — **this step comes first and creates the bucket + the participant-own-file policies only; the `super_admin`-read-all policy is added in Task 4, Step 4.8 once `is_super_admin()` exists.**

- [ ] Write the migration:

```sql
-- supabase/migrations/20261025000100_avatars_bucket.sql
--
-- Profile picture storage for My Profile's new IdentityForm. Follows the
-- same conventions as participant-documents and import-uploads buckets:
-- explicit file_size_limit/allowed_mime_types at creation, folder-prefixed
-- path convention ((storage.foldername(name))[1] = auth.uid()::text, NOT
-- a flat {uid}.ext filename), and a single `for all` policy per role
-- (not per-verb -- a missing UPDATE policy elsewhere in this codebase
-- silently broke upsert:true, which avatar replacement needs).
--
-- Staff/admin read-all is deliberately NOT added here -- it needs
-- is_super_admin(), added in a later migration as part of the staff
-- role narrowing (see 2026-10-25-profile-accommodation-staff-narrowing-
-- design.md Item 6, layer 8). This bucket is unusable by nobody except
-- the owning participant until that migration lands, which is fine --
-- both ship in the same PR.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  false,
  5242880, -- 5 MB
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

create policy "avatars_all_own"
  on storage.objects for all
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
```

- [ ] Apply via `supabase db query --linked --file supabase/migrations/20261025000100_avatars_bucket.sql` (same verify-project-first discipline as Step 1.1).
- [ ] Commit:

```bash
git add supabase/migrations/20261025000100_avatars_bucket.sql
git commit -m "feat: create avatars storage bucket for profile pictures

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 1.3: Narrow the `profiles.email` grant and add the post-confirmation sync trigger

Two migrations, order matters: narrow the grant first (closes the bypass), then add the trigger (the only thing that can still write `profiles.email` after this).

- [ ] Write the grant-narrowing migration:

```sql
-- supabase/migrations/20261025000200_narrow_profiles_email_grant.sql
--
-- 20260727000000_fix_profiles_role_privilege_escalation.sql:32 granted
-- `update (full_name, email) on profiles to authenticated`. Once My
-- Profile's email field goes through supabase.auth.updateUser({ email })
-- (Supabase's own confirm-by-link flow, see the next migration), this
-- grant would let a user bypass that confirmation flow entirely by
-- writing `update profiles set email = '...'` directly via the
-- Supabase client, landing an unconfirmed email straight into profiles.
-- Narrow the grant to full_name only -- profiles.email becomes writable
-- only by the new sync trigger (SECURITY DEFINER / table owner, not
-- subject to this grant), never directly by an authenticated client.
-- saveIdentity (my-profile/actions.ts) only ever calls
-- supabase.auth.updateUser({ email }), never writes profiles.email
-- directly, so this narrowing does not break the intended flow.
revoke update on profiles from authenticated;
grant update (full_name) on profiles to authenticated;
```

- [ ] **Before writing the next migration, verify `double_confirm_changes` on the LIVE linked project, not just local `supabase/config.toml`.** This repo has a documented history of local/remote config mismatches. Run (via a Node script using the service-role key, the established fallback pattern for this project) a check against the Auth settings, or ask the user to confirm in the Supabase Dashboard under Authentication → Settings → "Secure email change" is enabled. If it's OFF on the live project, STOP and surface this to the user before proceeding — the trigger below depends on it.
- [ ] Write the sync-trigger migration:

```sql
-- supabase/migrations/20261025000300_sync_profile_email_on_confirm.sql
--
-- supabase.auth.updateUser({ email }) triggers Supabase's own
-- confirmation-email flow. With double_confirm_changes = true (verified
-- on the live project before this migration was written -- see this
-- migration's own commit message), auth.users.email only updates AFTER
-- the user clicks the confirmation link, not optimistically. This
-- trigger syncs profiles.email from auth.users.email only when that
-- real, post-confirmation update happens -- profiles.email never shows
-- an unconfirmed email.
create or replace function sync_profile_email_on_confirm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles set email = new.email where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_confirmed on auth.users;
create trigger on_auth_user_email_confirmed
  after update of email on auth.users
  for each row
  execute function sync_profile_email_on_confirm();
```

- [ ] Apply both migrations in order via `supabase db query --linked --file <path>`.
- [ ] Commit (one commit per migration, matching the file-per-concern split):

```bash
git add supabase/migrations/20261025000200_narrow_profiles_email_grant.sql
git commit -m "fix: narrow profiles.email grant to prevent Auth-confirmation bypass

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git add supabase/migrations/20261025000300_sync_profile_email_on_confirm.sql
git commit -m "feat: sync profiles.email from auth.users only post-confirmation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 1.4: `saveIdentity` Server Action

**Files:** `src/app/[locale]/(participant)/(shell)/my-profile/actions.ts`

Template: the existing `saveAccommodation` in the same file (lines 89-113) — regular (RLS-respecting) `createClient()`, not service-role; verify-ownership-then-write pattern. `saveIdentity` is different in one respect: changing email must go through `supabase.auth.updateUser()`, not a direct table write.

- [ ] Write the failing test first (`tests/participant/my-profile-identity-live.test.ts`):

```typescript
// tests/participant/my-profile-identity-live.test.ts
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
```

(This test can't fully exercise the authenticated path outside a real request context — same limitation documented in `staff-roles-live.test.ts` for `require*StaffCaller` helpers. These 3 assertions only prove the function exists and the *shape* of its validation; they'll fail with "Not authenticated" before reaching the validation code, which still counts as "rejects," proving the action never writes on a bad input regardless of why. Note this limitation in a comment in the test file.)

- [ ] Run it, confirm it fails because `saveIdentity` doesn't exist yet: `npx vitest run tests/participant/my-profile-identity-live.test.ts`
- [ ] Implement `saveIdentity` in `actions.ts`:

```typescript
// Add to src/app/[locale]/(participant)/(shell)/my-profile/actions.ts

export type IdentityInput = {
  fullName: string;
  email: string;
  phone: string;
  avatarPath: string | null;
};

export async function saveIdentity(input: IdentityInput): Promise<{ error?: string }> {
  if (!input.fullName.trim() || !input.email.trim() || !input.phone.trim() || !input.avatarPath) {
    return { error: 'Name, email, phone, and a profile picture are required.' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  // full_name and avatar_path are plain profiles columns -- write directly.
  const { error: profileError } = await supabase
    .from('profiles')
    .update({ full_name: input.fullName, avatar_path: input.avatarPath, phone: input.phone })
    .eq('id', user.id);
  if (profileError) return { error: profileError.message };

  // email is NOT written to profiles directly (the grant no longer
  // allows it -- see 20261025000200_narrow_profiles_email_grant.sql).
  // Only call auth.updateUser if the email actually changed, to avoid
  // sending a needless confirmation email on every unrelated save.
  if (input.email.trim() !== user.email) {
    const { error: authError } = await supabase.auth.updateUser({ email: input.email });
    if (authError) return { error: authError.message };
  }

  return {};
}
```

- [ ] Run the test again, confirm the 3 rejection cases pass (still "Not authenticated" short-circuits them, which is an acceptable proxy per the note above — but confirm manually in the browser later in Task 5 that real validation also fires for an authenticated user).
- [ ] Commit:

```bash
git add src/app/[locale]/\(participant\)/\(shell\)/my-profile/actions.ts tests/participant/my-profile-identity-live.test.ts
git commit -m "feat: add saveIdentity server action for My Profile

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 1.5: `IdentityForm` component + page wiring + avatar upload

**Files:** `profile-forms.tsx`, `page.tsx`

- [ ] In `page.tsx`, fetch the current profile's identity fields alongside the existing `contacts`/`accommodation` fetch (add to the existing `Promise.all` at line 34):

```typescript
// Add a 3rd entry to the existing Promise.all array in page.tsx:
supabase
  .from('profiles')
  .select('full_name, email, phone, avatar_path')
  .eq('id', user.id)
  .single(),
```

Destructure the new `{ data: identity }` result and pass it to the new `<IdentityForm>`, rendered as the first `<Card>` in the page, above Emergency Contacts.

- [ ] Add `IdentityForm` to `profile-forms.tsx`, following `AccommodationForm`'s shape (local `useState` form, `useTransition` for save, inline error string — this feature area has no i18n today, confirmed by grep; match that, don't introduce `useTranslations` here). Avatar upload: a plain `<input type="file">` that uploads directly to the `avatars` bucket via `supabase.storage.from('avatars').upload(...)` client-side.

**Browser-client import — confirmed by direct read, use this exact name, do not invent `createBrowserClient`**: `src/lib/supabase/client.ts` exports a function literally named `createClient()` (it calls `@supabase/ssr`'s `createBrowserClient` internally, but does not re-export that name). This is a real naming collision risk: `my-profile/actions.ts` (the Server Action file `profile-forms.tsx` already imports from) has its own, different, server-side `createClient` from `@/lib/supabase/server`. `profile-forms.tsx` itself does not import either today (confirmed by grep — clean slate), so there's no collision *inside this file* either way, but **import the browser client with an explicit alias regardless**, so a future reader never has to wonder which `createClient` is in scope at a glance:

```typescript
import { createClient as createBrowserSupabaseClient } from '@/lib/supabase/client';
```

**Field-naming note, so this isn't mistaken for an error and "fixed" the wrong way**: `AccommodationInput` (the cited template) uses snake_case fields matching DB columns 1:1 (`hotel_name`, `location_note`, `room_number`). The `IdentityInput`/`Identity` sketch below uses camelCase (`fullName`, `avatarPath`) on the TS side while still writing snake_case DB columns (`full_name`, `avatar_path`) inside `saveIdentity`'s body. **This is a deliberate, acknowledged deviation, not an oversight to reconcile** — `saveIdentity` is the first action in this file to also touch Supabase Auth (`auth.updateUser({ email })`), which has its own camelCase-style JS API conventions, so this plan keeps the form layer in camelCase rather than forcing `AccommodationForm`'s snake-case convention onto a different kind of action. Do not rename `IdentityInput`'s fields to snake_case to "match the template" — that would break the `IdentityForm` sketch below, which calls `saveIdentity` with these exact camelCase keys.

```typescript
// Add to profile-forms.tsx, same file as AccommodationForm

type Identity = {
  full_name: string;
  email: string;
  phone: string | null;
  avatar_path: string | null;
};

export function IdentityForm({ initial }: { initial: Identity }) {
  const [form, setForm] = useState({
    fullName: initial.full_name,
    email: initial.email,
    phone: initial.phone ?? '',
  });
  const [avatarPath, setAvatarPath] = useState<string | null>(initial.avatar_path);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setError('Not authenticated'); return; }
      const ext = file.name.split('.').pop();
      const path = `${user.id}/avatar.${ext}`;
      const { error: uploadError } = await supabase.storage.from('avatars').upload(path, file, { upsert: true });
      if (uploadError) { setError(uploadError.message); return; }
      setAvatarPath(path);
    } finally {
      setUploading(false);
    }
  }

  function handleSave() {
    setSaved(false);
    setError(null);
    if (!form.fullName.trim() || !form.email.trim() || !form.phone.trim() || !avatarPath) {
      setError('Name, email, phone, and a profile picture are required.');
      return;
    }
    startSave(async () => {
      const res = await saveIdentity({ ...form, avatarPath });
      if (res.error) { setError(res.error); return; }
      setSaved(true);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name *" value={form.fullName} onChange={(v) => setForm({ ...form, fullName: v })} />
        <Field label="Email *" value={form.email} onChange={(v) => setForm({ ...form, email: v })} type="email" />
        <Field label="Phone *" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} type="tel" />
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-charcoal/70 dark:text-gray-400">Profile Picture *</label>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleAvatarChange} disabled={uploading} />
          {avatarPath && <p className="text-xs text-green-600 dark:text-green-400">Photo on file.</p>}
        </div>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {saved && <p className="text-xs text-green-600 dark:text-green-400">Saved.</p>}
      <Button onClick={handleSave} disabled={isSaving || uploading} size="sm" className="self-start">
        {isSaving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}
```

- [ ] Manually test in the browser (dev server, sign in as the real participant test account `albaraak2002@gmail.com`): confirm the form renders, confirm save is blocked with no picture uploaded yet, confirm a picture upload + save succeeds, confirm editing just the phone number afterward (no new picture) still saves successfully (per the user-confirmed "required only on first save" rule).
- [ ] Commit:

```bash
git add src/app/[locale]/\(participant\)/\(shell\)/my-profile/profile-forms.tsx src/app/[locale]/\(participant\)/\(shell\)/my-profile/page.tsx
git commit -m "feat: add IdentityForm to My Profile page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Accommodation — require hotel_name and location_note

**Files:**
- Modify: `src/app/[locale]/(participant)/(shell)/my-profile/profile-forms.tsx` (`AccommodationForm`, lines 150-192)
- Modify: `src/app/[locale]/(participant)/(shell)/my-profile/actions.ts` (`saveAccommodation`, lines 89-113)
- Test: `tests/participant/my-profile-accommodation-live.test.ts` (new — spec confirmed no dedicated test file exists today)

- [ ] Write the failing test:

```typescript
// tests/participant/my-profile-accommodation-live.test.ts
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
```

- [ ] Run it, confirm both pass already (not because validation exists — because `saveAccommodation` currently returns `{ error: 'Not authenticated' }` for any caller outside a real session, same proxy-assertion caveat as Task 1). Note in a test comment that this only proves rejection-shape, not real field validation; Task 5's manual browser test is what proves the actual required-field behavior for an authenticated user.
- [ ] Add server-side validation to `saveAccommodation` (`actions.ts` line 89), inserting right after the ownership check (after line 103, before the upsert on line 105):

```typescript
  if (!input.hotel_name.trim() || !input.location_note.trim()) {
    return { error: 'Hotel name and location note are required.' };
  }
```

- [ ] Add client-side validation + `*` markers to `AccommodationForm` (`profile-forms.tsx`). Modify `handleSave` (line 166):

```typescript
  function handleSave() {
    setSaved(false);
    setError(null);
    if (!form.hotel_name.trim() || !form.location_note.trim()) {
      setError('Hotel name and location note are required.');
      return;
    }
    startSave(async () => {
      const res = await saveAccommodation(applicationId, form);
      if (res.error) { setError(res.error); return; }
      setSaved(true);
    });
  }
```

And update the two field labels (line 179, 182) to add `*`: `"Hotel / Accommodation name *"` and `"Location note *"`. `"Room number"` (line 180) stays without `*`.

- [ ] Manually test in the browser: confirm saving with hotel name + location note empty is blocked; confirm saving with only room number empty still succeeds.
- [ ] Commit:

```bash
git add src/app/[locale]/\(participant\)/\(shell\)/my-profile/profile-forms.tsx src/app/[locale]/\(participant\)/\(shell\)/my-profile/actions.ts tests/participant/my-profile-accommodation-live.test.ts
git commit -m "feat: require hotel_name and location_note in Accommodation form

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Local Info Hub — delete Safety & Health, update emergency contact, add Key Contacts, add linkify helper

**Files:**
- Create: `src/lib/content/linkify-contact-value.ts`
- Create: `src/lib/content/linkify-contact-value.test.ts`
- Modify: `src/app/[locale]/(participant)/(shell)/local-info/page.tsx` (lines 93-94, the item-rendering `<dd>`)
- Data changes via the admin UI (`/content/local-info`), not a migration

#### Step 3.1: `linkifyContactValue` helper (TDD)

- [ ] Write the failing test:

```typescript
// src/lib/content/linkify-contact-value.test.ts
import { describe, expect, it } from 'vitest';
import { linkifyContactValue } from './linkify-contact-value';

describe('linkifyContactValue', () => {
  it('wraps an embedded tel: URI in a link, leaving surrounding text plain', () => {
    const result = linkifyContactValue('Safeguarding Contact: Ayan Valizada — tel:+994997368333');
    expect(result).toEqual([
      { type: 'text', value: 'Safeguarding Contact: Ayan Valizada — ' },
      { type: 'link', href: 'tel:+994997368333', value: 'tel:+994997368333' },
    ]);
  });

  it('wraps an embedded mailto: URI in a link', () => {
    const result = linkifyContactValue('Official Liaison Email: mailto:liaisons@climatecoy.com');
    expect(result).toEqual([
      { type: 'text', value: 'Official Liaison Email: ' },
      { type: 'link', href: 'mailto:liaisons@climatecoy.com', value: 'mailto:liaisons@climatecoy.com' },
    ]);
  });

  it('returns a single plain text segment when there is no tel:/mailto: URI', () => {
    const result = linkifyContactValue('Available 9am-5pm daily');
    expect(result).toEqual([{ type: 'text', value: 'Available 9am-5pm daily' }]);
  });
});
```

- [ ] Run it, confirm it fails (`linkify-contact-value.ts` doesn't exist): `npx vitest run src/lib/content/linkify-contact-value.test.ts`
- [ ] Implement:

```typescript
// src/lib/content/linkify-contact-value.ts
//
// Local Info Hub items store `value` as plain text. 3 rows (the
// Safeguarding Contact, and the 2 new Key Contacts email items) need an
// embedded tel:/mailto: URI rendered as a real clickable link, without
// turning the data model into a link-parsing minefield for every other
// row (Water, Currency, Prayer times, Police, etc., which all stay plain
// text, untouched). Convention: the admin pastes a literal tel:+994...
// or mailto:foo@bar URI anywhere in the value string; this function
// finds it via regex and splits the string into plain-text and link
// segments around it. No special data-entry convention beyond that.
export type ContactValueSegment =
  | { type: 'text'; value: string }
  | { type: 'link'; href: string; value: string };

const CONTACT_URI_PATTERN = /\b(tel:\+?\d+|mailto:[^\s]+)\b/;

export function linkifyContactValue(value: string): ContactValueSegment[] {
  const match = value.match(CONTACT_URI_PATTERN);
  if (!match) {
    return [{ type: 'text', value }];
  }
  const segments: ContactValueSegment[] = [];
  const before = value.slice(0, match.index);
  const after = value.slice((match.index ?? 0) + match[0].length);
  if (before) segments.push({ type: 'text', value: before });
  segments.push({ type: 'link', href: match[0], value: match[0] });
  if (after) segments.push({ type: 'text', value: after });
  return segments;
}
```

- [ ] Run the test again, confirm all 3 pass.
- [ ] Commit:

```bash
git add src/lib/content/linkify-contact-value.ts src/lib/content/linkify-contact-value.test.ts
git commit -m "feat: add linkifyContactValue helper for Local Info Hub

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 3.2: Wire the helper into the Local Info page

- [ ] In `src/app/[locale]/(participant)/(shell)/local-info/page.tsx`, replace line 94's plain `<dd>{item.value}</dd>` with a render using `linkifyContactValue`:

```typescript
import { linkifyContactValue } from '@/lib/content/linkify-contact-value';

// Replace line 94:
<dd className="text-sm text-charcoal/70 dark:text-gray-400">
  {linkifyContactValue(item.value).map((seg, i) =>
    seg.type === 'link' ? (
      <a key={i} href={seg.href} className="text-turquoise hover:underline">{seg.value}</a>
    ) : (
      <span key={i}>{seg.value}</span>
    )
  )}
</dd>
```

- [ ] Commit:

```bash
git add src/app/[locale]/\(participant\)/\(shell\)/local-info/page.tsx
git commit -m "feat: render tel:/mailto: links in Local Info Hub items

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 3.3: Content changes via the admin UI (manual, not code)

Do this live, against the real linked Supabase project, via `/content/local-info` in the running app (signed in as `super_admin`). **Verify the linked project first** (`supabase projects list` → `vfwcbkjvinbtcntwjrzq`).

- [ ] Delete the "Safety & Health" section (cascades to its 3 items: Water, Currency, Prayer times).
- [ ] Edit the "COY21 Emergency Line" item (inside "Emergency Numbers") — change its `value` from `'TBC by Organising Team'` to: `Safeguarding Contact: Ayan Valizada — tel:+994997368333` (the literal `tel:` URI embedded, per the linkify convention).
- [ ] Add two new items to the "Key Contacts" section:
  - Label: "Official Liaison Email", Value: `mailto:liaisons@climatecoy.com`
  - Label: "COY21 Support Email", Value: `mailto:admin@climatecoy.com`
- [ ] Verify in the browser at `/local-info` (signed in as a participant): confirm Safety & Health no longer appears, confirm the Safeguarding Contact phone number renders as a tappable link, confirm both new Key Contacts emails render as tappable `mailto:` links.
- [ ] No commit needed for this step (pure data change) — but add a line to `docs/pre-launch-checklist.md` noting the change, per this project's standing documentation discipline.

---

### Task 4: Staff role narrowing — scanner + attendance only

This is the large task. Follow the spec's 8 layers in order — several depend on earlier ones. Read `docs/superpowers/specs/2026-10-25-profile-accommodation-staff-narrowing-design.md`'s full "Item 6" section before starting; this plan gives exact steps but the spec has the full reasoning for each.

**Final scope** (confirmed): `staff` keeps `/attendance/walk-in` and `/attendance/admissions` only. Everything else is removed. `super_admin` and `scanner_device` are completely unaffected.

#### Step 4.1: New route-allowlist predicate

**Files:** Create `src/lib/auth/staff-allowed-routes.ts`, `src/lib/auth/staff-allowed-routes.test.ts`

- [ ] Write the failing test:

```typescript
// src/lib/auth/staff-allowed-routes.test.ts
import { describe, expect, it } from 'vitest';
import { isRouteAllowedForStaff } from './staff-allowed-routes';

describe('isRouteAllowedForStaff', () => {
  it('allows staff on /attendance/walk-in', () => {
    expect(isRouteAllowedForStaff('staff', '/attendance/walk-in')).toBe(true);
  });
  it('allows staff on a nested path under /attendance/admissions', () => {
    expect(isRouteAllowedForStaff('staff', '/attendance/admissions/123')).toBe(true);
  });
  it('rejects staff on /attendance/scanners', () => {
    expect(isRouteAllowedForStaff('staff', '/attendance/scanners')).toBe(false);
  });
  it('rejects staff on /dashboard', () => {
    expect(isRouteAllowedForStaff('staff', '/dashboard')).toBe(false);
  });
  it('always allows super_admin regardless of path', () => {
    expect(isRouteAllowedForStaff('super_admin', '/dashboard')).toBe(true);
  });
  it('always allows scanner_device regardless of path (not narrowed by this check)', () => {
    expect(isRouteAllowedForStaff('scanner_device', '/dashboard')).toBe(true);
  });
});
```

- [ ] Run it, confirm it fails (module doesn't exist).
- [ ] Implement:

```typescript
// src/lib/auth/staff-allowed-routes.ts
//
// Narrows WHERE a `staff` account can go, without touching isStaffRole
// (WHETHER someone is staff). Only `staff` is restricted by this check --
// super_admin and scanner_device pass through unconditionally, since
// this predicate's whole purpose is the staff-specific reversal of the
// 2026-09-29 consolidation (see
// docs/superpowers/specs/2026-10-25-profile-accommodation-staff-narrowing-design.md).
export const STAFF_ALLOWED_HREFS = ['/attendance/walk-in', '/attendance/admissions'] as const;

function matchesAllowedHref(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isRouteAllowedForStaff(role: string | null | undefined, pathname: string): boolean {
  if (role !== 'staff') {
    return true;
  }
  return STAFF_ALLOWED_HREFS.some((href) => matchesAllowedHref(pathname, href));
}
```

- [ ] Run the test again, confirm all 6 pass.
- [ ] Commit:

```bash
git add src/lib/auth/staff-allowed-routes.ts src/lib/auth/staff-allowed-routes.test.ts
git commit -m "feat: add isRouteAllowedForStaff route predicate

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 4.2: Nav visibility — per-href for staff

**Files:** Modify `src/lib/nav/admin-nav-visibility.ts`, its existing test file (find via `Glob src/lib/nav/admin-nav-visibility.test.ts`)

- [ ] Read the existing test file first to see its current assertions (they assert the current all-or-nothing boolean behavior — several will need updating, not just adding to).
- [ ] Update `filterAdminNavGroups` to branch per-href for `staff` specifically, using the Step 4.1 predicate; every other role's behavior is unchanged:

```typescript
// Replace the body of filterAdminNavGroups in admin-nav-visibility.ts
import { isStaffRole } from '@/lib/auth/is-staff-role';
import { isRouteAllowedForStaff } from '@/lib/auth/staff-allowed-routes';

export function filterAdminNavGroups(
  navGroups: NavGroup[],
  role: string | null | undefined
): NavGroup[] {
  if (!isStaffRole(role)) {
    return [];
  }
  if (role === 'staff') {
    return navGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => isRouteAllowedForStaff('staff', item.href)),
      }))
      .filter((group) => group.items.length > 0);
  }
  return navGroups.filter((group) => group.items.length > 0);
}
```

- [ ] Update the test file: keep assertions for `super_admin` (unchanged — sees everything), add new assertions for `staff` (sees only the Attendance group, and within it only `walkIn` and `admissions` items — `scanners`, `demand`, `opsDashboard` must be absent).
- [ ] Run the full test file, confirm green.
- [ ] Commit:

```bash
git add src/lib/nav/admin-nav-visibility.ts src/lib/nav/admin-nav-visibility.test.ts
git commit -m "feat: narrow staff nav visibility to walk-in and admissions only

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 4.3: Middleware pathname forwarding + layout-level redirect

**Files:** Modify `src/proxy.ts`, `src/app/[locale]/(admin)/layout.tsx`

- [ ] Update `src/proxy.ts` to forward the real pathname via a request header before running the existing `next-intl` middleware. **Confirmed against this project's exact installed Next.js version's own bundled docs** (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`, "Setting Headers" section, Next.js 16.2.11 — the version in this repo's `package.json`/lockfile): plain `request.headers.set(...)` inside proxy/middleware does **not** propagate to the Server Component request — that mutation is effectively local to the proxy's own execution. The ONLY documented way to make a request header available upstream to Server Components is `NextResponse.next({ request: { headers } })` — note this is NOT the same as `NextResponse.next({ headers })`, which instead sets a *response* header visible to the client, not the Server Component. This is settled, not a live unknown — use this form, no fallback needed:

**Confirmed by reading `next-intl`'s actual compiled source** (`node_modules/next-intl/dist/esm/production/middleware/middleware.js`, v4.13.3, the exact version pinned in this repo's `package.json`): `createMiddleware(routing)` always returns a real `NextResponse` — every internal branch returns `NextResponse.next(...)`, `.rewrite(...)`, or `.redirect(...)` (it never returns `undefined`/void). This matters because it rules out one tempting composition approach: wrapping whatever `intlMiddleware(request)` returns in a fresh `NextResponse.next({...})` would silently convert a real locale redirect/rewrite into a plain 200 pass-through, breaking i18n routing. **The correct composition is the other direction: attach the new header to the `request` object BEFORE calling `intlMiddleware`, so next-intl's own response (whichever of `.next()`/`.rewrite()`/`.redirect()` it picks) is already built from a request that carries the header** — `NextRequest` is a subclass of the standard `Request`, and its `headers` can be set via the constructor:

```typescript
// src/proxy.ts — modify the existing export
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { NextRequest } from 'next/server';

const intlMiddleware = createMiddleware(routing);

// (admin)/layout.tsx needs the real request pathname to decide whether a
// `staff` caller is allowed on this route (see isRouteAllowedForStaff),
// but Next.js Server Component layouts never receive pathname as a prop.
// Forwarding it via a request header here -- the one place that does see
// the real URL before render -- avoids adding a second Supabase auth
// round-trip to every matched request (which a middleware-side auth
// check would require); the layout already fetches profile.role itself.
//
// Confirmed against this project's exact Next.js 16.2.11 docs
// (proxy.md's "Setting Headers" section): only
// NextResponse.next({ request: { headers } }) makes a header visible to
// Server Components -- plain request.headers.set(...) does not
// propagate, and NextResponse.next({ headers }) sets a response header
// visible to the client instead. But next-intl's own createMiddleware
// (confirmed by reading its compiled source, v4.13.3) always returns its
// OWN NextResponse (next/rewrite/redirect, chosen internally) -- so
// re-wrapping its result in a second NextResponse.next({...}) here would
// silently discard a real locale redirect/rewrite. Fix: build a NEW
// NextRequest carrying the extra header, and pass THAT into
// intlMiddleware, so whichever response next-intl produces is already
// built from a request that has the header -- no post-hoc merging.
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);
  const requestWithPathname = new NextRequest(request.url, {
    headers: requestHeaders,
    // Preserve everything else about the original request (method,
    // body, etc.) by spreading it as the base init, with our header
    // override layered on top.
    ...request,
  });
  return intlMiddleware(requestWithPathname);
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
```

- [ ] **Manual test this specific mechanism FIRST, before writing any other Step 4.3 code** (promoted from a trailing aside to a blocking first action, per plan review): start the dev server, add a temporary `console.log((await headers()).get('x-pathname'))` at the top of `(admin)/layout.tsx`, navigate to any admin page, and confirm the real pathname prints (not `null`, not the previous page's stale value). Also confirm a locale-prefix redirect (visit a bare `/` or an un-prefixed path, if this app's locale routing produces a redirect for that case) still works correctly — i.e. confirm the header-forwarding change did not break next-intl's own redirect/rewrite behavior. Remove the temporary log once both are confirmed. **If `new NextRequest(request.url, { ...request, headers: requestHeaders })` does not correctly clone the original request (spreading a `Request`/`NextRequest` instance via `...request` does not reliably copy its internals the way spreading a plain object does — this is a real risk with this exact construction, not just a formality to check)**, stop and use the documented-safe alternative instead: pass `requestHeaders` to `intlMiddleware` by mutating the clone Next's own docs show (`const requestHeaders = new Headers(request.headers); requestHeaders.set(...)`) and reconstructing via `new Request(request, { headers: requestHeaders })` (the standard `Request` constructor's documented clone-with-overrides form, which — unlike spreading — is specified to copy the original request's method/body/etc.), then wrap that in `new NextRequest(...)` only if `intlMiddleware` requires the Next-specific type at the type level (check whether a plain cloned `Request` satisfies its parameter type first, since `NextRequest` adds `nextUrl`/`cookies` that a bare clone would lack).

- [ ] Update `(admin)/layout.tsx`: add the pathname read and the staff-route check, right after `decideAdminAccess` is called (after line 63) and before the `unauthorized` branch is handled (before line 85), so a disallowed staff route gets its own specific redirect rather than falling into the generic `unauthorized` UI (staff IS authorized to be in the admin area generally — just not on this specific page):

```typescript
// Add imports to (admin)/layout.tsx
import { headers } from 'next/headers';
import { isRouteAllowedForStaff } from '@/lib/auth/staff-allowed-routes';

// Insert after `const decision = decideAdminAccess(user.id, profile?.role);` (line 63):
if (decision.kind === 'authorized' && profile?.role === 'staff') {
  const pathname = (await headers()).get('x-pathname') ?? '';
  if (!isRouteAllowedForStaff('staff', pathname)) {
    redirect({ href: '/attendance/walk-in', locale });
    return;
  }
}
```

- [ ] Manually test: sign in as the real `staff` test account (`albaraaalbadwi@gmail.com`), navigate directly to `/dashboard` by URL, confirm redirect to `/attendance/walk-in`. Navigate to `/attendance/admissions`, confirm it loads normally (no redirect).
- [ ] Commit:

```bash
git add src/proxy.ts src/app/[locale]/\(admin\)/layout.tsx
git commit -m "feat: redirect staff away from disallowed admin routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 4.4: Post-login destination

**Files:** Modify `src/lib/auth/post-login-destination.ts`, its test file (`Glob` for it near this file)

- [ ] Update `resolvePostLoginDestination` (currently lines 68-85) to add a `staff` branch before the general `isNonParticipantRole` branch:

```typescript
// Insert in resolvePostLoginDestination, after the scanner_device check (line 80), before the isNonParticipantRole check:
if (role === 'staff') {
  return { href: '/attendance/walk-in' };
}
```

- [ ] Update the existing test file: add an assertion that `resolvePostLoginDestination('staff')` returns `{ href: '/attendance/walk-in' }`; keep the existing `super_admin` → `/dashboard` assertion unchanged.
- [ ] Run the test, confirm green.
- [ ] Commit:

```bash
git add src/lib/auth/post-login-destination.ts src/lib/auth/post-login-destination.test.ts
git commit -m "feat: send staff to /attendance/walk-in after login

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 4.5: API route guards

**Files:** Modify `src/app/api/admit-walk-in/route.ts`, `src/app/api/admission-staff-health/route.ts`, `src/app/api/admin/reports/participants-csv/route.ts`, `src/app/api/admission-staff-health/route.ts` (already listed), `src/app/[locale]/(admin)/allocation/runs/[id]/export/route.ts`

**First, create the walk-in-specific helper** (the fix for the 3-call-site conflict found during spec review — see spec layers 6/7):

- [ ] Create `src/lib/walk-in/server-helpers.ts`:

```typescript
// src/lib/walk-in/server-helpers.ts
//
// Split out of requireAdmissionStaffCaller (src/lib/admission/server-helpers.ts)
// during the 2026-10-25 staff-narrowing work. requireAdmissionStaffCaller
// had 3 call sites with conflicting in/out-of-scope status: the real
// admission-REVIEW workflow (participants/accounts/actions.ts, now
// out of scope for staff) vs. the walk-in admission RPC call and its
// health probe (admit-walk-in/route.ts, admission-staff-health/route.ts
// -- the actual implementation of the ONE scanning capability this
// redesign keeps). Patching the shared helper to reject staff would have
// silently broken walk-in admission. This helper is identical in body to
// requireAdmissionStaffCaller as it existed before that patch -- still
// admits staff -- and is now the sole gate for the 2 walk-in routes.
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { UpstreamUnavailableError, isTransportShapedError } from '@/lib/supabase/upstream-error';
import type { Database } from '@/types/database';
import type { SupabaseClient } from '@supabase/supabase-js';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

export async function requireWalkInStaffCaller(): Promise<{ userId: string; session: SupabaseClient<Database>; service: ServiceClient }> {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError && isAuthRetryableFetchError(userError)) {
    throw new UpstreamUnavailableError('auth.getUser() failed transiently');
  }
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error && isTransportShapedError(error)) {
    throw new UpstreamUnavailableError('profiles lookup failed transiently');
  }
  if (!profile) throw new Error('Profile not found');
  // Deliberately still admits `staff` -- this is the kept walk-in
  // capability. Do not add the `&& profile.role !== 'staff'` narrowing
  // here; that goes on requireAdmissionStaffCaller only (Step 4.6).
  if (!isStaffRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, session: supabase, service };
}
```

- [ ] Update `src/app/api/admit-walk-in/route.ts` line 32: change `import { requireAdmissionStaffCaller } from '@/lib/admission/server-helpers';` to `import { requireWalkInStaffCaller } from '@/lib/walk-in/server-helpers';`, and line 62: `caller = await requireAdmissionStaffCaller();` to `caller = await requireWalkInStaffCaller();`.
- [ ] Update `src/app/api/admission-staff-health/route.ts` line 21 and 27 the same way.
- [ ] Add a 403 guard to `src/app/api/admin/reports/participants-csv/route.ts`. Read the file first to find its current auth-check pattern (it does not use one of the `require*Caller` helpers per the spec's enumeration — confirm its actual pattern by reading it), then add a `staff`-rejecting check consistent with whatever pattern it already uses, returning HTTP 403.
- [ ] Add the same kind of 403 guard to `src/app/[locale]/(admin)/allocation/runs/[id]/export/route.ts` — read it first to find its current auth pattern, then add the `staff`-rejecting check.
- [ ] Manually test: as the `staff` test account, call `/api/admit-walk-in` and `/api/admission-staff-health` via the real walk-in UI, confirm both still work. Try the CSV export and allocation export routes directly (e.g. via browser URL or curl with the staff session cookie), confirm 403.
- [ ] Commit:

```bash
git add src/lib/walk-in/server-helpers.ts src/app/api/admit-walk-in/route.ts src/app/api/admission-staff-health/route.ts src/app/api/admin/reports/participants-csv/route.ts "src/app/[locale]/(admin)/allocation/runs/[id]/export/route.ts"
git commit -m "feat: split requireWalkInStaffCaller; add staff 403s to out-of-scope API routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 4.6: Server Action helper patches

**Files:** modify the 8 real helper files + 2 local `requireStaffCaller` copies

The 7 real shared helpers each get the exact same one-line change, at the exact location already confirmed by direct read:

- [ ] `src/lib/admission/server-helpers.ts` line 60: change `if (!isStaffRole(profile.role)) {` to `if (!isStaffRole(profile.role) || profile.role === 'staff') {`
- [ ] `src/lib/agenda/server-helpers.ts` line 42: same change.
- [ ] `src/lib/import/server-helpers.ts` line 36: same change.
- [ ] `src/lib/participant-care/server-helpers.ts` line 35: same change.
- [ ] `src/lib/participants-communications/server-helpers.ts` line 29: same change.
- [ ] `src/lib/travel-ops/server-helpers.ts` line 37: same change.
- [ ] `src/lib/funding/server-helpers.ts`: this one is different — it delegates to `isFundingTypeStaffRole`/`canReadAttendanceConfirmation` (thin wrappers in `src/lib/validation/funding-type.ts`), not `isStaffRole` directly. Patch the wrappers themselves (lines 22-24 and 26-28 of `funding-type.ts`):

```typescript
// src/lib/validation/funding-type.ts
export function isFundingTypeStaffRole(role: string | null | undefined): boolean {
  return isStaffRole(role) && role !== 'staff';
}

export function canReadAttendanceConfirmation(role: string | null | undefined): boolean {
  return isStaffRole(role) && role !== 'staff';
}
```

- [ ] **Leave `requireProgramAttendanceStaffCaller` (`src/lib/program-attendance/server-helpers.ts`) completely unpatched** — it must keep admitting `staff` (it backs the kept `/attendance/admissions` console).
- [ ] **Leave `requireScannerDeviceCaller` (`src/lib/scanner-device/server-helpers.ts`) completely untouched** — different role, out of scope.
- [ ] **Leave the new `requireWalkInStaffCaller` (Step 4.5) completely unpatched** — must keep admitting `staff`.
- [ ] Patch both local `requireStaffCaller` copies individually (not a shared function — confirmed by direct read):
  - `src/app/[locale]/(admin)/applications/[id]/actions.ts` line 33: `if (!isStaffRole(profile.role)) {` → `if (!isStaffRole(profile.role) || profile.role === 'staff') {`
  - `src/app/[locale]/(admin)/announcements/actions.ts` line 46: same change.
- [ ] **Final completeness check, as the spec requires**: run `grep -rln "function requireStaffCaller" src/` and confirm exactly these 2 files match (no third copy was added since spec-writing time). Also run `grep -rln "require.*Caller" src/lib --include="*.ts"` and confirm no new helper exists beyond the 9 now accounted for (8 original + the new `requireWalkInStaffCaller`).
- [ ] Manually test: as the `staff` test account, attempt (via direct Server Action invocation isn't possible outside the UI, so use the real admin UI) to update an application's status at `/applications/[id]` (if that UI is still reachable — it may 404/redirect before even reaching the action, in which case this confirms the layering is working; if somehow still reachable, confirm the action itself now throws "Not authorized"). Confirm `/attendance/admissions`'s actions (admit override, correct attendance) still work for `staff`.
- [ ] Commit:

```bash
git add src/lib/admission/server-helpers.ts src/lib/agenda/server-helpers.ts src/lib/import/server-helpers.ts src/lib/participant-care/server-helpers.ts src/lib/participants-communications/server-helpers.ts src/lib/travel-ops/server-helpers.ts src/lib/validation/funding-type.ts "src/app/[locale]/(admin)/applications/[id]/actions.ts" "src/app/[locale]/(admin)/announcements/actions.ts"
git commit -m "fix: reject staff role in all out-of-scope Server Action helpers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 4.7: RLS migration

**Files:** Create `supabase/migrations/20261025000400_add_is_super_admin_helper.sql`, `supabase/migrations/20261025000500_narrow_staff_rls_to_super_admin.sql`

- [ ] **Before writing the migration, get the real, complete policy list from the LIVE linked project** (not from memory or a source grep alone — the spec explicitly requires this). Verify the linked project first (`supabase projects list` → `vfwcbkjvinbtcntwjrzq`), then run (via a Node script with the service-role key, or ask the user to run in the Supabase Dashboard SQL Editor):

```sql
select schemaname, tablename, policyname, qual, with_check
from pg_policies
where qual ilike '%is_staff%' or with_check ilike '%is_staff%';
```

Also check for non-table objects the spec flags as easy to miss: `ops_dashboard_snapshot()`'s function body, and the `ops_dashboard_broadcast_select` policy on `realtime.messages` — these won't necessarily show up in a `pg_policies` filter on `tablename` alone if `realtime.messages` is schema-qualified differently; confirm the query above actually includes `realtime.messages`, and separately check the function body of `ops_dashboard_snapshot()` via `select prosrc from pg_proc where proname = 'ops_dashboard_snapshot'`.

- [ ] Write the new helper migration:

```sql
-- supabase/migrations/20261025000400_add_is_super_admin_helper.sql
--
-- is_staff() means "staff OR super_admin" and stays that way (several
-- policies depend on that meaning and must keep working for staff --
-- attendance_records, scan_attempts, scanner_assignments, admit_walk_in,
-- and the /attendance/admissions RPCs). Everything ELSE currently on
-- is_staff() needs to become super_admin-only once staff is narrowed --
-- this new helper is what those policies switch to.
create function is_super_admin() returns boolean as $$
  select current_user_role() = 'super_admin';
$$ language sql stable security definer set search_path = public;
```

- [ ] Write the narrowing migration — **the exact policy list below must be replaced with the real list from the `pg_policies` query above before this migration is finalized; do not trust this plan's list as exhaustive, it is illustrative of the shape only**:

```sql
-- supabase/migrations/20261025000500_narrow_staff_rls_to_super_admin.sql
--
-- Staff role narrowing (docs/superpowers/specs/2026-10-25-profile-
-- accommodation-staff-narrowing-design.md Item 6, layer 8). Converts
-- every is_staff()-gated policy EXCEPT the attendance-domain surface
-- (attendance_records, scan_attempts, scanner_assignments, admit_walk_in,
-- and the /attendance/admissions RPCs -- all of which must keep working
-- for staff) from is_staff() to is_super_admin().
--
-- !! This migration's policy list was generated from a live
-- `select * from pg_policies where qual ilike '%is_staff%' or
-- with_check ilike '%is_staff%'` query against the real linked project
-- at implementation time -- NOT reconstructed from memory or a source
-- grep alone. Fill in the real drop/create pairs here, one per policy
-- found, following this shape:

-- Example shape (repeat for every real policy found, excluding the kept
-- attendance-domain ones):
-- drop policy if exists <policy_name> on <table>;
-- create policy <policy_name> on <table>
--   for <operation>
--   using (is_super_admin())
--   with check (is_super_admin());

-- Also handle the 2 non-table objects review found are easy to miss:
-- drop policy if exists ops_dashboard_broadcast_select on realtime.messages;
-- create policy ops_dashboard_broadcast_select on realtime.messages
--   for select using (is_super_admin());

create or replace function ops_dashboard_snapshot()
returns ... -- same signature as today, read the real current definition
            -- via `select prosrc from pg_proc where proname =
            -- 'ops_dashboard_snapshot'` before rewriting it -- replace
            -- is_staff() with is_super_admin() in its body only, leave
            -- everything else unchanged.
as $$
  ...
$$;
```

- [ ] Before finalizing, re-trace the 6 `/attendance/admissions` Server Actions' actual RPC/table calls (per the spec's explicit instruction — this wasn't done during spec research): read `performAdmitOverride`, `performCorrectAttendance`, `performTransferAttendance`, `searchApplicationsForAdmission`, `fetchAttendanceStateForApplication`, `fetchAttendanceAuditLog` in `src/app/[locale]/(admin)/attendance/admissions/actions.ts`, list every table/RPC each one touches, and confirm every one of those is either already excluded from this narrowing migration or explicitly kept on `is_staff()`.
- [ ] Apply both migrations via `supabase db query --linked --file <path>`, in order.
- [ ] Commit:

```bash
git add supabase/migrations/20261025000400_add_is_super_admin_helper.sql
git commit -m "feat: add is_super_admin() helper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git add supabase/migrations/20261025000500_narrow_staff_rls_to_super_admin.sql
git commit -m "fix: narrow staff RLS access to attendance domain only

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 4.8: Avatar bucket's `super_admin` read-all policy

Now that `is_super_admin()` exists (Step 4.7), finish the avatar bucket from Step 1.2.

- [ ] Write the migration:

```sql
-- supabase/migrations/20261025000600_avatars_super_admin_read_all.sql
create policy "avatars_select_super_admin"
  on storage.objects for select
  using (
    bucket_id = 'avatars'
    and is_super_admin()
  );
```

- [ ] Apply via `supabase db query --linked --file <path>`.
- [ ] Commit:

```bash
git add supabase/migrations/20261025000600_avatars_super_admin_read_all.sql
git commit -m "feat: grant super_admin read-all access to avatars bucket

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 4.9: Fix the known-certain failing live test assertions

**Files:** `tests/auth/staff-roles-live.test.ts`

- [ ] Re-run `grep -rl "'staff'" tests --include="*.ts"` to get the current, real file list (don't trust the spec's ~18 as exact — re-enumerate, per the spec's own instruction).
- [ ] Fix the known-certain assertions in `tests/auth/staff-roles-live.test.ts` lines 188-207 (the two "a staff-scoped client CAN read application_travel_info/application_health_info" tests) — these must now assert the OPPOSITE: a staff-scoped client is REJECTED by RLS. Update:

```typescript
// Replace lines 188-197:
it('a staff-scoped client CANNOT read application_travel_info via RLS (narrowed 2026-10-25)', async () => {
  const anonClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { error: signInErr } = await anonClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-staff@test.local', password: 'password123' });
  expect(signInErr).toBeNull();

  const { data, error } = await anonClient.from('application_travel_info').select('*').eq('application_id', sensitiveApplicationId);
  expect(error || (data ?? []).length === 0).toBeTruthy();
  await anonClient.auth.signOut();
});

// Replace lines 199-207 the same way for application_health_info.
```

Update the enclosing `describe` block's title (line 144) since it currently claims staff CAN read this data, which is now false: change `'sensitive travel and health data: a staff account can read it (consolidated tradeoff); a participant still cannot'` to `'sensitive travel and health data: neither staff nor participant can read it (narrowed 2026-10-25); only super_admin can'`. Add a new test asserting a `super_admin`-scoped client CAN still read both tables (since `super_admin`'s access is explicitly unaffected).

- [ ] Fix the helper-existence check at lines 135-141 (`typeof requireAdmissionStaffCaller`) — this is still a valid function reference, no change needed there, but add `requireWalkInStaffCaller` to the import list and this assertion block, since it's a new helper from this same change.
- [ ] Walk through every other file from the re-enumerated grep list (expect ~18, confirm the real count) — for each, read it and check whether it asserts old broad-staff-access behavior that the narrowing invalidates. Fix each one found. This step's exact file list can't be fully predicted in advance; budget real time for it rather than treating it as a formality.
- [ ] Run the full affected test suite, confirm green: `npx vitest run tests/auth/staff-roles-live.test.ts`
- [ ] Commit:

```bash
git add tests/auth/staff-roles-live.test.ts
git commit -m "fix: update staff-roles-live tests for narrowed staff RLS access

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

#### Step 4.10: New live test proving the narrowed boundary end-to-end

**Files:** Create `tests/auth/staff-narrow-access-live.test.ts`

- [ ] Write this test against the real linked project (follow `staff-roles-live.test.ts`'s established fixture-creation/teardown pattern — disposable `@test.local` accounts, `afterAll` cleanup, never the real staff test account):

```typescript
// tests/auth/staff-narrow-access-live.test.ts
//
// Proves the 2026-10-25 staff narrowing end-to-end, at the RLS level
// (not just app-level) -- a real staff-role fixture account is
// independently confirmed REJECTED on every now-out-of-scope
// table/RPC, and still ALLOWED on the kept attendance surface.
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const createdAuthUserIds: string[] = [];
afterAll(async () => {
  for (const id of createdAuthUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, 60000);

describe('narrowed staff role: RLS-level proof', () => {
  const EMAIL = 'staff-narrow-access-live-fixture@test.local';
  let staffId: string;

  it('setup: create a staff fixture', async () => {
    const { data, error } = await admin.auth.admin.createUser({ email: EMAIL, password: 'password123', email_confirm: true });
    if (error || !data.user) throw new Error(`Failed: ${error?.message}`);
    staffId = data.user.id;
    createdAuthUserIds.push(staffId);
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffId);
  });

  it('staff CAN read scan_attempts (kept)', async () => {
    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: EMAIL, password: 'password123' });
    const { error } = await client.from('scan_attempts').select('*').limit(1);
    expect(error).toBeNull();
    await client.auth.signOut();
  });

  it('staff CANNOT read applications (removed)', async () => {
    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: EMAIL, password: 'password123' });
    const { data, error } = await client.from('applications').select('*').limit(1);
    expect(error || (data ?? []).length === 0).toBeTruthy();
    await client.auth.signOut();
  });

  it('staff CANNOT call ops_dashboard_snapshot (removed)', async () => {
    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: EMAIL, password: 'password123' });
    const { error } = await client.rpc('ops_dashboard_snapshot');
    expect(error).toBeTruthy();
    await client.auth.signOut();
  });
});
```

(Add more removed-surface assertions — `application_travel_info`, `sessions`, etc. — following the same pattern; the 3 above cover the three distinct enforcement shapes: a table `is_staff()` → `is_super_admin()` policy, a different table, and an RPC.)

- [ ] Run it against the live project, confirm all pass.
- [ ] Commit:

```bash
git add tests/auth/staff-narrow-access-live.test.ts
git commit -m "test: add live RLS-level proof of narrowed staff access

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Final verification against the original 7-part request

No new code — this task is pure verification + the final summary commit.

- [ ] Run the full build: `npm run build`. Fix any TypeScript/lint errors surfaced.
- [ ] Run lint: `npm run lint`.
- [ ] Run the full test suite: `npx vitest run`. Confirm no unexpected regressions outside the files this plan intentionally touched.
- [ ] Manual browser pass, signed in as each of the 4 real test accounts (`albaraak2002@gmail.com` participant, `albaraa.coy21@gmail.com` super_admin, `albaraaalbadwi@gmail.com` staff, `albaraa.scale.om@gmail.com` scanner_device):
  - [ ] Participant: My Profile shows the 4 new identity fields; save is blocked with any required field empty; avatar upload + save succeeds; re-saving without a new photo (once one is on file) succeeds. Accommodation: hotel name/location note required, room number optional, save behaves correctly for both.
  - [ ] Participant: `/local-info` — confirm Safety & Health section is gone, Safeguarding Contact phone renders as a tappable `tel:` link, both new Key Contacts emails render as tappable `mailto:` links.
  - [ ] Staff: signs in, lands on `/attendance/walk-in` (not `/dashboard`). Sidebar shows only Attendance group with Walk-In and Admissions (no Scanners/Demand/Ops Dashboard, no other groups at all). Direct URL navigation to `/dashboard`, `/applications`, `/participants/accounts`, `/agenda/sessions`, `/reports` all redirect to `/attendance/walk-in`. Walk-in admission flow itself (scan/search + admit) still works end-to-end. `/attendance/admissions` still works end-to-end (search, admit override, correct attendance).
  - [ ] Super_admin: everything unchanged — full dashboard, full sidebar, every page still reachable, still lands on `/dashboard` after login.
  - [ ] Scanner_device: unchanged — still lands on `/scanner`, nothing about this role was touched.
- [ ] Confirm zero remaining occurrences of the literal old placeholder text: `grep -r "TBC by Organising Team" .` and `grep -r "Safety & Health"` across the codebase/docs (should only find this plan/spec's own historical references, not live UI copy).
- [ ] Update `docs/pre-launch-checklist.md` with a summary entry for this entire change (profile fields, accommodation validation, local info cleanup, staff narrowing), per this project's standing documentation discipline.
- [ ] Final commit:

```bash
git add docs/pre-launch-checklist.md
git commit -m "docs: log profile/accommodation/local-info/staff-narrowing changes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] Report back to the user with a summary of everything changed, and use the `finishing-a-development-branch` skill to decide how to merge this branch.
