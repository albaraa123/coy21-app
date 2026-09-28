# Participant Portal UX Simplification — Design Spec

**Scope:** COY21-App, participant-facing portal only (`(participant)/(shell)` and `(participant)/(bare)/register`). Admin dashboard and scanner app are explicitly out of scope for this spec — separate future specs.
**Status:** Approved by user section-by-section, pending spec review

## Goal

Reduce the friction, cognitive load, and step-count participants experience in the portal — identified pain points: confusing/overloaded registration form, unclear distinction between personal and full conference schedules, and a flat 9-item navigation menu with no hierarchy. The fix is not a redesign of any single page in isolation; it's a restructuring of navigation, the landing experience, naming, and the registration flow as one coherent change.

## Current state (baseline, confirmed by reading the live code)

- **Navigation** (`src/lib/nav/participant-nav-config.ts`): 9 flat, unordered items — dashboard, my-agenda, schedule, my-application, my-qr, my-travel, venue-map, local-info, my-profile. No grouping, no priority.
- **Landing page** (`my-dashboard`): not yet inspected in detail during brainstorming; current nav treats it as one of 9 equal items rather than a status-aware home screen.
- **"my-agenda" vs "schedule"**: two separate routes with near-synonymous English names (agenda vs. schedule) and no in-product explanation of the difference. Root cause confirmed to be naming, not architecture — both routes stay separate.
- **Registration form** (`(bare)/register/registration-form.tsx` + `src/lib/validation/registration.ts`): 19 total fields across 2 steps, no progress indicator, no visual distinction between required and optional fields.
  - Required (9): `phone`, `country`, `nationality`, `city`, `field_of_work`, `preferred_language`, `experience_level`, `interests` (≥1), `participation_goals`, plus one of `birth_date`/`age_group`.
  - Optional (10): `organization`, `climate_experience`, `past_initiatives`, `topics_to_learn`, `content_type_pref`, `track_interests`, `priority_sessions`, `special_needs`, and whichever of `birth_date`/`age_group` wasn't used to satisfy the required pair.
  - `/sign-up` (a separate, dormant self-registration page behind `ENABLE_SELF_REGISTRATION`) is unrelated to this form and out of scope — this spec only touches `/register`.

## Design

### 1. Navigation: bottom tab bar (4 items) + "More"

Replace the current flat 9-item sidebar/drawer navigation with a persistent bottom tab bar showing 4 items:

1. **Home** (🏠) — the status-aware landing screen (see §2)
2. **My Program** (📅) — participant's own scheduled sessions (renamed from "my-agenda")
3. **My QR** (🎫) — entry code (unchanged route, `my-qr`)
4. **More** (⋯) — reveals the remaining 6 items: Conference Program (renamed from "schedule"), My Application, My Travel, Venue Map, Local Info, My Profile

This is a structural nav change, not just a visual restyle. Today, `participantNavItems` is a flat `NavItem[]` (`participant-nav-config.ts:3-13`); `(shell)/layout.tsx:46-50` wraps it into a single `NavGroup` with `labelKey: ''` as a documented "flat list, no group UI" signal consumed by `SidebarNav`. This spec's `primary`/`more` split is **new structure added to `NavItem`** (e.g. a `placement: 'primary' | 'more'` field), not a repurposing of the existing empty-`labelKey` convention — that convention stays as-is for how the resulting groups render, it just now receives two logical partitions of the same flat list instead of one. The implementation plan must decide the exact type shape; this spec fixes only the partition (4 primary, 5 more) and that it is additive to `NavItem`, not a replacement of `NavGroup`.

The existing mobile drawer and desktop sidebar components are reused for the "More" panel's rendering *logic* (focus trap, RTL, locale-switch-close, `SidebarNav` list rendering) — but not verified as a drop-in presentation fit. `mobile-drawer.tsx` currently assumes it is the entire nav surface, triggered from a hamburger icon, opened as a full-height drawer (`mobile-drawer.tsx:144-157`). A "More" panel triggered from a bottom tab bar item is a different trigger context and likely a different panel position (bottom-anchored, not full drawer) and z-index/layering relative to the new tab bar. The implementation plan must treat the *behavioral* logic (trap, RTL, close-on-nav) as reused, and the *presentation* (trigger point, panel geometry) as an open question to resolve, not a given.

**Rationale:** matches the mobile-app pattern participants already know from other apps, cuts the always-visible item count from 9 to 4, and doesn't hide anything permanently — everything remains one tap away under "More".

