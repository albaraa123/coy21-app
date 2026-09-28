# RCOY MENA 2026 — Phase 1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Next.js + Supabase project scaffold, the five-role auth/profiles model with RLS, and the bilingual public registration flow (form → submit → confirmation email → status dashboard) described in `docs/superpowers/specs/2026-07-21-foundation-design.md`.

**Architecture:** Next.js 14 App Router with `app/[locale]/...` routing (ar/en via next-intl), Supabase for Postgres/Auth/RLS accessed through `@supabase/ssr`, a Zod-validated two-step registration form using react-hook-form, and a single Next.js server action performing the atomic draft→submitted transition (sequence-based application number, status history insert, Resend email, email_log insert).

**Tech Stack:** Next.js 14+, TypeScript, Tailwind CSS, next-intl, Supabase (CLI local dev via Docker), @supabase/ssr, @supabase/supabase-js, react-hook-form, zod, Resend, Vitest for unit tests.

---

## File Structure

```
RCOY MENA/
├── docs/superpowers/{specs,plans}/          (existing)
├── supabase/
│   ├── config.toml                          (from `supabase init`)
│   └── migrations/
│       ├── 0001_roles_and_profiles.sql
│       ├── 0002_applications.sql
│       ├── 0003_application_status_history_and_email_log.sql
│       └── 0004_rls_policies.sql
├── src/
│   ├── i18n/
│   │   ├── request.ts                       (next-intl config)
│   │   └── routing.ts                       (locale list, default locale)
│   ├── messages/
│   │   ├── ar.json
│   │   └── en.json
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts                    (browser client)
│   │   │   ├── server.ts                    (server component/action client)
│   │   │   └── middleware.ts                (session refresh helper)
│   │   ├── validation/
│   │   │   └── registration.ts              (Zod schemas for form steps)
│   │   └── email/
│   │       └── resend.ts                    (Resend client + send helper)
│   ├── types/
│   │   └── database.ts                      (generated Supabase types)
│   ├── proxy.ts                              (next-intl routing; Next.js 16 renamed middleware.ts to proxy.ts)
│   └── app/
│       └── [locale]/
│           ├── layout.tsx
│           ├── page.tsx                     (landing/redirect)
│           ├── (auth)/
│           │   ├── sign-up/page.tsx
│           │   └── log-in/page.tsx
│           └── (participant)/
│               ├── register/
│               │   ├── page.tsx             (server component, loads/creates draft)
│               │   └── registration-form.tsx (client component, 2-step form)
│               ├── my-application/page.tsx  (status dashboard)
│               └── actions.ts               (submitApplication server action)
├── tests/
│   ├── validation/registration.test.ts
│   └── rls/applications.test.ts
├── .env.local.example
├── package.json
├── tsconfig.json
├── next.config.ts
└── tailwind.config.ts
```

**Responsibility notes:**
- `src/lib/supabase/*` isolates all Supabase client construction — nothing else touches `createClient` directly.
- `src/lib/validation/registration.ts` is the single source of truth for form-field requiredness, shared by the client form and (indirectly, via reuse) the server action's own validation before insert.
- `(participant)/register/actions.ts` contains only `submitApplication` — the one place the draft→submitted transaction happens, using the service-role client.
- Migrations are split by concern (roles/profiles, applications, history/log, RLS) so each is independently reviewable and matches the spec's schema sections.

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `.gitignore`, `.env.local.example`
- Create: `src/app/layout.tsx` (root), `src/app/[locale]/layout.tsx`, `src/app/[locale]/page.tsx`

- [ ] **Step 1: Scaffold Next.js app**

Run:
```bash
npx create-next-app@latest . --typescript --tailwind --app --no-src-dir=false --import-alias "@/*" --eslint
```
When prompted, accept defaults. This creates `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, base `src/app/`.

- [ ] **Step 2: Install remaining dependencies**

Run:
```bash
npm install @supabase/ssr @supabase/supabase-js next-intl react-hook-form zod @hookform/resolvers resend
npm install -D vitest @vitejs/plugin-react supabase
```

- [ ] **Step 3: Add `.env.local.example`**

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
RESEND_API_KEY=
```

- [ ] **Step 4: Verify dev server boots**

Run: `npm run dev` then check `http://localhost:3000` responds (Ctrl+C after confirming, or check via `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000` in a second terminal).
Expected: HTTP 200.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json next.config.ts tailwind.config.ts postcss.config.js .gitignore .env.local.example src/
git commit -m "chore: scaffold Next.js app with core dependencies"
```

---

## Task 2: Supabase Local Project Init

**Files:**
- Create: `supabase/config.toml` (generated)

- [ ] **Step 1: Init Supabase**

Run: `npx supabase init`
Expected: creates `supabase/` directory with `config.toml` and empty `migrations/`.

- [ ] **Step 2: Start local Supabase (requires Docker running)**

Run: `npx supabase start`
Expected: prints local API URL, anon key, service_role key. Copy these into a local `.env.local` (not committed).

- [ ] **Step 3: Commit config**

```bash
git add supabase/config.toml supabase/.gitignore
git commit -m "chore: init local Supabase project"
```

---

## Task 3: Migration — Roles and Profiles

**Files:**
- Create: `supabase/migrations/0001_roles_and_profiles.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0001_roles_and_profiles.sql
create type user_role as enum (
  'participant',
  'super_admin',
  'registration_admission_manager',
  'agenda_allocation_manager',
  'communications_attendance_manager'
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'participant',
  full_name text not null,
  email text not null,
  created_at timestamptz not null default now()
);

create function handle_new_user() returns trigger as $$
begin
  insert into profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
