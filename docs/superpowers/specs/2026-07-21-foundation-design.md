# RCOY MENA 2026 — Phase 1: Foundation Design

**Date:** 2026-07-21
**Status:** Approved for planning

## Purpose

Establish the technical foundation for the RCOY MENA 2026 conference platform: project scaffold, the five-role permission system, and the public registration flow (form submission + confirmation + status tracking). This is the first of several phases described in the platform's operational spec (registration → admission review → clustering → session allocation → QR check-in). Later phases (admission review dashboard, agenda/clustering engine, communications, QR/scanner) are out of scope here and will each get their own brainstorm/spec/plan cycle.

## Non-goals (explicitly out of scope for this phase)

- Admin review dashboard for applications (filtering, notes, Excel import/export, bulk accept)
- Clustering / session allocation engine
- Session and room management (Agenda)
- QR issuance and scanner app
- Email templates beyond the single "registration received" confirmation
- Dynamic form builder (fields are hardcoded in this phase)
- Self-service creation of admin/staff accounts (seeded manually via SQL/script)
- Withdrawing an application (the `withdrawn` status is defined in the enum now for schema stability across phases, but no UI path reaches it in Phase 1)
- Rate-limiting, CAPTCHA, or duplicate-submission protection on the public registration form
- Editing an application after it has been submitted (see User Flow)

## Tech Stack

- **Next.js 14+ (App Router)**, TypeScript
- **`app/[locale]/...`** routing for Arabic/English via `next-intl`, matching the pattern used in the user's other projects (Talent OS, greengate-hub)
- **Supabase**: Postgres, Auth, Row-Level Security
- **Tailwind CSS**
- **react-hook-form + Zod** for form validation
- **Resend** for transactional email (registration confirmation)

## Data Model

```sql
-- Five platform roles
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

-- Auto-create a profile row when a new auth user signs up.
-- full_name/email are seeded from auth signup metadata; role defaults to 'participant'.
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

create type application_status as enum (
  'draft',
  'submitted',
  'under_review',
  'accepted',
  'waitlisted',
  'rejected',
  'withdrawn'
);

create table applications (
  id uuid primary key default gen_random_uuid(),
  applicant_id uuid not null references profiles(id) on delete cascade,
  application_number text unique, -- assigned on submit, see "Application Number Generation" below
  status application_status not null default 'draft',

  -- Personal information. These are captured on the application (not read from
  -- profiles) because a submitted application is a point-in-time record: profile
  -- data can change after submission without altering what was actually submitted.
  phone text,
  country text,
  nationality text,
  birth_date date,
  age_group text, -- one of: 'under_18' | '18_24' | '25_34' | '35_44' | '45_plus'
  city text,
  organization text,
  field_of_work text,
  preferred_language text, -- one of: 'ar' | 'en'

  -- Conference-related information. Free text / arrays, captured for later manual
  -- review and (in a future phase) clustering input; no value-domain constraints
  -- are enforced in Phase 1 beyond required/optional (see registration form spec).
  interests text[],
  climate_experience text,
  experience_level text, -- one of: 'none' | 'beginner' | 'intermediate' | 'expert'
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

-- One application per account. Applicant's name/email come from `profiles`
-- (via applicant_id), which is authoritative for account identity and display.
create unique index applications_one_per_applicant on applications (applicant_id);

create trigger applications_set_updated_at
  before update on applications
  for each row execute function moddatetime('updated_at'); -- Supabase's `moddatetime` extension

-- Generic transition log, deliberately schema-stable for Phase 2 (manual review
-- will drive further transitions here). In Phase 1 the only writer is the
-- draft->submitted server action described below; changed_by is null for that
-- transition since it's applicant-initiated, not staff-initiated.
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
  status text not null, -- 'sent' | 'failed'
  sent_at timestamptz not null default now()
);
```

### Application Number Generation

A Postgres sequence (`application_number_seq`) backs generation, done in the same server action that transitions `draft → submitted` (not a DB trigger, so it can be skipped/retried cleanly if the submit action fails after the status check but before commit):

```sql
create sequence application_number_seq start 1;
```

Format: `RCOY-2026-{nextval(application_number_seq) padded to 5 digits}`, e.g. `RCOY-2026-00001`. The year is a literal for the 2026 conference (not derived), consistent with this being a single-conference platform in Phase 1. Uniqueness is guaranteed by the sequence; the `unique` constraint on the column is a backstop.

### Row-Level Security

