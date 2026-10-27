# Minor Guardian/Companion Info Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `super_admin` record a guardian/companion name + phone for under-18 applications, visible to staff on the admin participant-detail page and read-only to the participant on My Profile.

**Architecture:** Two new nullable columns on `applications` (`guardian_name`, `guardian_phone`). A single shared `isApplicationMinor()` helper decides under-18 status identically on both surfaces. Writes go through the existing `requireParticipantCareStaffCaller` domain gate via a new function in `health-info-management.ts` and a thin wrapper in `participants/care/actions.ts` — no new auth pattern, reusing the real existing `super_admin`-only participant-care-staff precedent.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres, next-intl, TypeScript, Vitest (live DB tests).

---

## Context for every task

- Working directory: `C:\Users\albar\OneDrive\سطح المكتب\COY21\COY21-App\.worktrees\minor-guardian-info`, branch `feature/minor-guardian-info`. This worktree was just rebased onto current `master` (0 commits behind) — do not re-rebase.
- Design spec: `docs/superpowers/specs/2026-10-27-minor-guardian-info-design.md` — read it in full before Task 1. This plan follows it exactly; where this plan is more specific than the spec (e.g. exact code), the plan's code wins.
- Supabase project: `vfwcbkjvinbtcntwjrzq` (COY21 production — there is no separate dev/staging project for this app). Every migration task ends with the implementer asking the controller to apply it live via `supabase db push` (controller holds the access token flow) — the implementer should NOT attempt `supabase db push` itself; it should stop after writing+showing the migration and report DONE_WITH_CONCERNS noting "needs live apply" if asked to self-push, or simply note in its report that the migration is written and tested but not yet applied, then the controller (not a subagent) runs the push after showing the SQL to the human for confirmation, exactly as every other migration in this session's history has been handled.
- `.env.local` already exists in this worktree (copied from the main checkout) — live-DB tests will work without extra setup.
- Known pre-existing `tsc --noEmit` baseline: ~419 errors, all confined to `tests/attendance/qr-issuance-reservation.test.ts` and `tests/attendance/qr-credentials-lifecycle-trigger.test.ts`. Any task's typecheck must show zero *new* errors outside those two files.

---

### Task 1a: Database migration — guardian columns (write only, do not apply)

**Files:**
- Create: `supabase/migrations/20261028100000_add_guardian_info_to_applications.sql`
- Test: `tests/participants/guardian-info-schema-live.test.ts`

**Confirmed live** (2026-10-28, against `vfwcbkjvinbtcntwjrzq`): `applications.age_group` and `applications.birth_date` already exist; `applications.guardian_name`/`guardian_phone` do not exist yet.

**⚠️ THIS TASK'S JOB IS STEPS 1–2 ONLY. Do not run the test, do not attempt `supabase db push`, do not regenerate `src/types/database.ts`, and do not commit.** The migration cannot be verified or committed yet because the live columns don't exist and the generated types don't know about them — both of those happen in Task 1b, which is a *separate, controller-only* task that runs after this one, outside subagent-driven-development. When you finish Step 2, report **DONE_WITH_CONCERNS** with the concern "migration + test written, live apply and commit are Task 1b's job, not mine." Do not treat the unchecked Steps 3+ below as part of your work.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20261028100000_add_guardian_info_to_applications.sql
--
-- Adds nullable guardian/companion contact fields for under-18
-- applications. Lives on `applications` (not application_health_info)
-- per the design spec's reasoning: this is about who is responsible for
-- the attendee, not a medical/health concern, and applications already
-- owns age_group/birth_date (the under-18 signal these fields depend
-- on). No RLS policy change needed: applications' existing staff
-- UPDATE policy already covers this, and the server action's
-- requireParticipantCareStaffCaller() check (service-role, bypasses
-- RLS) is the real gate, same as every other participant-care write in
-- this codebase.
alter table applications
  add column if not exists guardian_name text,
  add column if not exists guardian_phone text;
```

`add column if not exists` makes this safe to re-run.

- [ ] **Step 2: Write a live test proving the columns exist and are writable/nullable**

```typescript
// tests/participants/guardian-info-schema-live.test.ts
//
// Minimal live-schema proof for the guardian_name/guardian_phone
// columns added in 20261028100000_add_guardian_info_to_applications.sql
// -- mirrors the shape of other *-schema-live.test.ts files in this
// codebase (e.g. tests/cafeteria/schema-live.test.ts): no business
// logic here, just confirming the columns exist with the right
// nullability via a real insert/select round trip.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
let applicantUserId: string;
let applicationId: string;