```

- [ ] **Step 2: Apply migration locally**

Run: `npx supabase db reset`
Expected: output shows migration `0001_roles_and_profiles.sql` applied with no errors.

- [ ] **Step 3: Verify trigger actually inserts a profile row (not just that it exists)**

Create a throwaway auth user via the service-role client and confirm a matching `profiles` row appears — this is the behavior that matters, not just the trigger's presence. The auth admin API isn't reachable from raw SQL, so verify via a one-off Node script:

```bash
node -e "
const { createClient } = require('@supabase/supabase-js');
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const { data, error } = await c.auth.admin.createUser({ email: 'trigger-check@test.local', password: 'password123', email_confirm: true, user_metadata: { full_name: 'Trigger Check' } });
  if (error) throw error;
  const { data: profile } = await c.from('profiles').select('*').eq('id', data.user.id).single();
  console.log('profile row:', profile);
  await c.auth.admin.deleteUser(data.user.id);
})();
"
```
Expected: prints a `profiles` row with `role: 'participant'`, `full_name: 'Trigger Check'`, matching `email`. This closes the gap identified in review — checking only that the trigger *exists* (a prior draft of this step) doesn't prove it fires correctly, and a broken trigger here would otherwise go undetected until Task 10.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_roles_and_profiles.sql
git commit -m "feat(db): add user_role enum, profiles table, signup trigger"
```

---

## Task 4: Migration — Applications Table

**Files:**
- Create: `supabase/migrations/0002_applications.sql`

- [ ] **Step 1: Write the migration**

The spec references Supabase's `moddatetime` extension for auto-updating `updated_at` without naming a schema. This migration installs it into the `extensions` schema (Supabase's convention for local/CLI projects) and calls it as `extensions.moddatetime` — an intentional refinement of the spec, not a deviation from it.

```sql
-- 0002_applications.sql
create type application_status as enum (
  'draft',
  'submitted',
  'under_review',
  'accepted',
  'waitlisted',
  'rejected',
  'withdrawn'
);

create sequence application_number_seq start 1;

create extension if not exists moddatetime schema extensions;

create table applications (
  id uuid primary key default gen_random_uuid(),
  applicant_id uuid not null references profiles(id) on delete cascade,
  application_number text unique,
  status application_status not null default 'draft',

  phone text,
  country text,
  nationality text,
  birth_date date,
  age_group text,
  city text,
  organization text,
  field_of_work text,
  preferred_language text,

  interests text[],
  climate_experience text,
  experience_level text,
  past_initiatives text,
  participation_goals text,
  topics_to_learn text,
  content_type_pref text,
  track_interests text[],
  priority_sessions text,
  special_needs text,

  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index applications_one_per_applicant on applications (applicant_id);

create trigger applications_set_updated_at
  before update on applications
  for each row execute function extensions.moddatetime('updated_at');
```

- [ ] **Step 2: Apply migration locally**

Run: `npx supabase db reset`
Expected: `0001` and `0002` both apply cleanly.

- [ ] **Step 3: Verify unique index and sequence**

Run via Studio SQL editor or `supabase db execute`:
```sql
select indexname from pg_indexes where tablename = 'applications';
select last_value from application_number_seq;
```
Expected: `applications_one_per_applicant` present; sequence exists with `last_value = 1`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0002_applications.sql
git commit -m "feat(db): add applications table, one-per-applicant constraint, updated_at trigger"
```

---

## Task 5: Migration — Status History and Email Log

**Files:**
- Create: `supabase/migrations/0003_application_status_history_and_email_log.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0003_application_status_history_and_email_log.sql
create table application_status_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  old_status application_status,
  new_status application_status not null,
  changed_by uuid references profiles(id),
  note text,
  created_at timestamptz not null default now()
);

create table email_log (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  template text not null,
  status text not null,
  sent_at timestamptz not null default now()
);
```

- [ ] **Step 2: Apply and verify**

Run: `npx supabase db reset`
Expected: all three migrations apply; `\d application_status_history` and `\d email_log` (via Studio or `supabase db execute`) show the expected columns.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0003_application_status_history_and_email_log.sql
git commit -m "feat(db): add application_status_history and email_log tables"
```

---

## Task 6: Migration — RLS Policies

**Files:**
- Create: `supabase/migrations/0004_rls_policies.sql`

- [ ] **Step 1: Write the migration**

Role-check subqueries that query `profiles` from within a policy defined *on* `profiles` are a known Postgres/Supabase RLS recursion hazard. Instead, use a `security definer` helper function — it runs with the privileges of its owner (bypassing RLS internally), so it can safely read `profiles.role` without re-triggering policy evaluation on itself.

```sql
-- 0004_rls_policies.sql

-- security definer helper: reads the caller's role without re-entering RLS on profiles
create function current_user_role() returns user_role as $$
  select role from profiles where id = auth.uid();
$$ language sql stable security definer set search_path = public;

alter table profiles enable row level security;
alter table applications enable row level security;
alter table application_status_history enable row level security;
alter table email_log enable row level security;

-- profiles: read/update own row; super_admin reads/updates all; no client insert (trigger-only)
create policy profiles_select_own on profiles
  for select using (id = auth.uid());

create policy profiles_select_super_admin on profiles
  for select using (current_user_role() = 'super_admin');

create policy profiles_update_own on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy profiles_update_super_admin on profiles
  for update using (current_user_role() = 'super_admin');

-- applications: applicant can select/delete own row anytime; insert own draft; update own draft only
create policy applications_select_own on applications
  for select using (applicant_id = auth.uid());

create policy applications_select_staff on applications
  for select using (current_user_role() in ('registration_admission_manager', 'super_admin'));

create policy applications_insert_own_draft on applications
  for insert with check (applicant_id = auth.uid() and status = 'draft');

create policy applications_update_own_draft on applications
  for update
  using (applicant_id = auth.uid() and status = 'draft')
  with check (applicant_id = auth.uid() and status = 'draft');

create policy applications_delete_own_draft on applications
  for delete using (applicant_id = auth.uid() and status = 'draft');

-- application_status_history / email_log: no client insert policies at all (default-deny);
-- only the service role (which bypasses RLS) writes these. Select is staff-only.
create policy application_status_history_select_staff on application_status_history
  for select using (current_user_role() in ('registration_admission_manager', 'super_admin'));

create policy email_log_select_staff on email_log
  for select using (current_user_role() in ('registration_admission_manager', 'super_admin'));
```

