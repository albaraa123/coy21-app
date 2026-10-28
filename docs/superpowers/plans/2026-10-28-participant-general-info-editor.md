# Participant General Information Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `super_admin` edit the ~31 general-profile `applications` columns that currently have no edit UI anywhere, on the existing `/participants/[applicationId]` admin page, without touching any column already covered by a specialized console (Classification, Guardian, Health, Travel, Funding, application review).

**Architecture:** A single server action (`updateGeneralInfoForCaller`/`updateGeneralInfoAction`) writing directly to `applications` via a plain `update`, gated by the existing `requireAgendaStaffCaller()` helper (already effectively `super_admin`-only). A new client component mirrors the existing Health Info/Travel Info consoles' single-form-single-save shape, scaled to ~31 fields. Array fields (6 of the 31) are edited as comma-separated text and split/joined at the form boundary — an explicitly accepted, documented tradeoff (safe for all current data, not bulletproof against future free text containing a literal comma).

**Tech Stack:** Next.js 16 App Router, Supabase Postgres, next-intl, TypeScript, Vitest (live DB tests).

---

## Context for every task

- Working directory: `C:\Users\albar\OneDrive\سطح المكتب\COY21\COY21-App\.worktrees\general-info-editor`, branch `feature/general-info-editor`. `.env.local` present.
- Design spec: `docs/superpowers/specs/2026-10-28-participant-general-info-editor-design.md` — went through 5 review rounds, including 3 successive precision fixes to the array-field write-path analysis. Read it in full before Task 1.
- Supabase project: `vfwcbkjvinbtcntwjrzq` (COY21 production, no dev/staging). **This feature needs NO new migration, NO new table, NO new columns** — every field is already a plain column on `applications`. There is no Task Xa/Xb split in this plan for that reason; all tasks can be dispatched to subagents directly.
- Known pre-existing `tsc --noEmit` baseline: ~419 errors, confined to `tests/attendance/qr-issuance-reservation.test.ts` and `tests/attendance/qr-credentials-lifecycle-trigger.test.ts`. Any task's typecheck must show zero *new* errors outside those two files.
- **The 31 in-scope columns, exactly** (confirmed against the live `applications` schema and 5 review rounds — do not add or remove any column from this list without going back to the spec):
  - Plain text (25): `full_name`, `phone`, `whatsapp_number`, `country`, `nationality`, `city`, `gender`, `birth_date`, `age_group`, `education_level`, `institution_or_workplace`, `field_of_work`, `organization`, `preferred_language`, `linkedin_url`, `primary_track`, `secondary_track`, `topics_to_learn`, `content_type_pref`, `experience_level`, `climate_experience`, `past_initiatives`, `participation_goals`, `priority_sessions`, `special_needs`
  - Array (6, comma-separated in the form): `interests`, `track_interests`, `session_languages`, `track_1_focus_areas`, `track_2_focus_areas`, `track_3_focus_areas`

---

### Task 1: Array split/join helper + unit tests

**Files:**
- Create: `src/lib/participants/general-info-array-field.ts`
- Create: `src/lib/participants/general-info-array-field.test.ts`

Pure function, no live DB needed. This is the one genuinely novel piece of logic in this feature (everything else is a direct mirror of an existing pattern) — isolate it so it's independently testable and reusable between the save path and (if ever needed) the load path.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/participants/general-info-array-field.test.ts
import { describe, it, expect } from 'vitest';
import { arrayFieldToInput, inputToArrayField } from './general-info-array-field';

describe('arrayFieldToInput', () => {
  it('joins a populated array with ", "', () => {
    expect(arrayFieldToInput(['climate policy', 'youth engagement'])).toBe('climate policy, youth engagement');
  });
  it('returns an empty string for null', () => {
    expect(arrayFieldToInput(null)).toBe('');
  });
  it('returns an empty string for an empty array', () => {
    expect(arrayFieldToInput([])).toBe('');
  });
});