- `profiles`:
  - a user can read/update their own row; `super_admin` can read/update all.
  - insert: none — rows are created only by the `handle_new_user` trigger (`security definer`), not by client-side inserts.
- `applications`:
  - `participant` (applicant): can `select`/`delete` their own application (`applicant_id = auth.uid()`) only while `status = 'draft'`; can `insert` their own application (`applicant_id = auth.uid()`) with `status = 'draft'`, subject to the one-per-applicant unique index. `update` is permitted only `using (applicant_id = auth.uid() and status = 'draft')` **with `check (applicant_id = auth.uid() and status = 'draft')`** — the `WITH CHECK` clause is required so a client-side update cannot itself change `status` (or `application_number`/`submitted_at`) to anything other than `'draft'`; the only path from `draft` to `submitted` is the server action below, which runs under the service role and bypasses RLS entirely. Once `status` is `submitted` or later, the row is **read-only** to the applicant — there is no Phase 1 path to edit a submitted application (see Non-goals). A `rejected` application is likewise permanent in Phase 1: the one-per-applicant unique index means a rejected applicant cannot create a new application; re-application (if ever supported) is deferred to a later phase.
  - `registration_admission_manager`, `super_admin`: read all applications (write access for review actions is deferred to the next phase, but the read policy is established now).
  - No other role has access to `applications` in this phase.
- `application_status_history`, `email_log`: no client-facing insert policy exists for either table, so RLS default-denies all client-side inserts; the service role used by the submit server action bypasses RLS entirely (this is a bypass, not a granted policy). The `draft → submitted` transition is performed by a Next.js server action using the service role, not a direct client-side table write, so it can atomically assign `application_number`, update `status`, and insert the history/log rows in one transaction. Both tables are readable by `super_admin` and `registration_admission_manager`.

## User Flow

```text
Visitor lands on platform
  → Create account (Supabase Auth, email/password)
  → Verify account email (Supabase Auth's built-in email-verification link)
  → Log in
  → If an application already exists (any status) → redirected to "My Application" status page
  → If no application exists → redirected to registration form, which creates a 'draft' row
  → Multi-step form, autosaved as draft (client writes directly to own draft row, RLS-gated)
  → Final submit → server action: assigns application_number, sets status='submitted',
    submitted_at=now(), inserts application_status_history row, sends registration
    confirmation email via Resend, inserts email_log row — all in one transaction
  → Success message shown; redirect to "My Application" status page
```

The confirmation message (in-app and the Resend registration-confirmation email) explicitly states that receipt is not an admission decision, per the operational spec.

## Registration Form Steps

Two steps, matching the schema's two field groups:

1. **Personal information** — required: `phone`, `country`, `nationality`, `birth_date` or `age_group` (at least one), `city`, `field_of_work`, `preferred_language`. Optional: `organization`. The form asks for `birth_date` by default; applicants who decline to give an exact date may instead pick an `age_group` band directly. Neither is derived from the other — if `birth_date` is given, `age_group` is left null (the exact date is authoritative and sufficient for any later age-based logic); `age_group` is only populated when `birth_date` is withheld.
2. **Conference-related information** — required: `interests` (min 1), `experience_level`, `participation_goals`. Optional: `climate_experience`, `past_initiatives`, `topics_to_learn`, `content_type_pref`, `track_interests`, `priority_sessions`, `special_needs`.

Each step autosaves to the `draft` row on blur/step-change. The final submit button (step 2) is disabled until all required fields across both steps are valid.

`preferred_language` captures the applicant's stated language preference for future communications (Phase 5); it does not drive the UI locale, which is controlled independently by the `[locale]` route segment.

## Applicant Dashboard

A single page showing:
- Application number
- Current status as a visual badge (draft/submitted/under_review/accepted/waitlisted/rejected/withdrawn)
- Submission date
- Explanatory note that review is manual and takes time

`email_log` is intentionally not surfaced on the dashboard in Phase 1 — it exists for staff-side delivery troubleshooting only (readable by `super_admin`/`registration_admission_manager`), not applicant-facing status.

## Seeding Admin Accounts

The four staff roles (`super_admin` and the three managers) are created manually via a SQL seed script for this phase — no self-service admin signup UI.

## Testing

- Zod schema validation unit tests for the registration form
- RLS policy tests (participant cannot read others' applications; managers can read all; no other role can access `applications`)
- Integration test for the submit flow: draft → submitted transition, application_number generation, status_history row created, email_log entry created