- [ ] **Step 2: Apply migration**

Run: `npx supabase db reset`
Expected: all four migrations apply with no errors.

Migrations applying without error only confirms the SQL is syntactically valid, not that the policies grant/deny access correctly — that verification (including that `super_admin`/`registration_admission_manager` can read across applicants, and other roles cannot) requires authenticated test sessions and is done in Task 7's automated test suite immediately following this task, rather than manually here.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0004_rls_policies.sql
git commit -m "feat(db): enable RLS and add policies for profiles/applications/history/email_log"
```

---

## Task 7: RLS Verification Tests

**Files:**
- Create: `tests/rls/applications.test.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1: Add vitest config**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing RLS test**

This test uses two Supabase clients against the local instance: one authenticated as applicant A, one as applicant B, to prove row isolation. Requires local Supabase running (`npx supabase start`) and two seeded test users (created via `supabase.auth.admin.createUser` in a `beforeAll` using the service-role client).

```typescript
// tests/rls/applications.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(URL, SERVICE_KEY);

let userAId: string;
let userBId: string;
let clientA: ReturnType<typeof createClient>;
let clientB: ReturnType<typeof createClient>;

let userCId: string; // registration_admission_manager
let userDId: string; // agenda_allocation_manager (should have NO applications access)
let clientC: ReturnType<typeof createClient>;
let clientD: ReturnType<typeof createClient>;

beforeAll(async () => {
  const { data: userA } = await admin.auth.admin.createUser({
    email: 'applicant-a@test.local',
    password: 'password123',
    email_confirm: true,
  });
  const { data: userB } = await admin.auth.admin.createUser({
    email: 'applicant-b@test.local',
    password: 'password123',
    email_confirm: true,
  });
  const { data: userC } = await admin.auth.admin.createUser({
    email: 'admissions-manager@test.local',
    password: 'password123',
    email_confirm: true,
  });
  const { data: userD } = await admin.auth.admin.createUser({
    email: 'agenda-manager@test.local',
    password: 'password123',
    email_confirm: true,
  });
  userAId = userA.user!.id;
  userBId = userB.user!.id;
  userCId = userC.user!.id;
  userDId = userD.user!.id;

  // Promote C and D to their staff roles (their profiles rows already exist via the signup trigger)
  await admin.from('profiles').update({ role: 'registration_admission_manager' }).eq('id', userCId);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', userDId);

  clientA = createClient(URL, ANON_KEY);
  await clientA.auth.signInWithPassword({ email: 'applicant-a@test.local', password: 'password123' });

  clientB = createClient(URL, ANON_KEY);
  await clientB.auth.signInWithPassword({ email: 'applicant-b@test.local', password: 'password123' });

  clientC = createClient(URL, ANON_KEY);
  await clientC.auth.signInWithPassword({ email: 'admissions-manager@test.local', password: 'password123' });

  clientD = createClient(URL, ANON_KEY);
  await clientD.auth.signInWithPassword({ email: 'agenda-manager@test.local', password: 'password123' });
});

afterAll(async () => {
  await admin.auth.admin.deleteUser(userAId);
  await admin.auth.admin.deleteUser(userBId);
  await admin.auth.admin.deleteUser(userCId);
  await admin.auth.admin.deleteUser(userDId);
});

describe('applications RLS', () => {
  it('applicant can insert their own draft application', async () => {
    const { error } = await clientA
      .from('applications')
      .insert({ applicant_id: userAId, status: 'draft' });
    expect(error).toBeNull();
  });

  it('applicant cannot read another applicant\'s application', async () => {
    const { data } = await clientB.from('applications').select('*').eq('applicant_id', userAId);
    expect(data).toEqual([]);
  });

  it('applicant cannot set status directly via client update', async () => {
    const { error } = await clientA
      .from('applications')
      .update({ status: 'accepted' })
      .eq('applicant_id', userAId);
    // RLS WITH CHECK rejects the row -> zero rows affected, Supabase returns no error
    // but the row must remain unchanged; verify via a fresh select.
    const { data } = await clientA.from('applications').select('status').eq('applicant_id', userAId).single();
    expect(data?.status).toBe('draft');
  });

  it('applicant cannot insert a second application', async () => {
    const { error } = await clientA
      .from('applications')
      .insert({ applicant_id: userAId, status: 'draft' });
    expect(error).not.toBeNull();
  });

  it('registration_admission_manager can read all applications, including other applicants\'', async () => {
    const { data, error } = await clientC.from('applications').select('*').eq('applicant_id', userAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('agenda_allocation_manager cannot read any applications (not an authorized staff role in Phase 1)', async () => {
    const { data } = await clientD.from('applications').select('*').eq('applicant_id', userAId);
    expect(data).toEqual([]);
  });

  it('registration_admission_manager can read application_status_history', async () => {
    const { error } = await clientC.from('application_status_history').select('*');
    expect(error).toBeNull();
  });

  it('agenda_allocation_manager cannot read application_status_history', async () => {
    const { data } = await clientD.from('application_status_history').select('*');
    expect(data).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify current behavior**

Run: `npx supabase start && npm run test -- tests/rls/applications.test.ts`
Expected: PASS, 8 tests — this covers the spec's explicit RLS testing requirement ("participant cannot read others' applications; managers can read all; no other role can access `applications`") in addition to the WITH CHECK status-lock and one-per-applicant constraint. This test targets the schema/RLS built in Tasks 3-6, which already exist — this step confirms the migrations actually enforce what the spec claims, closing the loop on Task 6, including the `current_user_role()` helper added to fix the RLS recursion risk.

- [ ] **Step 4: Commit**

```bash
git add tests/rls/applications.test.ts vitest.config.ts package.json
git commit -m "test: verify applications RLS policies against local Supabase"
```

---

## Task 8: i18n Setup (next-intl)

**Files:**
- Create: `src/i18n/routing.ts`, `src/i18n/request.ts`, `src/messages/ar.json`, `src/messages/en.json`, `src/middleware.ts`
- Modify: `next.config.ts`

- [ ] **Step 1: Define routing config and locale-aware navigation helpers**

`defineRouting` + `createNavigation` gives locale-prefixed `redirect`/`useRouter`/`Link` so every later task can navigate with a plain path like `/log-in` and get `/ar/log-in` or `/en/log-in` automatically — avoiding relative paths like `redirect('../log-in')`, which are not guaranteed to resolve consistently between server actions, server components, and client-side `router.push`.

```typescript
// src/i18n/routing.ts
import { defineRouting } from 'next-intl/routing';
import { createNavigation } from 'next-intl/navigation';