**Accessibility requirements for the new tab bar** (genuinely new UI, not inherited from the reused drawer): the active tab must expose `aria-current="page"`; each of the 4 tabs (icon-only or icon+label, a plan-phase call) needs an accessible name via `aria-label` or visible text, not icon alone; touch targets must meet a minimum size (44×44px, matching existing platform conventions); keyboard/focus order must reach all 4 tabs plus the "More" trigger in a sane sequence; and RTL layout must mirror tab order (not just the "More" panel's contents, which inherits RTL from the reused drawer) — including any directional icons among the 4 tabs.

### 2. Home screen: status-aware cards, not a static list

`my-dashboard` becomes a card-based landing screen where card order/prominence adapts to the participant's `applications.status` and related state, rather than a fixed layout:

| Participant state | Card priority (top → bottom) |
|---|---|
| Not yet accepted (`submitted`/`under_review`/`waitlisted`) | 1. Application status (large) 2. My Program (dim/disabled) |
| Accepted, travel not yet submitted | 1. "Complete your travel info" (large, actionable) 2. My QR (present but secondary) 3. My Program |
| Accepted, travel complete, event imminent | 1. My QR (large) 2. Today's Program (secondary) |

The exact imminence threshold ("event imminent") and the full card catalogue (beyond QR/Program/Application-status/Travel) are implementation details for the plan phase, not fixed here — this spec establishes the *adaptive* principle and the three representative states above, not an exhaustive state machine.

**Rationale:** confirmed with user — a QR card shown with equal visual weight before it's usable, or an application-status card lingering after acceptance, is exactly the kind of clutter driving the "confusing" feedback. The dashboard should surface what's actionable *now*.

### 3. Naming: "My Program" / "Conference Program"

- `my-agenda` → labelled **"My Program"** (برنامجي) — the participant's personal, assigned sessions.
- `schedule` → labelled **"Conference Program"** (برنامج المؤتمر) — the full session catalogue.

Routes/URLs are unchanged (`/my-agenda`, `/schedule`) — this is a label-only change in `nav-config`/translation files, confirmed by the user as sufficient (the confusion was the *name*, not the existence of two separate screens).

### 4. Registration form: 3 steps instead of 2, required/optional split honored in the UI

Restructure `registration-form.tsx`'s two fixed field-groups into three:

1. **Step 1 — Basic Info** (7 required fields): phone, country, nationality, city, field_of_work, preferred_language, plus birth_date-or-age_group.
2. **Step 2 — About Your Climate Journey** (3 required fields): interests, experience_level, participation_goals.
3. **Step 3 — Additional Details (optional)**: the remaining 8 fields (organization, climate_experience, past_initiatives, topics_to_learn, content_type_pref, track_interests, priority_sessions, special_needs), with a prominent **"Skip"** button that submits immediately without requiring any Step 3 field to be filled.

Add a step progress indicator ("Step 1 of 3" / "Step 2 of 3" / "Step 3 of 3") — absent today. `STEP_1_FIELDS`/`STEP_2_FIELDS` constants split into three; `autosaveStep` behavior (per-step field-scoped autosave on blur) is preserved unchanged for all three steps. `submitApplication` is called from Step 3 (whether skipped or filled), matching today's Step 2 submit point.

The Zod schema (`personalInfoSchema`/`conferenceInfoSchema`) is **not** changed — required/optional status of each field stays exactly as validated today. This is a UI/flow restructuring, not a change to what data is mandatory to submit an application.

**Rationale:** confirmed with user — shorter, clearly-labeled steps with an explicit progress indicator, keeping the actually-optional fields visually and procedurally separate (skippable) from the required ones, rather than presenting all 19 fields as equally mandatory-feeling.

## Out of scope for this spec

- Visual/spacing polish of individual form inputs (mentioned by user as a concern but deferred — this spec's changes are structural: step count, field grouping, nav shape, card logic).
- Admin dashboard navigation/layout.
- Scanner app UX.
- `/sign-up` (dormant self-registration page).
- The exact card catalogue/state machine for the home screen beyond the three representative states in §2 — left for the implementation plan to enumerate exhaustively against the full set of `applications` status values and related tables (travel, QR eligibility).
- i18n string finalization (Arabic/English copy for new nav labels, step titles, card copy) — placeholder English/Arabic labels given here; final copy review happens during implementation.

## Field → schema → step mapping (for §4)

| Field | Schema | Required? | Step |
|---|---|---|---|
| phone | `personalInfoSchema` | required | 1 |
| country | `personalInfoSchema` | required | 1 |
| nationality | `personalInfoSchema` | required | 1 |
| city | `personalInfoSchema` | required | 1 |
| field_of_work | `personalInfoSchema` | required | 1 |
| preferred_language | `personalInfoSchema` | required | 1 |
| birth_date | `personalInfoSchema` | required (either this or age_group, via `.refine`) | 1 |
| age_group | `personalInfoSchema` | required (either this or birth_date, via `.refine`) | 1 |
| organization | `personalInfoSchema` | optional | 3 |
| interests | `conferenceInfoSchema` | required (≥1) | 2 |
| experience_level | `conferenceInfoSchema` | required | 2 |
| participation_goals | `conferenceInfoSchema` | required | 2 |
| climate_experience | `conferenceInfoSchema` | optional | 3 |
| past_initiatives | `conferenceInfoSchema` | optional | 3 |
| topics_to_learn | `conferenceInfoSchema` | optional | 3 |
| content_type_pref | `conferenceInfoSchema` | optional | 3 |
| track_interests | `conferenceInfoSchema` | optional | 3 |
| priority_sessions | `conferenceInfoSchema` | optional | 3 |
| special_needs | `conferenceInfoSchema` | optional | 3 |

Both schemas are unchanged by this spec (§4) — this table only re-maps existing fields to the new 3-step UI structure.

## Testing considerations (for the implementation plan to expand)

- Nav (reused drawer logic): existing focus-trap/RTL/locale-switch-close behavior in `mobile-drawer.tsx` must be preserved for the "More" panel.
- Nav (new tab bar UI): `aria-current` on the active tab; keyboard focus order across all 4 tabs + "More" trigger; RTL mirroring of tab order and any directional icons; touch target size.
- Registration: existing autosave-per-step behavior and the `birth_date`-or-`age_group` cross-field validation must keep working across the new 3-step split; the "Skip" action on Step 3 must not bypass Step 1/2 validation (a participant cannot reach Step 3 without Steps 1–2 already valid, same as today's Step 2 gate).
- Home screen: each of the three representative states in §2 needs at least one live/integration test asserting card order.