beforeAll(async () => {
  const { data: user, error } = await admin.auth.admin.createUser({
    email: `guardian-schema-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error || !user.user) throw new Error(`fixture user setup failed: ${error?.message}`);
  applicantUserId = user.user.id;
});

afterAll(async () => {
  if (applicationId) await admin.from('applications').delete().eq('id', applicationId);
  if (applicantUserId) await admin.auth.admin.deleteUser(applicantUserId);
});

describe('applications.guardian_name / guardian_phone', () => {
  it('accepts null on insert (column is nullable)', async () => {
    const { data, error } = await admin
      .from('applications')
      .insert({ applicant_id: applicantUserId, status: 'draft' })
      .select('id, guardian_name, guardian_phone')
      .single();
    expect(error).toBeNull();
    applicationId = data!.id;
    expect(data!.guardian_name).toBeNull();
    expect(data!.guardian_phone).toBeNull();
  });

  it('stores and reads back real values', async () => {
    const { data, error } = await admin
      .from('applications')
      .update({ guardian_name: 'Fatima Al-Rashid', guardian_phone: '+96899112233' })
      .eq('id', applicationId)
      .select('guardian_name, guardian_phone')
      .single();
    expect(error).toBeNull();
    expect(data!.guardian_name).toBe('Fatima Al-Rashid');
    expect(data!.guardian_phone).toBe('+96899112233');
  });
});
```

This ends Task 1a. Report DONE_WITH_CONCERNS now — do not continue to the steps below.

---

### Task 1b: Apply migration live, verify, commit (controller only — NOT a subagent task)

This task is executed by the controller directly in the main session, never dispatched to an implementer subagent. It depends on Task 1a being done.

- [ ] **Step 1: Show the migration SQL to the human and get explicit confirmation to apply it** (standing requirement for every production migration in this project — see this session's prior history).

- [ ] **Step 2: Apply it live**

```bash
SUPABASE_ACCESS_TOKEN="<fresh token>" npx supabase db push --yes
```

A fresh personal access token will likely be needed — same recurring issue as every prior migration task in this session's history. Ask the human for one via Dashboard → Account Settings → Access Tokens, Project-scoped to COY21, when this reports "Invalid access token".

- [ ] **Step 3: Regenerate types**

```bash
SUPABASE_ACCESS_TOKEN="<fresh token>" npx supabase gen types typescript --project-id vfwcbkjvinbtcntwjrzq > src/types/database.ts
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run tests/participants/guardian-info-schema-live.test.ts
```
Expected: 2/2 pass (only possible now that the live columns exist and the generated types know about them).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261028100000_add_guardian_info_to_applications.sql tests/participants/guardian-info-schema-live.test.ts src/types/database.ts
git commit -m "feat: add guardian_name/guardian_phone columns to applications"
```

Only after Task 1b's commit lands may Task 3 (which depends on the regenerated types) begin.

---

### Task 2: `isApplicationMinor` shared helper

**Files:**
- Create: `src/lib/participants/minor.ts`
- Test: `src/lib/participants/minor.test.ts`

This is a pure function, no live DB needed — ordinary unit test.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/participants/minor.test.ts
import { describe, it, expect } from 'vitest';
import { isApplicationMinor, CONFERENCE_START_DATE } from './minor';

describe('isApplicationMinor', () => {
  it('returns true when age_group is under_18, regardless of birth_date', () => {
    expect(isApplicationMinor({ age_group: 'under_18', birth_date: null })).toBe(true);
    expect(isApplicationMinor({ age_group: 'under_18', birth_date: '1990-01-01' })).toBe(true);
  });

  it('returns false when age_group is any other bucket, regardless of birth_date', () => {
    expect(isApplicationMinor({ age_group: '18_24', birth_date: null })).toBe(false);
    expect(isApplicationMinor({ age_group: '45_plus', birth_date: '2015-01-01' })).toBe(false);
  });

  it('falls back to birth_date when age_group is null: under 18 as of conference start', () => {
    // CONFERENCE_START_DATE is 2026-11-05. Born 2009-01-01 -> 17 at conference start.
    expect(isApplicationMinor({ age_group: null, birth_date: '2009-01-01' })).toBe(true);
    // Born 2008-01-01 -> 18 at conference start (birthday already passed).
    expect(isApplicationMinor({ age_group: null, birth_date: '2008-01-01' })).toBe(false);
    // Exact edge: born 2008-11-05 -> turns 18 exactly on conference start date -> not a minor.
    expect(isApplicationMinor({ age_group: null, birth_date: '2008-11-05' })).toBe(false);
    // One day later than the edge: still 17 the day before their 18th birthday.
    expect(isApplicationMinor({ age_group: null, birth_date: '2008-11-06' })).toBe(true);
  });

  it('returns false (never throws) when both age_group and birth_date are null', () => {
    expect(isApplicationMinor({ age_group: null, birth_date: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/lib/participants/minor.test.ts
```
Expected: fails with "Cannot find module './minor'".

- [ ] **Step 3: Implement**

```typescript
// src/lib/participants/minor.ts
//
// Single source of truth for "is this applicant a minor (under 18)",
// used identically by the admin participant-detail page and the
// participant's own My Profile page so the under-18 rule can never
// drift between the two surfaces that gate on it.
//
// Reference date is the CONFERENCE start date, not "today": a minor who
// turns 18 between now and the conference is still a minor -- and still
// needs a contactable guardian -- while physically attending. No
// existing CONFERENCE_START_DATE-style constant exists elsewhere in
// this codebase, so this file defines its own local one.
export const CONFERENCE_START_DATE = '2026-11-05';

export function isApplicationMinor(application: {
  age_group: string | null;
  birth_date: string | null;
}): boolean {
  if (application.age_group != null) {
    return application.age_group === 'under_18';
  }

  if (application.birth_date != null) {
    return ageAsOf(application.birth_date, CONFERENCE_START_DATE) < 18;
  }

  // Both null: should not occur for self-registered applications (the
  // registration schema's .refine requires one of the two), but
  // imported applications can bypass that schema entirely -- resolve to
  // false rather than throw, matching this codebase's general
  // fail-closed-but-non-crashing convention for defensive branches.
  return false;
}

function ageAsOf(birthDate: string, asOfDate: string): number {
  const birth = new Date(birthDate + 'T00:00:00Z');
  const asOf = new Date(asOfDate + 'T00:00:00Z');

  let age = asOf.getUTCFullYear() - birth.getUTCFullYear();
  const hasHadBirthdayByAsOf =
    asOf.getUTCMonth() > birth.getUTCMonth() ||
    (asOf.getUTCMonth() === birth.getUTCMonth() && asOf.getUTCDate() >= birth.getUTCDate());
  if (!hasHadBirthdayByAsOf) age -= 1;

  return age;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run src/lib/participants/minor.test.ts
```
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/participants/minor.ts src/lib/participants/minor.test.ts
git commit -m "feat: add isApplicationMinor shared under-18 detection helper"
```

---

### Task 3: Guardian info read/update logic + server action

**Files:**
- Modify: `src/lib/participant-care/health-info-management.ts` (add new exports; do not touch existing health-info exports)
- Modify: `src/app/[locale]/(admin)/participants/care/actions.ts` (add one new thin wrapper + one new type export line)
- Test: `tests/participants/guardian-info-update-live.test.ts`

**Depends on Task 1b** (columns must exist live) **and the regenerated `src/types/database.ts`** that Task 1b produces — do not start this task until Task 1b is fully committed in this same worktree.

- [ ] **Step 1: Write the failing live test**

```typescript
// tests/participants/guardian-info-update-live.test.ts
//
// Direct-call coverage for updateGuardianInfoForCaller, same style as
// participant-care-live.test.ts's updateHealthInfoForCaller tests: a
// manually constructed { userId, service } caller (no auth-gate
// involved -- see that file's own header comment for why
// requireParticipantCareStaffCaller itself can't be invoked from a
// test, and docs/superpowers/specs/2026-10-27-minor-guardian-info-
// design.md's Testing section for the same reasoning applied here).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { updateGuardianInfoForCaller } from '@/lib/participant-care/health-info-management';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
let staffUserId: string;
let applicantUserId: string;
let applicationId: string;
const auditLogIds: string[] = [];

beforeAll(async () => {
  const { data: staff, error: staffError } = await admin.auth.admin.createUser({
    email: `guardian-update-${runId}-staff@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (staffError || !staff.user) throw new Error(`staff fixture setup failed: ${staffError?.message}`);
  staffUserId = staff.user.id;
  await admin.from('profiles').update({ role: 'super_admin' }).eq('id', staffUserId);

  const { data: applicant, error: applicantError } = await admin.auth.admin.createUser({
    email: `guardian-update-${runId}-applicant@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (applicantError || !applicant.user) throw new Error(`applicant fixture setup failed: ${applicantError?.message}`);
  applicantUserId = applicant.user.id;

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: applicantUserId, status: 'accepted', age_group: 'under_18' })
    .select('id')
    .single();
  if (appError || !app) throw new Error(`application fixture setup failed: ${appError?.message}`);
  applicationId = app.id;
});

afterAll(async () => {
  if (auditLogIds.length > 0) await admin.from('audit_logs').delete().in('id', auditLogIds);
  if (applicationId) await admin.from('applications').delete().eq('id', applicationId);
  for (const id of [staffUserId, applicantUserId].filter(Boolean)) {
    await admin.auth.admin.deleteUser(id);
  }
});

describe('updateGuardianInfoForCaller', () => {
  it('writes guardian_name/guardian_phone onto the right application row', async () => {
    const result = await updateGuardianInfoForCaller(
      { userId: staffUserId, service: admin },
      applicationId,
      { guardian_name: 'Noura Al-Harthy', guardian_phone: '+96899887766' }
    );
    expect(result.guardian_name).toBe('Noura Al-Harthy');
    expect(result.guardian_phone).toBe('+96899887766');

    const { data: row } = await admin
      .from('applications')
      .select('guardian_name, guardian_phone')
      .eq('id', applicationId)
      .single();
    expect(row!.guardian_name).toBe('Noura Al-Harthy');
    expect(row!.guardian_phone).toBe('+96899887766');
  });

  it('writes an audit log entry for the update', async () => {
    const { data: before } = await admin
      .from('audit_logs')
      .select('id')
      .eq('entity_id', applicationId)
      .eq('action', 'guardian_info_updated');
    const beforeCount = before?.length ?? 0;

    await updateGuardianInfoForCaller(
      { userId: staffUserId, service: admin },
      applicationId,
      { guardian_name: 'Updated Name', guardian_phone: '+96899887766' }
    );

    const { data: after } = await admin
      .from('audit_logs')
      .select('id')
      .eq('entity_id', applicationId)
      .eq('action', 'guardian_info_updated');
    for (const row of after ?? []) auditLogIds.push(row.id);
    expect((after?.length ?? 0)).toBe(beforeCount + 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/participants/guardian-info-update-live.test.ts
```
Expected: fails — `updateGuardianInfoForCaller` is not exported yet.

- [ ] **Step 3: Implement in `health-info-management.ts`**

Add these exports to the existing file (do not remove or restructure anything already there):

```typescript
export type GuardianInfo = {
  guardian_name: string | null;
  guardian_phone: string | null;
};

export type GuardianUpdateInput = {
  guardian_name: string | null;
  guardian_phone: string | null;
};

// Plain update (not upsert, unlike updateHealthInfoForCaller): unlike
// application_health_info, applications always has exactly one row per
// application already -- there is no "row doesn't exist yet" case to
// handle here.
export async function updateGuardianInfoForCaller(
  caller: Caller,
  applicationId: string,
  input: GuardianUpdateInput
): Promise<GuardianInfo> {
  const { service, userId } = caller;
  const { data: before } = await service
    .from('applications')
    .select('guardian_name, guardian_phone')
    .eq('id', applicationId)
    .maybeSingle();

  const { data, error } = await service
    .from('applications')
    .update(input)
    .eq('id', applicationId)
    .select('guardian_name, guardian_phone')
    .single();
  if (error) throw new Error(error.message);

  await writeAuditLog(service, {
    entityType: 'applications',
    entityId: applicationId,
    action: 'guardian_info_updated',
    actorId: userId,
    oldValues: before,
    newValues: data,
  });

  return data;
}
```

- [ ] **Step 4: Add the thin wrapper to `care/actions.ts`**

```typescript
// Add to the existing imports:
import {
  searchParticipantsForCareForCaller,
  fetchHealthInfoForCaller,
  updateHealthInfoForCaller,
  updateGuardianInfoForCaller,
  type HealthInfoUpdateInput,
  type GuardianUpdateInput,
} from '@/lib/participant-care/health-info-management';

// Add alongside the existing exported functions:
export async function updateGuardianInfo(applicationId: string, input: GuardianUpdateInput) {
  const caller = await requireParticipantCareStaffCaller();
  return updateGuardianInfoForCaller(caller, applicationId, input);
}

// Add to the existing `export type { ... }` line:
export type { ParticipantSearchResult, HealthInfo, HealthInfoUpdateInput, GuardianInfo, GuardianUpdateInput } from '@/lib/participant-care/health-info-management';
```

- [ ] **Step 5: Run to verify it passes**

```bash
npx vitest run tests/participants/guardian-info-update-live.test.ts
```
Expected: 2/2 pass.

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```
Expected: same ~419-error baseline as noted in "Context for every task", zero new errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/participant-care/health-info-management.ts "src/app/[locale]/(admin)/participants/care/actions.ts" tests/participants/guardian-info-update-live.test.ts
git commit -m "feat: add guardian info update logic and server action"
```

---

### Task 4: Admin UI — `GuardianControls` on the participant detail page

**Files:**
- Create: `src/app/[locale]/(admin)/participants/[applicationId]/guardian-controls.tsx`
- Modify: `src/app/[locale]/(admin)/participants/[applicationId]/page.tsx` (widen select, render the new component)
- Modify: `src/messages/en.json`, `src/messages/ar.json` (new `participants.guardian.*` keys)

**Depends on Task 2** (`isApplicationMinor`) **and Task 3** (`updateGuardianInfo` action).

This page currently selects (confirmed live in this file, 2026-10-28):
```
'id, applicant_id, imported_email, status, application_number, participant_type, phone, country, nationality, birth_date, age_group, city, organization, field_of_work, preferred_language, interests, climate_experience, experience_level, past_initiatives, participation_goals, topics_to_learn, content_type_pref, track_interests, priority_sessions, special_needs, submitted_at, created_at, import_batch_id'
```

- [ ] **Step 1: Widen the page's `applications` select**

In `page.tsx`, add `guardian_name, guardian_phone` to the select list above (`age_group` is already present — append the two new columns right after it, e.g. `..., age_group, guardian_name, guardian_phone, city, ...`).

- [ ] **Step 2: Add i18n keys**

Add to both `src/messages/en.json` and `src/messages/ar.json`, nested under `participants` (match the existing `participants.classification.*` nesting shape):

```json
"guardian": {
  "title": "Guardian / Companion",
  "name": "Name",
  "phone": "Phone",
  "save": "Save",
  "saving": "Saving…",
  "genericError": "Action failed"
}
```

(`"Action failed"` matches the sibling `participants.classification.genericError` key's existing copy style exactly — not a new tone for this one card.)

Arabic (`ar.json`):
```json
"guardian": {
  "title": "الواصي أو المرافق",
  "name": "الاسم",
  "phone": "رقم الهاتف",
  "save": "حفظ",
  "saving": "جارٍ الحفظ...",
  "genericError": "فشل الإجراء"
}
```

- [ ] **Step 3: Write `GuardianControls`**

Mirror `classification-controls.tsx`'s exact shape (client component, local `useState` form fields, a `run()` wrapper with busy/error state, `window.location.reload()` on success). Use `PhoneInput` from `react-phone-number-input` directly in this new file (do not try to import the local, non-exported `PhoneField` from `my-profile/profile-forms.tsx` — it is not exported from that module; duplicating the small wrapper here, styled the same way, is consistent with this codebase's existing pattern of small per-file UI wrappers rather than introducing a new shared component for a two-field form).

```typescript
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import PhoneInput from 'react-phone-number-input';
import 'react-phone-number-input/style.css';
import { updateGuardianInfo } from '../care/actions';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function GuardianControls({
  applicationId,
  guardianName,
  guardianPhone,
}: {
  applicationId: string;
  guardianName: string | null;
  guardianPhone: string | null;
}) {
  const t = useTranslations('participants.guardian');
  const [name, setName] = useState(guardianName ?? '');
  const [phone, setPhone] = useState(guardianPhone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      await updateGuardianInfo(applicationId, {
        guardian_name: name.trim() === '' ? null : name.trim(),
        guardian_phone: phone.trim() === '' ? null : phone.trim(),
      });
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('title')}</h2>
      <Card className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-charcoal/70 dark:text-gray-400">{t('name')}</label>
            <input
              className="rounded-md border border-charcoal/20 bg-transparent px-2 py-1.5 text-sm text-charcoal dark:border-gray-700 dark:text-gray-100"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-charcoal/70 dark:text-gray-400">{t('phone')}</label>
            <PhoneInput
              international
              countryCallingCodeEditable={false}
              defaultCountry="TR"
              value={phone}
              disabled={busy}
              onChange={(v) => setPhone(v ?? '')}
              className="rounded-md border border-charcoal/20 bg-transparent px-2 py-1.5 text-sm text-charcoal dark:border-gray-700 dark:text-gray-100"
            />
          </div>
        </div>
        <div>
          <Button size="sm" disabled={busy} onClick={() => void handleSave()}>
            {busy ? t('saving') : t('save')}
          </Button>
        </div>
      </Card>
    </section>
  );
}
```

- [ ] **Step 4: Render it from `page.tsx`, gated on `isApplicationMinor`**

Import `isApplicationMinor` from `@/lib/participants/minor` and `GuardianControls` from `./guardian-controls`. Render `<GuardianControls applicationId={application.id} guardianName={application.guardian_name} guardianPhone={application.guardian_phone} />` immediately after (or near) the existing `ClassificationControls` render, wrapped in `{isApplicationMinor(application) && (...)}`.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```
Expected: same baseline, zero new errors.

- [ ] **Step 6: Manual verification note**

This task involves a UI component with no automated test (matching the design spec's own Testing section, which calls for manual verification here, same as this session's established pattern for small UI additions). The implementer should note in its report that manual browser verification (does the card render only for `under_18` applications, does save work, does the page reload with the new values) is deferred to the end of all tasks, not skipped — the controller will coordinate one combined manual pass after Task 5.

- [ ] **Step 7: Commit**

```bash
git add "src/app/[locale]/(admin)/participants/[applicationId]/guardian-controls.tsx" "src/app/[locale]/(admin)/participants/[applicationId]/page.tsx" src/messages/en.json src/messages/ar.json
git commit -m "feat: add GuardianControls to admin participant detail page"
```

---

### Task 5: Participant UI — read-only guardian card on My Profile

**Files:**
- Modify: `src/app/[locale]/(participant)/(shell)/my-profile/page.tsx` (widen select, render a new read-only card)
- Modify: `src/messages/en.json`, `src/messages/ar.json` (reuse `participants.guardian.title/name/phone` keys from Task 4 — no new keys needed beyond what Task 4 already added)

**Depends on Task 2** (`isApplicationMinor`) **and Task 4** (the `participants.guardian.*` i18n keys this task reuses rather than redeclaring).

This page currently selects (confirmed live in this file, 2026-10-28): `'id, status'` from `applications`.

- [ ] **Step 1: Widen the page's `applications` select**

Change `.select('id, status')` to `.select('id, status, age_group, birth_date, guardian_name, guardian_phone')`.

RLS note (already verified in the design spec, re-confirm if anything looks off): `applications_select_own` is a plain row-level policy with no column restriction, and the `authenticated` grant is table-level — so this is a pure select-list change needing no new RLS policy or grant.

- [ ] **Step 2: Render a read-only card**

**Important: this page currently has no i18n at all.** Confirmed (2026-10-28): there is no `useTranslations`/`getTranslations` import anywhere in `my-profile/page.tsx`, `profile-forms.tsx`, or `actions.ts` — every existing string on this page ("My Profile", "Emergency Contacts", "Accommodation", etc.) is hardcoded English JSX text. Do not try to "match an existing convention" here, because none exists. Instead, add `getTranslations` as a new, additive import for this one card only, matching the admin side's own real pattern (`src/app/[locale]/(admin)/participants/[applicationId]/page.tsx:8,83`: `import { getTranslations } from 'next-intl/server';` then `const t = await getTranslations({ locale, namespace: 'participants.guardian' });`). Do not touch or translate any of the page's existing hardcoded strings — this is strictly additive, scoped to the new card only.

Render the card only when `isApplicationMinor(application)` is true **and** at least one of `guardian_name`/`guardian_phone` is non-null (don't show an empty card to a minor whose guardian info hasn't been entered yet). Plain display, no form, no edit affordance — the organizing team is the source of truth.

Example shape (adapt to this file's actual existing component/server-component structure — read the file first, this is illustrative, not a literal drop-in):

```tsx
{isApplicationMinor(application) && (application.guardian_name || application.guardian_phone) && (
  <Card className="flex flex-col gap-2">
    <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">{t('title')}</h2>
    {application.guardian_name && (
      <p className="text-sm">
        <span className="text-charcoal/60 dark:text-gray-400">{t('name')}: </span>
        {application.guardian_name}
      </p>
    )}
    {application.guardian_phone && (
      <p className="text-sm">
        <span className="text-charcoal/60 dark:text-gray-400">{t('phone')}: </span>
        {application.guardian_phone}
      </p>
    )}
  </Card>
)}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```
Expected: same baseline, zero new errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/(participant)/(shell)/my-profile/page.tsx"
git commit -m "feat: show read-only guardian info card on My Profile for minors"
```

---

### Task 6: Auth-gate logic-replication test

**Files:**
- Modify: `tests/participants/guardian-info-update-live.test.ts` (add one more `describe` block) — OR create a new file if the implementer judges that cleaner; either is fine.

**Depends on Task 3.**

Per the design spec's Testing section and confirmed directly against `src/lib/participant-care/server-helpers.ts` in this plan's own research: `requireParticipantCareStaffCaller` cannot be invoked directly in a test (it calls `next/headers`'s `cookies()` outside a request context), and no existing test exercises its auth check directly. Mirror `tests/agenda/authorization.test.ts`'s logic-replication approach instead: re-implement the exact condition the real helper checks, against real `profiles.role` values read from the live database.

- [ ] **Step 1: Write the test**

```typescript
// Add to tests/participants/guardian-info-update-live.test.ts (or a new
// file) -- re-implements requireParticipantCareStaffCaller's exact
// condition (`!isStaffRole(profile.role) || profile.role === 'staff'`
// means NOT authorized) against real profiles.role values, same
// logic-replication approach as tests/agenda/authorization.test.ts.
// This does not call the real helper (it can't be invoked outside a
// request context) -- it proves the condition itself behaves correctly
// for the roles that matter to this feature.
import { isStaffRole } from '@/lib/auth/is-staff-role';

describe('requireParticipantCareStaffCaller auth condition (logic replication)', () => {
  it('rejects plain staff', async () => {
    const { data: staffUser } = await admin.auth.admin.createUser({
      email: `guardian-auth-${runId}-plain-staff@test.local`,
      password: 'password123',
      email_confirm: true,
    });
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffUser!.user!.id);
    const { data: profile } = await admin.from('profiles').select('role').eq('id', staffUser!.user!.id).single();

    const isAuthorized = isStaffRole(profile!.role) && profile!.role !== 'staff';
    expect(isAuthorized).toBe(false);

    await admin.auth.admin.deleteUser(staffUser!.user!.id);
  });

  it('accepts super_admin', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', staffUserId).single();
    const isAuthorized = isStaffRole(profile!.role) && profile!.role !== 'staff';
    expect(isAuthorized).toBe(true);
  });
});
```

(`staffUserId` here reuses the `super_admin` fixture already created in this file's `beforeAll` — if placed in a new file instead, create a small local fixture following the same pattern.)

- [ ] **Step 2: Run**

```bash
npx vitest run tests/participants/guardian-info-update-live.test.ts
```
Expected: all tests in the file pass (original 2 + these 2 new).

- [ ] **Step 3: Commit**

```bash
git add tests/participants/guardian-info-update-live.test.ts
git commit -m "test: add logic-replication coverage for guardian-info auth gate"
```

---

### Task 7: Final review, combined manual verification, and merge

Not a subagent task — handled by the controller directly after Tasks 1–6 are all individually spec/quality-reviewed and approved.

- [ ] Dispatch a final whole-branch code-reviewer subagent for the entire `feature/minor-guardian-info` diff against `master` (same shape as the final review used for the cafeteria-lunch-qr feature: cross-task consistency, security/RLS re-verification, live test run, typecheck/lint, i18n completeness).
- [ ] Coordinate with the human for one combined manual browser verification pass: as `super_admin`, open an under-18 application's admin detail page, confirm `GuardianControls` renders, save a name+phone, confirm it persists on reload; as that minor participant, open My Profile, confirm the read-only card shows the saved values; confirm the card does NOT render for a non-minor application in either admin or participant view.
- [ ] Use `superpowers:finishing-a-development-branch` to decide merge/PR approach once verification passes.