export const routing = defineRouting({
  locales: ['ar', 'en'],
  defaultLocale: 'ar',
});

export const { Link, redirect, usePathname, useRouter } = createNavigation(routing);
```

The `redirect`/`useRouter` exported here automatically read the active locale from the Next.js request context (server components) or the current URL (client components) and prefix paths accordingly — call sites pass a locale-less path (`/log-in`) and get `/ar/log-in` or `/en/log-in`. If the installed `next-intl` version's `redirect` signature requires an explicit `{ locale }` param (check the version pulled by Task 1's `npm install`), pass `locale` from the enclosing page's route params instead of hardcoding one.

- [ ] **Step 2: Define request config**

```typescript
// src/i18n/request.ts
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  if (!locale || !routing.locales.includes(locale as any)) {
    locale = routing.defaultLocale;
  }
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
```

- [ ] **Step 3: Seed minimal message files**

```json
// src/messages/en.json
{
  "landing": { "title": "RCOY MENA 2026" },
  "auth": { "signUp": "Sign Up", "logIn": "Log In" },
  "registration": { "step1": "Personal Information", "step2": "Conference Information", "submit": "Submit Application" },
  "status": {
    "draft": "Draft",
    "submitted": "Submitted",
    "under_review": "Under Review",
    "accepted": "Accepted",
    "waitlisted": "Waitlisted",
    "rejected": "Rejected",
    "withdrawn": "Withdrawn"
  }
}
```

```json
// src/messages/ar.json
{
  "landing": { "title": "RCOY MENA 2026" },
  "auth": { "signUp": "إنشاء حساب", "logIn": "تسجيل الدخول" },
  "registration": { "step1": "المعلومات الشخصية", "step2": "معلومات المؤتمر", "submit": "إرسال الطلب" },
  "status": {
    "draft": "مسودة",
    "submitted": "تم الإرسال",
    "under_review": "قيد المراجعة",
    "accepted": "مقبول",
    "waitlisted": "قائمة الانتظار",
    "rejected": "مرفوض",
    "withdrawn": "منسحب"
  }
}
```

- [ ] **Step 4: Wire middleware**

```typescript
// src/middleware.ts
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
```

- [ ] **Step 5: Update next.config.ts**

```typescript
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {};

export default withNextIntl(nextConfig);
```

- [ ] **Step 6: Move root page into `[locale]` and verify both locales render**

Move `src/app/page.tsx` content into `src/app/[locale]/page.tsx` using the `landing.title` message key. Delete the old root `page.tsx`/`layout.tsx` in favor of `src/app/[locale]/layout.tsx` (App Router requires the locale segment to own the layout when using next-intl's `NextIntlClientProvider`).

Run: `npm run dev`, then check both:
```bash
curl -s http://localhost:3000/ar | grep -o "RCOY MENA 2026"
curl -s http://localhost:3000/en | grep -o "RCOY MENA 2026"
```
Expected: both print `RCOY MENA 2026`.

- [ ] **Step 7: Commit**

```bash
git add src/i18n src/messages src/middleware.ts src/app next.config.ts
git commit -m "feat: add next-intl bilingual routing (ar/en)"
```

---

## Task 9: Supabase Client Helpers

> Note: The server client's `setAll` guards against the Server Component render context, but full session-refresh middleware (calling `supabase.auth.getUser()` on every request) is not part of this Phase 1 plan and is deferred to a later phase.

**Files:**
- Create: `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`

- [ ] **Step 1: Browser client**

```typescript
// src/lib/supabase/client.ts
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
```

- [ ] **Step 2: Server client (for server components and server actions, uses request cookies)**

```typescript
// src/lib/supabase/server.ts
import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );
}

export function createServiceRoleClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
```

- [ ] **Step 3: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: no type errors from these two files.

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase
git commit -m "feat: add Supabase browser/server/service-role client helpers"
```