describe('inputToArrayField', () => {
  it('splits a comma-separated string, trimming each element', () => {
    expect(inputToArrayField('climate policy, youth engagement ,renewable energy')).toEqual([
      'climate policy', 'youth engagement', 'renewable energy',
    ]);
  });
  it('returns an empty array for an empty/whitespace-only string', () => {
    expect(inputToArrayField('')).toEqual([]);
    expect(inputToArrayField('   ')).toEqual([]);
  });
  it('drops a trailing comma without producing a stray empty-string element', () => {
    expect(inputToArrayField('a, b,')).toEqual(['a', 'b']);
  });
  it('drops a leading comma without producing a stray empty-string element', () => {
    expect(inputToArrayField(',a, b')).toEqual(['a', 'b']);
  });
  it('round-trips through arrayFieldToInput', () => {
    const original = ['one', 'two', 'three'];
    expect(inputToArrayField(arrayFieldToInput(original))).toEqual(original);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/lib/participants/general-info-array-field.test.ts
```
Expected: fails — module doesn't exist yet.

- [ ] **Step 3: Implement**

```typescript
// src/lib/participants/general-info-array-field.ts
//
// Comma-separated-text <-> text[] conversion for the General
// Information editor's 6 array-typed applications columns (design
// spec: docs/superpowers/specs/2026-10-28-participant-general-info-editor-design.md).
//
// Accepted, documented tradeoff (per the spec's "Residual risk"
// section): safe for all current data in these 6 columns (traced every
// write path into them — the CSV import pipeline's splitMultiSelect(),
// and the self-registration autosave's fixed, comma-free checkbox
// option list, both independently guarantee no existing element
// contains a literal comma), but NOT safe in general for a future
// free-text value that happens to contain a human-typed comma within
// one semantic item. Do not "fix" this with a different delimiter or
// escaping scheme -- that would be unrequested scope creep per the
// spec; this is a known, accepted limitation of an infrequent
// correction tool, not a defect.

export function arrayFieldToInput(value: string[] | null): string {
  if (!value || value.length === 0) return '';
  return value.join(', ');
}

export function inputToArrayField(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run src/lib/participants/general-info-array-field.test.ts
```
Expected: all pass.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```
Expected: same ~419-error baseline, zero new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/participants/general-info-array-field.ts src/lib/participants/general-info-array-field.test.ts
git commit -m "feat: add comma-separated array field helper for general info editor"
```

---

### Task 2: `updateGeneralInfoForCaller` + server action

**Files:**
- Modify: `src/app/[locale]/(admin)/participants/[applicationId]/actions.ts` (add new exports; do not touch `updateParticipantTypeAction`/invitation actions already in this file)
- Create: `tests/participants/general-info-update-live.test.ts`

**Depends on nothing else in this plan** (Task 1's helper is used client-side, not by this server action — the action receives already-split `string[]` values, not raw comma-separated text; the UI layer is responsible for the split/join).

- [ ] **Step 1: Read the exact current file first**

Read `src/app/[locale]/(admin)/participants/[applicationId]/actions.ts` in full. Confirm it currently exports `sendInvitationActionForCaller`/`sendInvitationAction`, `resendInvitationActionForCaller`/`resendInvitationAction`, `revokeInvitationActionForCaller`/`revokeInvitationAction`, `updateParticipantTypeActionForCaller`/`updateParticipantTypeAction`, and imports `requireAgendaStaffCaller`/`writeAuditLog` from `@/lib/agenda/server-helpers` — this plan adds to this same file using the same imports, not a new auth pattern.

- [ ] **Step 2: Write the failing live test**

```typescript
// tests/participants/general-info-update-live.test.ts
//
// Direct-call coverage for updateGeneralInfoForCaller, same style as
// tests/participants/guardian-info-update-live.test.ts: a manually
// constructed caller (no auth-gate involved -- requireAgendaStaffCaller
// can't be invoked outside a request context, same reasoning as every
// other *ForCaller test in this codebase).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { updateGeneralInfoForCaller } from '@/app/[locale]/(admin)/participants/[applicationId]/actions';

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
    email: `general-info-${runId}-staff@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (staffError || !staff.user) throw new Error(`staff fixture setup failed: ${staffError?.message}`);
  staffUserId = staff.user.id;
  await admin.from('profiles').update({ role: 'super_admin' }).eq('id', staffUserId);

  const { data: applicant, error: applicantError } = await admin.auth.admin.createUser({
    email: `general-info-${runId}-applicant@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (applicantError || !applicant.user) throw new Error(`applicant fixture setup failed: ${applicantError?.message}`);
  applicantUserId = applicant.user.id;

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: applicantUserId, status: 'accepted', full_name: 'Original Name' })
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

describe('updateGeneralInfoForCaller', () => {
  it('writes a representative subset of plain-text and array fields, round-tripping correctly', async () => {
    const result = await updateGeneralInfoForCaller(
      applicationId,
      {
        full_name: 'Updated Name',
        country: 'Oman',
        organization: 'Test Org',
        interests: ['climate policy', 'youth engagement', 'renewable energy'],
        track_1_focus_areas: ['Policy and Governance'],
      },
      { userId: staffUserId, service: admin }
    );
    expect(result.full_name).toBe('Updated Name');
    expect(result.country).toBe('Oman');
    expect(result.organization).toBe('Test Org');
    expect(result.interests).toEqual(['climate policy', 'youth engagement', 'renewable energy']);
    expect(result.track_1_focus_areas).toEqual(['Policy and Governance']);

    const { data: row } = await admin
      .from('applications')
      .select('full_name, country, organization, interests, track_1_focus_areas')
      .eq('id', applicationId)
      .single();
    expect(row!.full_name).toBe('Updated Name');
    expect(row!.interests).toEqual(['climate policy', 'youth engagement', 'renewable energy']);
  });

  it('writes an audit log entry with action=general_info_updated and old/new values', async () => {
    const { data: before } = await admin
      .from('audit_logs')
      .select('id')
      .eq('entity_id', applicationId)
      .eq('action', 'general_info_updated');
    const beforeCount = before?.length ?? 0;

    await updateGeneralInfoForCaller(
      applicationId,
      { full_name: 'Second Update' },
      { userId: staffUserId, service: admin }
    );

    const { data: after } = await admin
      .from('audit_logs')
      .select('id, old_values, new_values')
      .eq('entity_id', applicationId)
      .eq('action', 'general_info_updated');
    for (const row of after ?? []) auditLogIds.push(row.id);
    expect((after?.length ?? 0)).toBe(beforeCount + 1);
    const latest = after![after!.length - 1];
    expect((latest.new_values as Record<string, unknown>).full_name).toBe('Second Update');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
npx vitest run tests/participants/general-info-update-live.test.ts
```
Expected: fails — `updateGeneralInfoForCaller` is not exported yet.

- [ ] **Step 4: Implement**

Add to `src/app/[locale]/(admin)/participants/[applicationId]/actions.ts`, after the existing `updateParticipantTypeAction`:

```typescript
export type GeneralInfoUpdateInput = Partial<{
  full_name: string | null;
  phone: string | null;
  whatsapp_number: string | null;
  country: string | null;
  nationality: string | null;
  city: string | null;
  gender: string | null;
  birth_date: string | null;
  age_group: string | null;
  education_level: string | null;
  institution_or_workplace: string | null;
  field_of_work: string | null;
  organization: string | null;
  preferred_language: string | null;
  linkedin_url: string | null;
  primary_track: string | null;
  secondary_track: string | null;
  topics_to_learn: string | null;
  content_type_pref: string | null;
  experience_level: string | null;
  climate_experience: string | null;
  past_initiatives: string | null;
  participation_goals: string | null;
  priority_sessions: string | null;
  special_needs: string | null;
  interests: string[] | null;
  track_interests: string[] | null;
  session_languages: string[] | null;
  track_1_focus_areas: string[] | null;
  track_2_focus_areas: string[] | null;
  track_3_focus_areas: string[] | null;
}>;

export type GeneralInfo = GeneralInfoUpdateInput & { id: string };

const GENERAL_INFO_SELECT =
  'id, full_name, phone, whatsapp_number, country, nationality, city, gender, birth_date, age_group, education_level, institution_or_workplace, field_of_work, organization, preferred_language, linkedin_url, primary_track, secondary_track, topics_to_learn, content_type_pref, experience_level, climate_experience, past_initiatives, participation_goals, priority_sessions, special_needs, interests, track_interests, session_languages, track_1_focus_areas, track_2_focus_areas, track_3_focus_areas';

// Plain update, not upsert -- applications always has exactly one row
// per application already, same reasoning as updateGuardianInfoForCaller
// (health-info-management.ts). This action's write surface is EXACTLY
// the 31-column design-spec scope, enforced at the type level by
// GeneralInfoUpdateInput -- it must never be widened to accept
// participant_type/status/guardian_name/etc., which are owned by their
// own dedicated actions.
export async function updateGeneralInfoForCaller(
  applicationId: string,
  input: GeneralInfoUpdateInput,
  caller: { userId: string; service: ServiceClient }
): Promise<GeneralInfo> {
  const { service, userId } = caller;
  const { data: before } = await service.from('applications').select(GENERAL_INFO_SELECT).eq('id', applicationId).maybeSingle();

  const { data, error } = await service
    .from('applications')
    .update(input)
    .eq('id', applicationId)
    .select(GENERAL_INFO_SELECT)
    .single();
  if (error) throw new Error(error.message);

  await writeAuditLog(service, {
    entityType: 'applications',
    entityId: applicationId,
    action: 'general_info_updated',
    actorId: userId,
    oldValues: before,
    newValues: data,
  });

  return data;
}

export async function updateGeneralInfoAction(applicationId: string, input: GeneralInfoUpdateInput) {
  const caller = await requireAgendaStaffCaller();
  return updateGeneralInfoForCaller(applicationId, input, caller);
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
npx vitest run tests/participants/general-info-update-live.test.ts
```
Expected: 2/2 pass.

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```
Expected: same ~419-error baseline, zero new errors.

- [ ] **Step 7: Commit**

```bash
git add "src/app/[locale]/(admin)/participants/[applicationId]/actions.ts" tests/participants/general-info-update-live.test.ts
git commit -m "feat: add updateGeneralInfoForCaller and server action"
```

---

### Task 3: Auth-gate logic-replication test

**Files:**
- Modify: `tests/participants/general-info-update-live.test.ts` (add one more `describe` block)

**Depends on Task 2.**

Same pattern as the guardian-info feature's own Task 6 and the spec's Testing section: `requireAgendaStaffCaller` cannot be invoked directly in a test (reaches `next/headers`'s `cookies()` outside a request context). Mirror the logic-replication approach instead.

- [ ] **Step 1: Read the real current condition first**

Read `requireAgendaStaffCaller` in `src/lib/agenda/server-helpers.ts` and confirm its exact condition (`if (!isStaffRole(profile.role) || profile.role === 'staff') throw ...`, i.e. authorized iff `isStaffRole(profile.role) && profile.role !== 'staff'`) still matches what's described here before writing the test — this is the exact same condition the guardian-info feature's own equivalent test already re-implements, so you may also read `tests/participants/guardian-info-update-live.test.ts`'s own version of this test as a direct precedent to mirror.

- [ ] **Step 2: Write the test**

Add to `tests/participants/general-info-update-live.test.ts`:

```typescript
import { isStaffRole } from '@/lib/auth/is-staff-role';

describe('requireAgendaStaffCaller auth condition (logic replication)', () => {
  it('rejects plain staff', async () => {
    const { data: staffUser, error } = await admin.auth.admin.createUser({
      email: `general-info-auth-${runId}-plain-staff@test.local`,
      password: 'password123',
      email_confirm: true,
    });
    if (error || !staffUser.user) throw new Error(`plain-staff fixture setup failed: ${error?.message}`);
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffUser.user.id);
    const { data: profile } = await admin.from('profiles').select('role').eq('id', staffUser.user.id).single();

    const isAuthorized = isStaffRole(profile!.role) && profile!.role !== 'staff';
    expect(isAuthorized).toBe(false);

    await admin.auth.admin.deleteUser(staffUser.user.id);
  });

  it('accepts super_admin', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', staffUserId).single();
    const isAuthorized = isStaffRole(profile!.role) && profile!.role !== 'staff';
    expect(isAuthorized).toBe(true);
  });
});
```

(`staffUserId` reuses the `super_admin` fixture already created in this file's `beforeAll` from Task 2.)

- [ ] **Step 3: Run**

```bash
npx vitest run tests/participants/general-info-update-live.test.ts
```
Expected: all tests in the file pass (2 from Task 2 + 2 new).

- [ ] **Step 4: Commit**

```bash
git add tests/participants/general-info-update-live.test.ts
git commit -m "test: add logic-replication coverage for general-info auth gate"
```

---

### Task 4: i18n keys

**Files:**
- Modify: `src/messages/en.json`, `src/messages/ar.json`

**Depends on nothing else, can run any time** — purely additive translation keys.

- [ ] **Step 1: Read the exact current `participants.guardian` block first**

Read the real current `participants.guardian` block in both `en.json`/`ar.json` (confirmed location: nested under `participants`, sibling of `detail`/`classification`/`import`) to match its exact indentation/nesting style for the new `generalInfo` block.

- [ ] **Step 2: Add to both files**

Under `participants`, as a new sibling of `guardian`:

```json
"generalInfo": {
  "title": "General Information",
  "save": "Save",
  "saving": "Saving…",
  "genericError": "Action failed",
  "fields": {
    "fullName": "Full name",
    "phone": "Phone",
    "whatsappNumber": "WhatsApp number",
    "country": "Country",
    "nationality": "Nationality",
    "city": "City",
    "gender": "Gender",
    "birthDate": "Date of birth",
    "ageGroup": "Age group",
    "educationLevel": "Education level",
    "institutionOrWorkplace": "Institution or workplace",
    "fieldOfWork": "Field of work",
    "organization": "Organization",
    "preferredLanguage": "Preferred language",
    "linkedinUrl": "LinkedIn URL",
    "primaryTrack": "Primary track",
    "secondaryTrack": "Secondary track",
    "topicsToLearn": "Topics to learn",
    "contentTypePref": "Content type preference",
    "experienceLevel": "Experience level",
    "climateExperience": "Climate experience",
    "pastInitiatives": "Past initiatives",
    "participationGoals": "Participation goals",
    "prioritySessions": "Priority sessions",
    "specialNeeds": "Special needs",
    "interests": "Interests (comma-separated)",
    "trackInterests": "Track interests (comma-separated)",
    "sessionLanguages": "Session languages (comma-separated)",
    "track1FocusAreas": "Track 1 focus areas (comma-separated)",
    "track2FocusAreas": "Track 2 focus areas (comma-separated)",
    "track3FocusAreas": "Track 3 focus areas (comma-separated)"
  }
}
```

Arabic (`ar.json`), same structure, real translated copy:

```json
"generalInfo": {
  "title": "المعلومات العامة",
  "save": "حفظ",
  "saving": "جارٍ الحفظ...",
  "genericError": "فشل الإجراء",
  "fields": {
    "fullName": "الاسم الكامل",
    "phone": "الهاتف",
    "whatsappNumber": "رقم الواتساب",
    "country": "الدولة",
    "nationality": "الجنسية",
    "city": "المدينة",
    "gender": "الجنس",
    "birthDate": "تاريخ الميلاد",
    "ageGroup": "الفئة العمرية",
    "educationLevel": "المستوى التعليمي",
    "institutionOrWorkplace": "المؤسسة أو جهة العمل",
    "fieldOfWork": "مجال العمل",
    "organization": "الجهة",
    "preferredLanguage": "اللغة المفضلة",
    "linkedinUrl": "رابط لينكدإن",
    "primaryTrack": "المسار الأساسي",
    "secondaryTrack": "المسار الثانوي",
    "topicsToLearn": "مواضيع الاهتمام للتعلم",
    "contentTypePref": "نوع المحتوى المفضل",
    "experienceLevel": "مستوى الخبرة",
    "climateExperience": "الخبرة المناخية",
    "pastInitiatives": "المبادرات السابقة",
    "participationGoals": "أهداف المشاركة",
    "prioritySessions": "الجلسات ذات الأولوية",
    "specialNeeds": "احتياجات خاصة",
    "interests": "الاهتمامات (مفصولة بفاصلة)",
    "trackInterests": "اهتمامات المسار (مفصولة بفاصلة)",
    "sessionLanguages": "لغات الجلسات (مفصولة بفاصلة)",
    "track1FocusAreas": "محاور المسار 1 (مفصولة بفاصلة)",
    "track2FocusAreas": "محاور المسار 2 (مفصولة بفاصلة)",
    "track3FocusAreas": "محاور المسار 3 (مفصولة بفاصلة)"
  }
}
```

- [ ] **Step 3: Validate both files parse as JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('src/messages/en.json', 'utf8')); console.log('en.json OK')"
node -e "JSON.parse(require('fs').readFileSync('src/messages/ar.json', 'utf8')); console.log('ar.json OK')"
```

- [ ] **Step 4: Commit**

```bash
git add src/messages/en.json src/messages/ar.json
git commit -m "feat: add i18n keys for general information editor"
```

---

### Task 5: `GeneralInfoControls` component + page wiring

**Files:**
- Create: `src/app/[locale]/(admin)/participants/[applicationId]/general-info-controls.tsx`
- Modify: `src/app/[locale]/(admin)/participants/[applicationId]/page.tsx`

**Depends on Task 1** (array helper), **Task 2** (server action), **Task 4** (i18n keys).

- [ ] **Step 1: Read the exact current files first**

Read `src/app/[locale]/(admin)/participants/[applicationId]/guardian-controls.tsx` in full (the component shape to scale up from 2 fields to 31) and `src/app/[locale]/(admin)/participants/[applicationId]/page.tsx` in full (confirm the exact current `.select(...)` string, confirm `canSeeSensitive` still exists at the claimed location, confirm where `GuardianControls` is rendered so the new section can be placed near it).

- [ ] **Step 2: Write `GeneralInfoControls`**

```typescript
// src/app/[locale]/(admin)/participants/[applicationId]/general-info-controls.tsx
//
// Mirrors guardian-controls.tsx's shape (local form state, single
// busy/error, one Save button calling one server action), scaled to
// the design spec's 31-column scope. Array fields are edited as
// comma-separated text via general-info-array-field.ts's helpers.
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { updateGeneralInfoAction, type GeneralInfoUpdateInput } from './actions';
import { arrayFieldToInput, inputToArrayField } from '@/lib/participants/general-info-array-field';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type GeneralInfoValues = {
  full_name: string | null;
  phone: string | null;
  whatsapp_number: string | null;
  country: string | null;
  nationality: string | null;
  city: string | null;
  gender: string | null;
  birth_date: string | null;
  age_group: string | null;
  education_level: string | null;
  institution_or_workplace: string | null;
  field_of_work: string | null;
  organization: string | null;
  preferred_language: string | null;
  linkedin_url: string | null;
  primary_track: string | null;
  secondary_track: string | null;
  topics_to_learn: string | null;
  content_type_pref: string | null;
  experience_level: string | null;
  climate_experience: string | null;
  past_initiatives: string | null;
  participation_goals: string | null;
  priority_sessions: string | null;
  special_needs: string | null;
  interests: string[] | null;
  track_interests: string[] | null;
  session_languages: string[] | null;
  track_1_focus_areas: string[] | null;
  track_2_focus_areas: string[] | null;
  track_3_focus_areas: string[] | null;
};

const TEXT_FIELD_KEYS = [
  'full_name', 'phone', 'whatsapp_number', 'country', 'nationality', 'city', 'gender',
  'birth_date', 'age_group', 'education_level', 'institution_or_workplace', 'field_of_work',
  'organization', 'preferred_language', 'linkedin_url', 'primary_track', 'secondary_track',
  'topics_to_learn', 'content_type_pref', 'experience_level', 'climate_experience',
  'past_initiatives', 'participation_goals', 'priority_sessions', 'special_needs',
] as const;

const ARRAY_FIELD_KEYS = [
  'interests', 'track_interests', 'session_languages',
  'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas',
] as const;

// camelCase i18n key per snake_case field key, e.g. full_name -> fullName.
function i18nKeyFor(fieldKey: string): string {
  return fieldKey.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export default function GeneralInfoControls({
  applicationId,
  initialValues,
}: {
  applicationId: string;
  initialValues: GeneralInfoValues;
}) {
  const t = useTranslations('participants.generalInfo');
  const [textValues, setTextValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(TEXT_FIELD_KEYS.map((k) => [k, initialValues[k] ?? '']))
  );
  const [arrayInputs, setArrayInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(ARRAY_FIELD_KEYS.map((k) => [k, arrayFieldToInput(initialValues[k])]))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      const input: GeneralInfoUpdateInput = {};
      for (const key of TEXT_FIELD_KEYS) {
        const trimmed = textValues[key].trim();
        (input as Record<string, string | null>)[key] = trimmed === '' ? null : trimmed;
      }
      for (const key of ARRAY_FIELD_KEYS) {
        const arr = inputToArrayField(arrayInputs[key]);
        (input as Record<string, string[] | null>)[key] = arr.length === 0 ? null : arr;
      }
      await updateGeneralInfoAction(applicationId, input);
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
          {TEXT_FIELD_KEYS.map((key) => (
            <div key={key} className="flex flex-col gap-1">
              <label className="text-xs font-medium text-charcoal/70 dark:text-gray-400">{t(`fields.${i18nKeyFor(key)}`)}</label>
              <input
                className="rounded-md border border-charcoal/20 bg-transparent px-2 py-1.5 text-sm text-charcoal dark:border-gray-700 dark:text-gray-100"
                value={textValues[key]}
                disabled={busy}
                onChange={(e) => setTextValues((prev) => ({ ...prev, [key]: e.target.value }))}
              />
            </div>
          ))}
          {ARRAY_FIELD_KEYS.map((key) => (
            <div key={key} className="flex flex-col gap-1">
              <label className="text-xs font-medium text-charcoal/70 dark:text-gray-400">{t(`fields.${i18nKeyFor(key)}`)}</label>
              <input
                className="rounded-md border border-charcoal/20 bg-transparent px-2 py-1.5 text-sm text-charcoal dark:border-gray-700 dark:text-gray-100"
                value={arrayInputs[key]}
                disabled={busy}
                onChange={(e) => setArrayInputs((prev) => ({ ...prev, [key]: e.target.value }))}
              />
            </div>
          ))}
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

**Note on the `i18nKeyFor` helper:** this derives the i18n key from the field name programmatically (`full_name` → `fullName`) rather than a hand-written lookup table, so there's no risk of a typo'd mapping silently breaking one field's label. If the real `track_1_focus_areas` → `track1FocusAreas` mapping doesn't come out right from the naive regex (the digit placement is the one irregular case — `track_1_focus_areas` has an underscore-digit-underscore pattern), verify this specific case by running the component (or a quick one-off test) before trusting it; adjust `i18nKeyFor` or fall back to an explicit lookup object if the regex doesn't handle it correctly.

- [ ] **Step 3: Widen the page's `applications` select and render the new section**

In `page.tsx`, add these 12 columns to the existing `.select(...)` string (alongside what's already selected): `full_name, whatsapp_number, gender, education_level, institution_or_workplace, linkedin_url, primary_track, secondary_track, session_languages, track_1_focus_areas, track_2_focus_areas, track_3_focus_areas`.

Import and render, gated on `canSeeSensitive` (not rendered at all for non-`super_admin` staff), positioned near `ClassificationControls`/`GuardianControls`:

```tsx
import GeneralInfoControls from './general-info-controls';
```

```tsx
{canSeeSensitive && (
  <GeneralInfoControls
    applicationId={applicationId}
    initialValues={{
      full_name: application.full_name,
      phone: application.phone,
      whatsapp_number: application.whatsapp_number,
      country: application.country,
      nationality: application.nationality,
      city: application.city,
      gender: application.gender,
      birth_date: application.birth_date,
      age_group: application.age_group,
      education_level: application.education_level,
      institution_or_workplace: application.institution_or_workplace,
      field_of_work: application.field_of_work,
      organization: application.organization,
      preferred_language: application.preferred_language,
      linkedin_url: application.linkedin_url,
      primary_track: application.primary_track,
      secondary_track: application.secondary_track,
      topics_to_learn: application.topics_to_learn,
      content_type_pref: application.content_type_pref,
      experience_level: application.experience_level,
      climate_experience: application.climate_experience,
      past_initiatives: application.past_initiatives,
      participation_goals: application.participation_goals,
      priority_sessions: application.priority_sessions,
      special_needs: application.special_needs,
      interests: application.interests,
      track_interests: application.track_interests,
      session_languages: application.session_languages,
      track_1_focus_areas: application.track_1_focus_areas,
      track_2_focus_areas: application.track_2_focus_areas,
      track_3_focus_areas: application.track_3_focus_areas,
    }}
  />
)}
```

Place this block near (e.g. immediately after) the existing `<ClassificationControls .../>` and `{isApplicationMinor(application) && <GuardianControls .../>}` block, inside the page's existing top-level return `<div>`.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```
Expected: same ~419-error baseline, zero new errors.

- [ ] **Step 5: Manual verification note**

No automated test for this UI component (matching this session's established pattern for form-heavy UI pieces already proven correct by the underlying server action's live tests). Note in the task report that manual verification (non-`super_admin` staff cannot see the section at all; `super_admin` can edit a full round of plain-text and array fields and see them persist on reload; saving does not affect any other section's data) is deferred to the final combined manual pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/[locale]/(admin)/participants/[applicationId]/general-info-controls.tsx "src/app/[locale]/(admin)/participants/[applicationId]/page.tsx"
git commit -m "feat: add GeneralInfoControls to admin participant detail page"
```

---

### Task 6: Final review and merge

Not a subagent task — handled by the controller directly after Tasks 1-5 are all individually spec/quality-reviewed and approved.

- [ ] Dispatch a final whole-branch code-reviewer subagent for the entire `feature/general-info-editor` diff against `master`: confirm the server action's write surface is exactly the 31-column scope (no accidental inclusion of `participant_type`/`status`/`guardian_name`/etc.), confirm the array-field split/join round-trips correctly end-to-end (not just in Task 1's isolated unit tests), confirm `canSeeSensitive` gating genuinely hides the section from non-`super_admin` staff, confirm the page's widened select doesn't break anything else on the page that reads `application.*`, full test suite run, typecheck/lint.
- [ ] Coordinate one combined manual browser verification pass with the human: as `super_admin`, open an application's detail page, confirm the General Information section renders with all 31 fields pre-populated from existing data, edit a mix of plain-text and array fields, save, confirm the page reloads with the new values persisted; as a non-`super_admin` staff account (if one exists for testing), confirm the section does not render at all; confirm editing General Information doesn't disturb Classification/Guardian/other sections' own data.
- [ ] Use `superpowers:finishing-a-development-branch` to decide merge/PR approach once verification passes.