---

## Task 10: Auth Pages (Sign Up / Log In)

> **Follow-up needed:** manual verification of Step 3 used `admin.createUser()` instead of the real `signUp()` form flow, after the actual `signUp()` call hit the hosted project's email rate limit. The code matches spec exactly, but the real client-initiated signup path (rate-limiting, email-confirmation dispatch) has not yet been verified end-to-end. Re-run Step 3 as originally written (submit the real `/ar/sign-up` form) once the rate-limit window has cleared, or against a local Supabase instance if Docker becomes available.

**Files:**
- Create: `src/app/[locale]/(auth)/sign-up/page.tsx`, `src/app/[locale]/(auth)/log-in/page.tsx`

- [ ] **Step 1: Sign-up page (client component, calls `supabase.auth.signUp`)**

```tsx
// src/app/[locale]/(auth)/sign-up/page.tsx
'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function SignUpPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    setMessage(error ? error.message : 'Check your email to confirm your account.');
  }

  return (
    <form onSubmit={handleSubmit}>
      <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full name" required />
      <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="Email" required />
      <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" required minLength={8} />
      <button type="submit">Sign Up</button>
      {message && <p>{message}</p>}
    </form>
  );
}
```

- [ ] **Step 2: Log-in page**

```tsx
// src/app/[locale]/(auth)/log-in/page.tsx
'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/client';

export default function LogInPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      return;
    }
    router.push('/my-application');
  }

  return (
    <form onSubmit={handleSubmit}>
      <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="Email" required />
      <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" required />
      <button type="submit">Log In</button>
      {error && <p>{error}</p>}
    </form>
  );
}
```

- [ ] **Step 3: Manual verification**

Run `npm run dev`, visit `http://localhost:3000/ar/sign-up`, create an account with a real-format email, confirm a `profiles` row was auto-created (check via Studio: `select * from profiles;`).
Expected: one row with `role = 'participant'`, matching `full_name`/`email`.

- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/(auth)"
git commit -m "feat: add sign-up and log-in pages"
```

---

## Task 11: Registration Form Validation Schema

**Files:**
- Create: `src/lib/validation/registration.ts`
- Test: `tests/validation/registration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/validation/registration.test.ts
import { describe, it, expect } from 'vitest';
import { personalInfoSchema, conferenceInfoSchema } from '@/lib/validation/registration';

describe('personalInfoSchema', () => {
  it('requires either birth_date or age_group', () => {
    const result = personalInfoSchema.safeParse({
      phone: '+1234567890',
      country: 'Jordan',
      nationality: 'Jordanian',
      city: 'Amman',
      field_of_work: 'Environment',
      preferred_language: 'ar',
    });
    expect(result.success).toBe(false);
  });

  it('accepts age_group without birth_date', () => {
    const result = personalInfoSchema.safeParse({
      phone: '+1234567890',
      country: 'Jordan',
      nationality: 'Jordanian',
      age_group: '25_34',
      city: 'Amman',
      field_of_work: 'Environment',
      preferred_language: 'ar',
    });
    expect(result.success).toBe(true);
  });
});

describe('conferenceInfoSchema', () => {
  it('requires at least one interest', () => {
    const result = conferenceInfoSchema.safeParse({
      interests: [],
      experience_level: 'beginner',
      participation_goals: 'Learn about climate policy',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid submission', () => {
    const result = conferenceInfoSchema.safeParse({
      interests: ['policy'],
      experience_level: 'beginner',
      participation_goals: 'Learn about climate policy',
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/validation/registration.test.ts`
Expected: FAIL — `Cannot find module '@/lib/validation/registration'`.

- [ ] **Step 3: Implement the schemas**

```typescript
// src/lib/validation/registration.ts
import { z } from 'zod';

export const personalInfoSchema = z
  .object({
    phone: z.string().min(6),
    country: z.string().min(1),
    nationality: z.string().min(1),
    birth_date: z.string().optional(),
    age_group: z.enum(['under_18', '18_24', '25_34', '35_44', '45_plus']).optional(),
    city: z.string().min(1),
    organization: z.string().optional(),
    field_of_work: z.string().min(1),
    preferred_language: z.enum(['ar', 'en']),
  })
  .refine((data) => Boolean(data.birth_date) || Boolean(data.age_group), {
    message: 'Either birth_date or age_group is required',
    path: ['birth_date'],
  });

export const conferenceInfoSchema = z.object({
  interests: z.array(z.string()).min(1),
  climate_experience: z.string().optional(),
  experience_level: z.enum(['none', 'beginner', 'intermediate', 'expert']),
  past_initiatives: z.string().optional(),
  participation_goals: z.string().min(1),
  topics_to_learn: z.string().optional(),
  content_type_pref: z.string().optional(),
  track_interests: z.array(z.string()).optional(),
  priority_sessions: z.string().optional(),
  special_needs: z.string().optional(),
});

export const registrationSchema = personalInfoSchema.and(conferenceInfoSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/validation/registration.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/registration.ts tests/validation/registration.test.ts
git commit -m "feat: add Zod validation schemas for registration form steps"
```

---

## Task 12: Resend Email Helper

**Files:**
- Create: `src/lib/email/resend.ts`

- [ ] **Step 1: Implement the send helper**

```typescript
// src/lib/email/resend.ts
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendRegistrationConfirmationEmail(params: {
  to: string;
  fullName: string;
  applicationNumber: string;
  locale: 'ar' | 'en';
}) {
  const subject =
    params.locale === 'ar'
      ? `تم استلام طلب التسجيل - ${params.applicationNumber}`
      : `Registration Received - ${params.applicationNumber}`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nتم استلام طلب تسجيلك بنجاح (${params.applicationNumber}). يرجى العلم أن استلام الطلب لا يعني القبول النهائي في المؤتمر، وسيتم التواصل معك بعد انتهاء فريق المؤتمر من مراجعة الطلبات.`
      : `Hello ${params.fullName},\n\nYour registration application (${params.applicationNumber}) has been received. Please note that receipt does not constitute final admission — we will contact you once the review team has finished processing applications.`;

  return resend.emails.send({
    from: 'RCOY MENA 2026 <no-reply@rcoymena.org>',
    to: params.to,
    subject,
    text: body,
  });
}
```

- [ ] **Step 2: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/email/resend.ts
git commit -m "feat: add Resend registration confirmation email helper"
```

---

## Task 13: Registration Form UI (Two Steps)

> **Known follow-up (non-blocking):** `page.tsx`'s draft-row insert has no special-casing for the `applications_one_per_applicant` unique-violation (Postgres `23505`) under a race (concurrent tabs, double-click navigation, retried request). The loser's insert throws and — since no `error.tsx` boundary exists anywhere in the `[locale]` tree yet — the user sees Next's default unstyled error page instead of being redirected to their already-created draft. The DB constraint itself holds (no duplicate rows), so this is an availability/UX gap, not a data-integrity bug. Close alongside adding a real `error.tsx` boundary in a later task.

**Files:**
- Create: `src/app/[locale]/(participant)/register/page.tsx`
- Create: `src/app/[locale]/(participant)/register/registration-form.tsx`
- Create (stub, completed in Task 14): `src/app/[locale]/(participant)/register/actions.ts`

`registration-form.tsx` imports `submitApplication` from `./actions`, but the real implementation isn't built until Task 14. Create a stub first so this task's build/dev-server checks succeed standalone; Task 14 replaces the stub body without touching its signature.

- [ ] **Step 1: Create the `actions.ts` stub**

```typescript
// src/app/[locale]/(participant)/register/actions.ts
'use server';

export async function submitApplication(applicationId: string): Promise<{ applicationNumber: string }> {
  throw new Error('Not implemented until Task 14');
}
```

- [ ] **Step 2: Server component — load or create the draft row**

```tsx
// src/app/[locale]/(participant)/register/page.tsx
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import RegistrationForm from './registration-form';

export default async function RegisterPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/log-in');

  const { data: existing } = await supabase
    .from('applications')
    .select('*')
    .eq('applicant_id', user.id)
    .maybeSingle();

  if (existing && existing.status !== 'draft') {
    redirect('/my-application');
  }

  let draft = existing;
  if (!draft) {
    const { data: created, error } = await supabase
      .from('applications')
      .insert({ applicant_id: user.id, status: 'draft' })
      .select('*')
      .single();
    if (error) throw error;
    draft = created;
  }

  return <RegistrationForm draft={draft} />;
}
```

- [ ] **Step 3: Client component — two-step form with autosave**

```tsx
// src/app/[locale]/(participant)/register/registration-form.tsx
'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { registrationSchema } from '@/lib/validation/registration';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from '@/i18n/routing';
import { submitApplication } from './actions';

type FormValues = {
  phone: string;
  country: string;
  nationality: string;
  birth_date?: string;
  age_group?: string;
  city: string;
  organization?: string;
  field_of_work: string;
  preferred_language: 'ar' | 'en';
  interests: string[];
  climate_experience?: string;
  experience_level: 'none' | 'beginner' | 'intermediate' | 'expert';
  past_initiatives?: string;
  participation_goals: string;
  topics_to_learn?: string;
  content_type_pref?: string;
  track_interests?: string[];
  priority_sessions?: string;
  special_needs?: string;
};

const INTEREST_OPTIONS = ['policy', 'technology', 'media', 'community', 'finance'] as const;

const STEP_1_FIELDS = [
  'phone', 'country', 'nationality', 'birth_date', 'age_group',
  'city', 'organization', 'field_of_work', 'preferred_language',
] as const;

const STEP_2_FIELDS = [
  'interests', 'climate_experience', 'experience_level', 'past_initiatives',
  'participation_goals', 'topics_to_learn', 'content_type_pref',
  'track_interests', 'priority_sessions', 'special_needs',
] as const;

export default function RegistrationForm({ draft }: { draft: any }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [submitting, setSubmitting] = useState(false);
  const { register, handleSubmit, getValues, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(registrationSchema),
    // A fresh draft row has interests/track_interests as `null` (no DB default), not `[]`.
    // react-hook-form's checkbox-array collection needs an array default to behave correctly,
    // so normalize both array fields here regardless of what the draft row contains.
    defaultValues: {
      ...draft,
      interests: draft.interests ?? [],
      track_interests: draft.track_interests ?? [],
    },
  });

  // Only writes the fields belonging to the step being edited, so autosaving step 1
  // never overwrites step-2 fields (e.g. required `interests`) with their empty defaults
  // before the user has reached step 2.
  async function autosaveStep(fields: readonly string[]) {
    const supabase = createClient();
    const values = getValues();
    const payload = Object.fromEntries(fields.map((f) => [f, (values as any)[f]]));
    await supabase.from('applications').update(payload).eq('id', draft.id);
  }

  const router = useRouter();

  async function onSubmit(values: FormValues) {
    setSubmitting(true);
    await autosaveStep(STEP_2_FIELDS);
    await submitApplication(draft.id);
    setSubmitting(false);
    router.push('/my-application');
  }

  if (step === 1) {
    return (
      <div>
        <input {...register('phone')} placeholder="Phone" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        <input {...register('country')} placeholder="Country" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        <input {...register('nationality')} placeholder="Nationality" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        <input {...register('birth_date')} type="date" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        <input {...register('city')} placeholder="City" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        <input {...register('organization')} placeholder="Organization" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        <input {...register('field_of_work')} placeholder="Field of work" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        <select {...register('preferred_language')} onBlur={() => autosaveStep(STEP_1_FIELDS)}>
          <option value="ar">العربية</option>
          <option value="en">English</option>
        </select>
        {errors.birth_date && <p>{errors.birth_date.message}</p>}
        <button type="button" onClick={() => setStep(2)}>Next</button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <fieldset>
        <legend>Interests (select at least one)</legend>
        {INTEREST_OPTIONS.map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              value={option}
              {...register('interests')}
              onBlur={() => autosaveStep(STEP_2_FIELDS)}
            />
            {option}
          </label>
        ))}
        {errors.interests && <p>{errors.interests.message}</p>}
      </fieldset>
      <textarea {...register('participation_goals')} placeholder="Participation goals" onBlur={() => autosaveStep(STEP_2_FIELDS)} />
      <select {...register('experience_level')} onBlur={() => autosaveStep(STEP_2_FIELDS)}>
        <option value="none">None</option>
        <option value="beginner">Beginner</option>
        <option value="intermediate">Intermediate</option>
        <option value="expert">Expert</option>
      </select>
      <button type="button" onClick={() => setStep(1)}>Back</button>
      <button type="submit" disabled={submitting}>Submit Application</button>
    </form>
  );
}
```

*(Note: react-hook-form's `register('interests')` on multiple checkboxes with the same name automatically collects checked `value`s into an array when the field default is `[]` — this is react-hook-form's native checkbox-array behavior, no extra `setValueAs` needed. `track_interests` follows the same pattern as an optional field, omitted here for brevity.)*

- [ ] **Step 4: Manual verification**

Log in as a test user, visit `/ar/register`, fill step 1, click Next, verify (via Studio) the `applications` row's fields updated after each blur, then check the `interests` checkboxes in step 2 and confirm they autosave as an array. Do not click final Submit yet — the `actions.ts` stub from Step 1 will throw, since the real implementation lands in Task 14.
Expected: draft row reflects entered values from both steps before final submit; clicking Submit surfaces the stub's "Not implemented until Task 14" error, which is expected at this point in the plan.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/(participant)/register/page.tsx" "src/app/[locale]/(participant)/register/registration-form.tsx" "src/app/[locale]/(participant)/register/actions.ts"
git commit -m "feat: add two-step registration form with autosave"
```

---

## Task 14: Submit Server Action

> **Known follow-up (non-blocking, tracked):** manual verification replicated `submitApplication`'s Supabase call sequence in a standalone script rather than driving the real server action through the framework, because `'use server'` functions require a genuine Next.js request context (`next/headers`'s `cookies()`) that a bare Node script can't provide, and no `tsx`/Playwright tooling is installed to make direct-import or headless-browser invocation practical. Spec review independently confirmed the shipped `actions.ts` matches what was tested line-by-line, including the security-critical `applicant_id`+`status='draft'` scoping — so the code itself is verified correct, but the *methodology* still carries the same "script could silently diverge from shipped file" risk noted for Task 10's sign-up verification. Recommend adding Playwright (or `tsx` + a mocked `next/headers`) in a later task to close this gap properly for both Task 10 and Task 14, and any future server-action-heavy work.

**Files:**
- Create: `supabase/migrations/0005_application_number_function.sql`
- Create: `src/app/[locale]/(participant)/register/actions.ts`

- [ ] **Step 1: Add the sequence-backed application-number RPC**

The spec requires `application_number` generation to use `nextval('application_number_seq')` inside the same transaction as the status change, not a `count(*)`-based scheme (which races under concurrent submits). Wrap the sequence call in a SQL function so the server action can call it via `rpc()`.

```sql
-- supabase/migrations/0005_application_number_function.sql
create function next_application_number() returns text as $$
  select 'RCOY-2026-' || lpad(nextval('application_number_seq')::text, 5, '0');
$$ language sql;
```

Run: `npx supabase db reset`
Expected: migration `0005` applies with no errors.

- [ ] **Step 2: Implement `submitApplication` (final version — fetches identity from `profiles`, not `applications`)**

`applications` deliberately has no `email`/`full_name` columns (see spec's Data Model note on point-in-time capture vs. account identity), so the confirmation email's recipient and display name must come from `profiles`, joined by `applicant_id`.

```typescript
// src/app/[locale]/(participant)/register/actions.ts
'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { sendRegistrationConfirmationEmail } from '@/lib/email/resend';

export async function submitApplication(applicationId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();

  const { data: application, error: fetchError } = await service
    .from('applications')
    .select('*')
    .eq('id', applicationId)
    .eq('applicant_id', user.id)
    .eq('status', 'draft')
    .single();
  if (fetchError || !application) throw new Error('Application not found or not editable');

  const { data: profile, error: profileError } = await service
    .from('profiles')
    .select('full_name, email')
    .eq('id', user.id)
    .single();
  if (profileError || !profile) throw new Error('Profile not found');

  const { data: numberResult, error: numberError } = await service.rpc('next_application_number');
  if (numberError) throw numberError;
  const applicationNumber = numberResult as string;

  const { error: updateError } = await service
    .from('applications')
    .update({
      status: 'submitted',
      application_number: applicationNumber,
      submitted_at: new Date().toISOString(),
    })
    .eq('id', applicationId);
  if (updateError) throw updateError;

  await service.from('application_status_history').insert({
    application_id: applicationId,
    old_status: 'draft',
    new_status: 'submitted',
    changed_by: null,
    note: 'Applicant-initiated submission',
  });

  const emailResult = await sendRegistrationConfirmationEmail({
    to: profile.email,
    fullName: profile.full_name,
    applicationNumber,
    locale: (application.preferred_language as 'ar' | 'en') ?? 'en',
  });

  await service.from('email_log').insert({
    application_id: applicationId,
    template: 'registration_confirmation',
    status: emailResult.error ? 'failed' : 'sent',
  });

  return { applicationNumber };
}
```

- [ ] **Step 3: Manual verification**

Complete a registration as a test user through the UI, click Submit. Check via Studio:
```sql
select status, application_number, submitted_at from applications where id = '<id>';
select * from application_status_history where application_id = '<id>';
select * from email_log where application_id = '<id>';
```
Expected: `status = 'submitted'`, `application_number` populated like `RCOY-2026-00001`, one history row, one email_log row. Also confirm in the Resend dashboard (or local logs) that the email's "to" and body name match the test user's actual `profiles.email`/`full_name` — not blank/undefined. If no `RESEND_API_KEY` is configured locally, `status = 'failed'` in `email_log` is acceptable for this local-dev check, but the `to`/`fullName` values passed into `sendRegistrationConfirmationEmail` must still be correct (verify by logging them or by temporarily configuring a real Resend test key).

- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/(participant)/register/actions.ts" supabase/migrations/0005_application_number_function.sql
git commit -m "feat: add submitApplication server action with sequence-backed numbering"
```

---

## Task 15: Applicant Status Dashboard

> **Known follow-ups (non-blocking, tracked):** (1) No generated Supabase `Database` types exist anywhere in the project, so `application.status` and other row fields are typed `any` throughout — `t(application.status)` and similar lookups are currently correct only by manual verification, not compile-time guarantee. Generate types (`supabase gen types typescript`) and pass them to `createClient<Database>()` in a later phase. (2) This page's "Submitted:" label and review-notice paragraph are hardcoded English with no `t()` call (matching the plan's own snippet), so the `ar` locale renders a translated status badge next to untranslated English boilerplate — translate these and format `submitted_at` with a locale-aware formatter in a UI-polish pass.

**Files:**
- Create: `src/app/[locale]/(participant)/my-application/page.tsx`

- [ ] **Step 1: Implement the dashboard**

```tsx
// src/app/[locale]/(participant)/my-application/page.tsx
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { getTranslations } from 'next-intl/server';

export default async function MyApplicationPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/log-in');

  const { data: application } = await supabase
    .from('applications')
    .select('*')
    .eq('applicant_id', user.id)
    .maybeSingle();

  if (!application || application.status === 'draft') redirect('/register');

  const t = await getTranslations('status');

  return (
    <div>
      <h1>{application.application_number}</h1>
      <span>{t(application.status)}</span>
      <p>Submitted: {application.submitted_at}</p>
      <p>Review is manual and may take time. You will be notified by email once a decision is made.</p>
    </div>
  );
}
```

- [ ] **Step 2: Manual end-to-end verification**

As a fresh test user: sign up → log in → redirected to `/register` → complete both steps → submit → redirected to `/my-application` → see status badge "Submitted"/"تم الإرسال".
Expected: full flow works without errors in both `ar` and `en` locales.

- [ ] **Step 3: Commit**

```bash
git add "src/app/[locale]/(participant)/my-application/page.tsx"
git commit -m "feat: add applicant status dashboard"
```

---

## Task 16: Admin Seed Script

**Files:**
- Create: `supabase/seed.sql`

- [ ] **Step 1: Write seed script for the four staff roles**

```sql
-- supabase/seed.sql
-- Run manually after creating the corresponding auth users via Supabase Studio
-- or `supabase auth admin`. This script only sets the role on existing profiles.
-- Replace the emails below with real staff emails before running.

update profiles set role = 'super_admin'
  where email = 'super-admin@rcoymena.org';

update profiles set role = 'registration_admission_manager'
  where email = 'admissions@rcoymena.org';

update profiles set role = 'agenda_allocation_manager'
  where email = 'agenda@rcoymena.org';

update profiles set role = 'communications_attendance_manager'
  where email = 'comms@rcoymena.org';
```

- [ ] **Step 2: Document the manual process**

Add a short section to a new `supabase/README.md`:
```markdown
# Seeding Staff Accounts

1. Create each staff member's auth user via Supabase Studio (Authentication > Add User) or `supabase.auth.admin.createUser`.
2. This auto-creates a `profiles` row via the `handle_new_user` trigger with `role = 'participant'`.
3. Run `seed.sql` (with real emails substituted) against the target database to upgrade their role.
```

- [ ] **Step 3: Commit**

```bash
git add supabase/seed.sql supabase/README.md
git commit -m "chore: add manual staff role seed script and docs"
```

---

## Task 17: Full Test Suite Run

- [ ] **Step 1: Run all tests**

Run: `npm run test`
Expected: all tests in `tests/validation/registration.test.ts` and `tests/rls/applications.test.ts` pass.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore: fix lint/type issues from full-suite verification" --allow-empty
```

---

## Out of Scope (confirmed non-goals, do not implement here)

- Admin review dashboard, Excel import/export, bulk accept
- Clustering / session allocation engine, Agenda management
- QR issuance and scanner app
- Dynamic form builder
- Self-service admin account creation
- Editing a submitted application
- Rate-limiting / CAPTCHA on the public form
