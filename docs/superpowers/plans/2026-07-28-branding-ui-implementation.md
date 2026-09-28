# Phase 5.5: RCOY MENA 2026 Branding, UI Design, and Public Website — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the official RCOY MENA 2026 brand (colors, Thmanyah Serif Text font, logos) across a new unified design system; build a real public website; restyle every existing admin/participant page in place; add role-aware dashboards, a shared shell/navigation architecture, and reusable global-state components — all without changing any existing business logic, database behavior, RLS, authentication, or Excel-import/rollback/allocation/publication rules.

**Architecture:** Server Components own authorization, role resolution, navigation-config selection, and all data queries. A small, explicit set of Client Components (`SidebarNav`, `MobileDrawer`, `LanguageSwitcher`, `UserMenu`, interactive parts of `AppShell`) owns only interaction state (active-route highlighting, drawer open/close, persisted group-expansion). Navigation configs are plain serializable data (`iconKey: string`, not component references) selected server-side and passed as props. Existing UI primitives (`Card`, `Badge`, `EmptyState`, `Skeleton` in `src/components/ui/`) are extended in place, not replaced — no shadcn/ui exists in this project (verified: no `components.json`) and none will be installed this phase. No `Button` component exists yet (new addition). No logout implementation exists yet (verified: zero `auth.signOut` call sites) — built as a real server action this phase, per the approved requirements below.

**Tech Stack:** Next.js 16 (App Router, Server/Client Components), Tailwind CSS v4 (`@theme` tokens, no config file), `next-intl` v4 (existing `routing.ts` — `Link`/`redirect`/`usePathname`/`useRouter` from `createNavigation`), `next/font/local`, Supabase (auth + Postgres, unchanged), Vitest.

---

## Section 0: Verified facts this plan relies on (do not re-derive, do not contradict)

- Real role enum (`user_role`, `20260721200747_roles_and_profiles.sql`): `participant`, `super_admin`, `registration_admission_manager`, `agenda_allocation_manager`, `communications_attendance_manager`. Staff-gated pages use `isAgendaStaffRole()` from `src/lib/validation/agenda.ts`.
- Route groups do not affect URLs. Confirmed collision risk: a `(public)/page.tsx` and the existing `src/app/[locale]/page.tsx` both resolve to `/[locale]` — the old file is deleted in the same task that adds the new one (Task 8), never left coexisting.
- Existing participant routes (verified, unchanged by this plan): `(participant)/claim`, `(participant)/my-application`, `(participant)/register`, `(participant)/schedule`.
- Existing admin routes (verified via `find`, full list): `/agenda`, `/agenda/days`, `/agenda/people`, `/agenda/rooms`, `/agenda/session-types`, `/agenda/sessions`, `/agenda/sessions/[id]`, `/agenda/tags`, `/agenda/tracks`, `/allocation`, `/allocation/clustering`, `/allocation/extraction`, `/allocation/runs`, `/allocation/runs/[id]`, `/allocation/runs/[id]/capacity`, `/allocation/schedules`, `/allocation/schedules/changed`, `/allocation/schedules/participants/[applicationId]`, `/allocation/schedules/stage/[allocationRunId]`, `/allocation/schedules/stage/draft/[draftId]`, `/applications`, `/applications/[id]`, `/participants`, `/participants/[applicationId]`, `/participants/import`, `/participants/import/[batchId]/{confirm,map,preview,rollback}`, `/participants/imports`, `/participants/imports/[batchId]`.
- `schedule_publications.status`: `active` | `superseded`. `schedule_publication_items.item_status`: `active` | `stale` | `changed` | `cancelled` | `pending_review`. `schedule_publication_drafts.status`: `staged` | `confirmed` | `expired` | `discarded`.
- `participant_invitations.status` (verified, `20260726104000_participant_invitations_table.sql`): `not_sent` | `sending` | `sent` | `accepted` | `expired` | `revoked` | `failed`. "Sent but not yet claimed" = `status = 'sent'` exactly (no extra `accepted_at IS NULL` check needed — `accepted` is its own distinct terminal status).
- **Claim-state mechanism (verified in full, `claim/actions.ts` + `20260726110000_claim_application_function.sql`):** `applications.applicant_id` is nullable — `null` = unclaimed, set = claimed by that user. But claimability itself is NOT tested by querying `applicant_id` directly. The established, ONLY-correct check is `findMyClaimableApplication()`: it queries `participant_invitations` for `invited_user_id = <caller's own auth.uid()> AND status = 'sent'`, returning `{applicationId}` if claimable or `{}` (deliberately undifferentiated) otherwise. The RPC (`claim_imported_application_transactional`) and this function are explicitly designed to NEVER let a caller distinguish "already claimed" from "claimed by someone else" from "no invitation at all" — this is a deliberate anti-leak design, not an oversight. Any new claim-state query (Task 10) MUST call `findMyClaimableApplication()` rather than re-deriving an equivalent check against `applicant_id` or `participant_invitations` directly, both to avoid duplicating security-sensitive logic and to preserve this non-leaking behavior.
- Existing `src/components/ui/`: `card.tsx` (plain div wrapper), `badge.tsx` (6 fixed variants: mandatory/elective/cancelled/changed/pending/neutral), `empty-state.tsx` (title/description only, no action prop yet), `skeleton.tsx` (single className prop). Used only by `src/components/schedule/{day-timeline,session-card}.tsx`.
- `src/i18n/routing.ts` exports `{ Link, redirect, usePathname, useRouter }` from `next-intl`'s `createNavigation(routing)` — locales `['ar', 'en']`, default `ar`. This is the ONLY locale-routing mechanism to use; never hand-build a locale prefix.
- `src/messages/{en,ar}.json` currently has 5 top-level namespaces (`landing`, `auth`, `registration`, `status`, `schedule`), 38 lines each. This phase adds namespaces to the same two files — never creates new message file locations.
- Font files present (verified, `.otf` only): `thmanyahserifdisplay-{Light,Regular,Medium,Bold,Black}.otf`, already copied to `src/fonts/thmanyah-serif-{light,regular,medium,bold,black}.otf`. CSS family name to use: `"Thmanyah Serif Text"` (per explicit approval, despite the source file names saying "Display").
- Brand assets already copied to `public/brand/{logo,icon}/` (horizontal/stacked/square × color/white/black, SVG primary + PNG fallback, icon-only SVG/PNG). Originals in `RCOY BRAND FILES/` untouched.
- No browser/screenshot tool is available in this environment. Visual review happens by the user opening localhost themselves.
- No shadcn/ui, no icon library dependency confirmed yet (check `package.json` in Task 4 before choosing an icon approach), no logout implementation, no `Button` component. All genuinely new additions, not "existing things to preserve."

---

## Section 1: Design tokens (colors, exact hex, approved)

| Token | Hex |
|---|---|
| `--color-turquoise` | `#5FC0B6` |
| `--color-green` | `#8BC05F` |
| `--color-gold` | `#D9A93A` |
| `--color-charcoal` | `#232A31` |
| `--color-warm-white` | `#F4EDE0` |

Font weight usage rule (approved): Black — major display headings only. Bold — section headings. Regular/Medium — body text, forms, tables, navigation, dense admin UI. Light — only where contrast/readability remain sufficient.

---

## Section 2: Resolved decisions (binding for implementation, do not re-litigate)

1. **Unauthorized admin access**: unauthenticated → redirect to localized `/log-in`. Authenticated-but-wrong-role → render `UnauthorizedState` (not `notFound()`). `UnauthorizedState` must not reveal the page's purpose, data, or required role — generic "you don't have access to this area" copy plus a role-appropriate link to the user's own permitted dashboard.
2. **Claim/register screens**: simple centered-card layout (like `(auth)`), NOT the full participant `AppShell`, until claim succeeds. On successful claim: redirect to `/my-dashboard`, full shell, "account linked" state, invitation-oriented language stops appearing anywhere in the participant's own UI from that point forward.
3. **Public Agenda**: during Task 9 implementation, first verify whether a public-safe query can be built that strictly excludes drafts/participant-specific assignments/private allocation data/unpublished revisions. If such a query cannot be cleanly built with confidence, use `EmptyState` ("The conference agenda will be published soon.") — no invented sessions/times/rooms/speakers under any circumstance.
4. **Logout**: real server action, Supabase `auth.signOut()` called server-side, invoked via a form/server action (not client-only session manipulation), redirects to the correct localized `/log-in`, includes loading and failure handling in the UI, has real tests.
5. **UI primitives**: extend the existing hand-built ones; no shadcn/ui or other UI framework installed this phase.

---

## Task 1: Font loading, color tokens, and base layout plumbing

**Objective:** Load the official Thmanyah Serif Text font family (all 5 weights) and the 5 brand color tokens into the app's global styling layer, replacing the placeholder Google-font/generic-color setup, with zero visible page redesign yet (this task is infrastructure only — Task 8 is the first real visual milestone).

**Files:**
- Create: `src/lib/fonts.ts`
- Modify: `src/app/globals.css`
- Modify: `src/app/[locale]/layout.tsx`
- Create: `src/app/icon.png` (favicon convention — confirm exact Next 16 filename/location against `node_modules/next/dist/docs` before assuming)

**Existing behavior that must be preserved:** the `hasLocale`/`notFound()` locale-guard logic; the RTL/LTR `dir` attribute switching based on locale; the existing `NextIntlClientProvider` wrapping; the `min-h-full flex flex-col` body layout shape (other pages may depend on this flex context).

**Implementation steps:**
- [ ] **Step 1:** Write `src/lib/fonts.ts` using `next/font/local`, `src` as an array of `{path, weight, style}` for all 5 weights, `variable: '--font-thmanyah'`. Verify the exact API shape against `node_modules/next/dist/docs/01-app/01-getting-started/13-fonts.md` (already confirmed this session — array-of-files with per-file weight/style is correct for Next 16) before writing.
- [ ] **Step 2:** Update `src/app/globals.css`: add the 5 color tokens under `@theme` as static values (not `@theme inline`, which is for re-exporting a `:root` custom property like the current `--font-geist-sans` pattern — these are fixed brand hex values, not derived). Add `--font-thmanyah` mapped from the font module's CSS variable under `@theme inline` (this one IS re-exporting a JS-generated CSS variable, so `inline` is correct here). Set `body`'s font-family to the new font as the single family used app-wide.
- [ ] **Step 3:** Update `src/app/[locale]/layout.tsx`: replace `Geist`/`Geist_Mono` imports with the Task 1 Step 1 font. Keep all existing locale/RTL/provider logic unchanged. Update `metadata` title/description to real, non-placeholder values (this is real product metadata, not fake conference content, so no empty-state treatment needed here).
- [ ] **Step 4:** Add `src/app/icon.png` from `public/brand/icon/icon-color.png`, following whatever the verified Next 16 App Router icon convention actually is.
- [ ] **Step 5:** `npx tsc --noEmit`, `npm run lint` — must be clean.
- [ ] **Step 6:** Start `npm run dev`, confirm the server boots with zero errors and zero warnings about missing font files or invalid CSS. This is an internal build-health check only — no visual review yet, since no page content has changed.

**Authorization and privacy considerations:** none — this task touches no data access, no auth logic.

**Test requirements:** none new (no new logic, only asset/config wiring) — `tsc`/`lint`/dev-server-boot are the verification for this task.

**Acceptance criteria:** dev server boots cleanly; `tsc`/`lint` clean; the font and color CSS variables are present and correctly resolvable (spot-checkable via browser devtools computed styles once the server is running, though full visual confirmation waits for Task 8).

**Dependencies:** none (first task).

**Rollback considerations:** fully reversible by reverting the 3 modified files and deleting the 2 new ones; touches no persisted state, no migrations, no data.

---

## Task 2: Shared UI primitives — extend existing, add missing

**Objective:** Restyle the 4 existing hand-built primitives to the new brand tokens without breaking their current call sites, and add the one genuinely missing primitive (`Button`).

**Files:**
- Modify: `src/components/ui/card.tsx`
- Modify: `src/components/ui/badge.tsx`
- Modify: `src/components/ui/empty-state.tsx`
- Modify: `src/components/ui/skeleton.tsx`
- Create: `src/components/ui/button.tsx`
- Create: test files (see below)

**Existing behavior that must be preserved:** `Card`'s `{children, className}` prop shape; `Badge`'s exact `BadgeVariant` union (`mandatory | elective | cancelled | changed | pending | neutral`) and prop shape; `EmptyState`'s current required `title`/optional `description` behavior (extended, not replaced); `Skeleton`'s `className` prop; both current call sites in `src/components/schedule/{day-timeline,session-card}.tsx` must render without any prop-shape changes required on their end.

**Implementation steps:**
- [ ] **Step 1:** Restyle `Card`'s Tailwind classes to warm-white/charcoal, 1px border, minimal shadow — keep API identical.
- [ ] **Step 2:** Restyle `Badge`'s 6 `VARIANT_CLASSES` entries to the new palette (map each existing semantic meaning to an appropriate token — e.g. `cancelled` stays muted+strikethrough, `changed`/`pending` get a turquoise-or-gold treatment per genuine semantic fit, decided during implementation) — keep the type and prop shape identical.
- [ ] **Step 3:** Extend `EmptyState` in place (this becomes the final, only `EmptyState` in the codebase — no second component created elsewhere) to accept optional `action?: { label: string; href?: string; onClick?: () => void }` and optional `icon?: ReactNode`, alongside the existing `title`/`description`.
- [ ] **Step 4:** Extend `Skeleton` only if a table-shaped variant genuinely can't be composed from the existing generic primitive by `LoadingState` (Task 3) — prefer keeping `Skeleton` itself unchanged and doing composition in `LoadingState`.
- [ ] **Step 5:** Create `Button` — variants `primary` (turquoise fill) / `secondary` (charcoal outline) / `ghost` (text-only); sizes `sm`/`md`/`lg`; accepts an optional `href` prop to render as `next-intl`'s `Link` instead of `<button>` when navigation (not action) is the intent; visible focus ring using turquoise.
- [ ] **Step 6:** Write tests for `Button` (variant class application, `href` vs. plain-button rendering path) and for `EmptyState`'s new action-link vs. action-button branches. Place under the project's existing test-file convention (check `tests/` directory structure first for whether component tests are colocated or centralized).
- [ ] **Step 7:** `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 8:** Run whatever existing tests cover `src/components/schedule/{day-timeline,session-card}.tsx` (locate via `grep -rl "day-timeline\|session-card" tests/`) to confirm the `Card`/`Badge` restyle causes no regression there.

**Authorization and privacy considerations:** none — pure presentation components, no data access.

**Test requirements:** new unit tests for `Button` and `EmptyState`'s extended API (Step 6); regression run of existing schedule-component tests (Step 8).

**Acceptance criteria:** all 4 existing primitives visually restyled with unchanged public APIs; `Button` exists and is usable in both action and navigation modes; zero regression in the 2 existing consumer components; `tsc`/`lint`/tests clean.

**Dependencies:** Task 1 (color tokens must exist to restyle against).

**Rollback considerations:** fully reversible; the 2 existing consumers would need to be checked again if this task is reverted after Task 13/15 (which may have added new consumers of these primitives) — revert order matters if done out of sequence.

---

## Task 3: Global-state components

**Objective:** Build the 6 approved reusable state components (`EmptyState` already extended in Task 2; the remaining 5 built here) with correct, documented accessibility semantics per the approved refinements — not identical content everywhere, but a consistent accessible pattern.

**Files:**
- Create: `src/components/states/error-state.tsx`
- Create: `src/components/states/unauthorized-state.tsx`
- Create: `src/components/states/not-found-state.tsx`
- Create: `src/components/states/loading-state.tsx`
- Create: `src/components/states/maintenance-state.tsx`
- Create: test files (see below)

**Existing behavior that must be preserved:** n/a — all new components; must not break Task 2's `EmptyState`, which these may compose alongside but not duplicate.

**Implementation steps:**
- [ ] **Step 1: `ErrorState`** — props: `title`, `description?`, `onRetry?: () => void`, `errorId?: string` (small/muted reference text), `technicalDetail?: string` (inside a collapsed `<details>`, hidden by default), `announce?: boolean` (default `false`; only when `true` does the component render with `role="alert"` — server-rendered/static error pages must NOT set this, per the approved rule that `role="alert"` is for newly-occurring client-side failures only). Real `<h2>` heading always present.
- [ ] **Step 2: `UnauthorizedState`** — props: `destination: { href: string; label: string }` (REQUIRED, caller-supplied — per Section 2 decision 1, admin usage passes the caller's own permitted dashboard, e.g. a staff-role caller viewing this from a route they can't access still gets sent to `/dashboard`, not assumed). Generic copy only — must not name the specific page, required role, or any data the page would have shown, per the approved "must not reveal sensitive information" requirement.
- [ ] **Step 3: `NotFoundState`** — bilingual via `useTranslations`; designed for use both from `src/app/[locale]/not-found.tsx` (Next's file convention) and inline elsewhere. Before writing, check whether Next 16's root `not-found.tsx` can access `params.locale` (historically App Router's global not-found could NOT access route params in some versions) — verify against `node_modules/next/dist/docs`; if params aren't accessible there, fall back to rendering the default locale's copy at that specific file location, while inline usages elsewhere get full locale-correct text.
- [ ] **Step 4: `LoadingState`** — variants `page | section | inline | table`. `page`/`section`: centered spinner + label, `aria-live="polite"`. `table`: `Skeleton`-based rows, configurable row/column count. `inline`: small spinner for buttons/inline contexts, no live-region wrapper needed at that granularity.
- [ ] **Step 5: `MaintenanceState`** — props: `title`, `description`, `retryAt?: string` (ISO timestamp, rendered only if actually passed, never invented), `contactAction?: { label: string; href: string }` (optional).
- [ ] **Step 6:** Write tests for each: heading presence and correct semantic level; `ErrorState`'s `role="alert"` applied only when `announce=true`; `UnauthorizedState` renders the passed-in `destination`, never a hardcoded fallback; `NotFoundState` renders correctly in both locales from both usage contexts (file-convention and inline).
- [ ] **Step 7:** `npx tsc --noEmit`, `npm run lint`, run new tests.

**Authorization and privacy considerations:** `UnauthorizedState` is itself an authorization-adjacent UI surface — its whole purpose is to fail safely without leaking information. This is the one component in this task where the accessibility/security review must be genuinely careful: confirm no prop or default copy could leak a role name, page purpose, or data shape to an unauthorized viewer.

**Test requirements:** covered in Step 6 above; explicitly include a test asserting `UnauthorizedState`'s rendered output contains no page-specific or role-specific strings beyond what's passed via `destination.label`.

**Acceptance criteria:** all 5 components exist, pass their tests, `tsc`/`lint` clean, and `UnauthorizedState` specifically passes the information-leakage check.

**Dependencies:** Task 1 (tokens), Task 2 (may reuse `Skeleton`/`Button`/`EmptyState`).

**Rollback considerations:** fully reversible; nothing yet depends on these until Task 6 wires them into layouts.

---

## Task 4: Navigation configuration (serializable) and route-matching logic

**Objective:** Define the two role-specific navigation structures as plain serializable data (never component references) and the pure, independently-testable active-route-matching logic that drives sidebar highlighting.

**Files:**
- Create: `src/lib/nav/nav-types.ts`
- Create: `src/lib/nav/admin-nav-config.ts`
- Create: `src/lib/nav/participant-nav-config.ts`
- Create: `src/lib/nav/route-matching.ts`
- Create: `src/lib/nav/icon-map.ts` (client-side icon-key → component lookup)
- Create: test files (see below)

**Existing behavior that must be preserved:** none directly touched yet (these are new modules); the `href` values must exactly match the real, verified routes in Section 0 — a mismatch here would be a real, user-facing broken-link bug, not a cosmetic issue.

**Implementation steps:**
- [ ] **Step 1:** Check `package.json` for an existing icon-library dependency before choosing one. If none exists, use a small inline SVG icon set rather than installing a new package without separate approval (matching the "no new UI framework without approval" principle extended to icon libraries).
- [ ] **Step 2:** Define `nav-types.ts`: `NavItem = { labelKey: string; href: string; iconKey: string; children?: NavItem[] }`, `NavGroup = { labelKey: string; items: NavItem[] }`. Every field a string/array/plain-object.
- [ ] **Step 3:** Write `admin-nav-config.ts` — Dashboard first/ungrouped (`/dashboard`), then the 4 approved groups (Participants, Agenda, Allocation, Schedule Publication) with the exact routes listed in Section 0's verified route inventory. Every route in Section 0's inventory must appear exactly once across the 4 groups — in particular, `/applications` and `/applications/[id]` (real existing routes, easy to overlook since they're not under `/participants/*`) go under the Participants group, alongside the participant list/detail/import routes. Cross-check the finished config against Section 0's route list item-by-item before moving on; a route present in Section 0 but missing from the config would make that page unreachable from the sidebar, a real regression. Every `labelKey` targets the new `nav` i18n namespace (Task 12).
- [ ] **Step 4:** Write `participant-nav-config.ts` — flat: Dashboard (`/my-dashboard`), My Schedule (`/schedule`), My Application (`/my-application`).
- [ ] **Step 5:** Write `route-matching.ts` — pure functions. Rule: item is active if `pathname === href` (after locale-stripping) OR `pathname.startsWith(href + '/')` (a genuine path-segment boundary check, preventing `/agenda` from false-matching `/agenda-typo`). Group is active if any child item is active. Locale prefix and query string are stripped before comparison. Dynamic segments (e.g. `/participants/[applicationId]`) work automatically under this rule since the real pathname naturally starts with the parent's static prefix.
- [ ] **Step 6:** Write `icon-map.ts` — `Record<string, ComponentType>`, imported only by client-side `SidebarNav` (Task 5), never by the server-side config files themselves.
- [ ] **Step 7:** Write `tests/lib/nav/route-matching.test.ts` — exact match, child-route match, group activation, dynamic segments, locale-prefixed paths, query-string-suffixed paths, the false-positive-prefix guard, no-match case. Write `tests/lib/nav/nav-config.test.ts` — both configs round-trip through `JSON.parse(JSON.stringify(config))` without throwing or losing data (mechanical serializability proof), and every `href` in both configs exists in Section 0's verified route list (regression guard against future route renames breaking nav silently).
- [ ] **Step 8:** `npx tsc --noEmit`, `npm run lint`, run new tests.

**Authorization and privacy considerations:** navigation configuration is explicitly NOT an authorization mechanism (Section 2 principle, restated) — this task must not introduce any code that treats "item present in config" as equivalent to "user is allowed to access it." Every route's own real authorization check remains the only source of truth.

**Test requirements:** Step 7 above; additionally, the `nav-config.test.ts`'s href-existence check should be treated as a standing regression test that must be updated whenever a route is genuinely renamed in future work — document this in the test file's own comments.

**Acceptance criteria:** both configs are valid, serializable, fully covered by the href-existence check; `route-matching.ts`'s test suite covers every case listed in Step 7; `tsc`/`lint` clean.

**Dependencies:** none technically, but logically follows Tasks 1–3 since it's part of the same shell-building sequence.

**Rollback considerations:** fully reversible; nothing depends on this until Task 5.

---

## Task 5: AppShell — server shell + client interaction boundary

**Objective:** Build the shared shell architecture with the approved server/client split: authorization, role resolution, and nav-config selection stay server-side; only active-route detection, drawer state, persisted expansion state, and interactive menus cross into Client Components.

**Files:**
- Create: `src/components/shell/app-shell.tsx` (server)
- Create: `src/components/shell/app-shell-client.tsx` (client, minimal interaction-state boundary)
- Create: `src/components/shell/sidebar-nav.tsx` (client)
- Create: `src/components/shell/mobile-drawer.tsx` (client)
- Create: `src/components/shell/topbar.tsx` (server where possible)
- Create: `src/components/shell/language-switcher.tsx` (client)
- Create: `src/components/shell/user-menu.tsx` (client, interactive parts only)
- Create: `src/app/[locale]/(auth)/actions.ts` (new — the logout server action)
- Create: test files (see below)

**Existing behavior that must be preserved:** the existing `log-in/page.tsx`'s `createClient()` server-client pattern is the template the new logout action must follow exactly, for consistency — not a new auth pattern invented from scratch.

**Implementation steps:**
- [ ] **Step 1: `app-shell.tsx` (server)** — props: `navGroups: NavGroup[]`, `userDisplay: { name: string; roleLabel: string }` (pre-resolved, safe display data — never a raw DB row), `locale: string`, `children`. Renders `Topbar` + `AppShellClient`. No `'use client'`, no `usePathname`, no `localStorage` in this file.
- [ ] **Step 2: `app-shell-client.tsx`** — the sole holder of mobile-drawer-open state, coordinating `Topbar`'s mobile-trigger and `MobileDrawer` without forcing `Topbar` itself to be a Client Component (the trigger button itself may need to be its own tiny client island — decide the minimal boundary during implementation).
- [ ] **Step 3: `sidebar-nav.tsx` (client)** — receives `navGroups` as props. Uses `usePathname()` from `@/i18n/routing` + `route-matching.ts` (Task 4) for active-state. Group expand/collapse: `useState`, initialized to a default (all-collapsed or first-group-open — decide) on first render, then corrected from `localStorage` inside a `useEffect` only (never read `localStorage` during the render that produces the initial/SSR-matching markup — this is the hydration-safety requirement). Storage key: `rcoy-admin-nav-v1` or `rcoy-participant-nav-v1`, chosen by which config was passed in. The group containing the currently active route force-expands regardless of stored state.
- [ ] **Step 4: `mobile-drawer.tsx` (client)** — focus trap (manual first/last-focusable-element wrap on Tab — confirm no focus-trap library already exists in `package.json` before adding one), close on `Escape`, close on any pathname change (via `usePathname()`), return focus to the stored trigger-button ref on close, lock `body` scroll while open (cleaned up on unmount), `aria-label` on the drawer landmark, logical-CSS (`inset-inline-start`, not hardcoded `left`) placement for correct RTL behavior, always starts closed.
- [ ] **Step 5: `topbar.tsx` (server where possible)** — horizontal logo linking to `/`, a page-title/breadcrumb slot (decide during implementation whether this needs a client boundary for per-page dynamism, or can stay a simple server-passed string/`children`), composes `LanguageSwitcher` + `UserMenu` (client) + the mobile-drawer trigger (client island from Step 2).
- [ ] **Step 6: `language-switcher.tsx` (client)** — uses `usePathname()`/`useRouter()` from `@/i18n/routing` plus `useSearchParams()` from `next/navigation` for query preservation. Verify `next-intl`'s exact locale-switching call signature (e.g. `router.replace(pathname, { locale })`) against its real type definitions in `node_modules/next-intl` before writing — do not assume from memory. Dynamic route params are already embedded in the string `usePathname()` returns, so no separate param-extraction logic should be needed — confirm this via the switcher's own test against a dynamic route path. A locale switch is a full navigation, and `MobileDrawer` (Step 4) already closes on any pathname change — confirm during testing that triggering a locale switch from inside an open mobile drawer does not leave the drawer visibly open with mismatched RTL/LTR classes mid-transition; no new code should be needed here since Step 4's existing close-on-navigate behavior covers it, but this interaction must be explicitly exercised by a test, not assumed to work.
- [ ] **Step 7: `user-menu.tsx` (client, interactive parts only)** — displays a translated role label (map raw `user_role` enum → i18n key, never render the raw enum string), a menu containing the logout trigger.
- [ ] **Step 8: Logout server action** — `src/app/[locale]/(auth)/actions.ts`, exported `logOutAction`: calls `(await createClient()).auth.signOut()` server-side (mirroring `log-in/page.tsx`'s existing `createClient()` usage exactly), then redirects to the correct localized `/log-in` via the established `redirect()` helper from `@/i18n/routing`. `UserMenu` invokes this via a `<form action={logOutAction}>` (a true server action form submission, not client-only `fetch`/session manipulation, per the approved requirement) with a pending/loading state shown during submission and error handling if the action fails.
- [ ] **Step 9:** Write tests: `tests/lib/nav/` route-matching integration (if not fully covered by Task 4's unit tests), `language-switcher` (route/param/query preservation, mocking `usePathname`/`useSearchParams`), `mobile-drawer` (focus trap, Escape-close, close-on-navigate, focus-return), `sidebar-nav` (SSR-matching initial render with no `localStorage` access, correct persisted-state read on client-only re-render, active-route force-expand overriding stored-collapsed), and the logout action itself (calls `signOut`, redirects to the correct locale-prefixed `/log-in`, following this codebase's established live-test pattern for anything touching real Supabase auth).
- [ ] **Step 10:** `npx tsc --noEmit`, `npm run lint`, run new tests.

**Authorization and privacy considerations:** `userDisplay` passed into `AppShell` must be pre-sanitized by the caller (Task 6's layouts) — never pass a raw `profiles` row through. The logout action must genuinely invalidate the server-side session (real `signOut()`, not just a client-side redirect that leaves cookies/tokens valid) — this is a real security property to verify in the test, not assume.

**Test requirements:** Step 9, in full; the logout test specifically must be a real live-DB test (create a real session, call the action, verify the session is actually invalidated afterward) — not a mocked assertion that `signOut` was merely called.

**Acceptance criteria:** shell renders correctly server-side with no client-only content flashing/mismatching on load; drawer meets every listed accessibility requirement; language switcher preserves route/params/query verified against at least one dynamic-route test case; logout genuinely ends the session and redirects correctly; `tsc`/`lint`/tests clean.

**Dependencies:** Task 1 (tokens/fonts), Task 2 (`Button` for menu/drawer triggers), Task 4 (nav configs + route-matching).

**Rollback considerations:** the logout action is new, real security-relevant code — if reverted, confirm no `UserMenu` or other new UI still references it (would break the build, not silently fail, so this is a low-risk rollback in practice).

---

## Task 6: `(admin)` and `(participant)` layouts wired to AppShell

**Objective:** Wire the real authorization-gated layouts for both role areas, applying the Section 2 decisions on unauthorized-access behavior and the claim/register shell exception.

**Files:**
- Create: `src/app/[locale]/(admin)/layout.tsx`
- Create: `src/app/[locale]/(participant)/layout.tsx`
- Create: `src/app/[locale]/(admin)/loading.tsx`, `src/app/[locale]/(admin)/error.tsx`
- Create: `src/app/[locale]/(participant)/loading.tsx`, `src/app/[locale]/(participant)/error.tsx`
- Modify: `src/app/[locale]/(participant)/claim/page.tsx`, `src/app/[locale]/(participant)/register/page.tsx` (shell-exception handling — see Step 3)

**Existing behavior that must be preserved:** every existing admin/participant page's OWN internal auth check remains in place and authoritative — this layout is an ADDITIONAL layer (defense in depth, matching the established pattern of double-checking authorization at multiple layers throughout this codebase), never a replacement for a page's existing check.

**Implementation steps:**
- [ ] **Step 1:** Write `(admin)/layout.tsx` — server component. Unauthenticated → `redirect()` to localized `/log-in` (per Section 2 decision 1). Authenticated + `profiles.role` fetched + `!isAgendaStaffRole(role)` → render `UnauthorizedState` with `destination` pointing at `/my-dashboard` (a participant landed on an admin URL). Authorized → select `adminNavGroups`, build sanitized `userDisplay`, render `<AppShell>`.
- [ ] **Step 2:** Write `(participant)/layout.tsx` — same pattern, any authenticated participant, `destination` for `UnauthorizedState` (reached only in the unlikely case of a role mismatch, e.g. staff landing here unexpectedly) pointing at `/dashboard`.
- [ ] **Step 3 (Section 2 decision 2):** `claim` is a pre-claim state and must NOT render inside the full `(participant)` `AppShell` — use a simple centered-card layout instead. Before applying the same treatment to `register`, first read `register/page.tsx` and its actions to confirm what it actually does: it is a DIFFERENT existing flow (initial application registration for a participant with no imported/pre-existing application, not the claim-an-imported-invitation flow) and must not be assumed to mirror `claim` just because Section 2 decision 2 names both. If `register` is genuinely a pre-authentication or pre-application state, apply the same simple centered-card treatment; if it is something else (e.g. already-authenticated participant filling out a form), give it whatever shell treatment its real, verified behavior calls for and note the deviation from a literal reading of decision 2, with reasoning, in this task's implementation notes. Implement the chosen shell-exception(s) either by moving the affected page(s) to render their own simple centered-card layout independent of `(participant)/layout.tsx` (e.g. via a nested layout override, or by relocating them to a route segment with its own minimal layout) — choose the approach that does NOT change existing URLs (`/claim`, `/register` must stay exactly as-is, per the earlier "preserve existing URLs" requirement), and document the chosen technique clearly in this task's implementation notes since it's a real Next.js layout-nesting decision worth recording.
- [ ] **Step 4:** After a successful claim (in `claim/actions.ts`'s existing success path), the redirect destination changes to `/my-dashboard` (previously wherever it went before — confirm and update). Confirm no other part of the app still shows invitation-oriented copy to an already-claimed participant (this is primarily enforced by Task 11's dashboard query correctly branching on claim state, but flag any other page found showing stale invitation language during this task's review).
- [ ] **Step 5:** Add `loading.tsx`/`error.tsx` for both groups using `LoadingState`/`ErrorState`. Confirm whether `error.tsx` must be a Client Component in Next 16 (check docs, do not assume from training data) and mark it `'use client'` only if actually required.
- [ ] **Step 6:** `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 7:** Manually verify at least one existing admin page (`/participants`) and one participant page (`/schedule`) still return 200 and render inside the new shell without breaking.

**Authorization and privacy considerations:** this task is entirely about authorization UX — the central risk is accidentally weakening a real check while adding the new layer. Every existing page's own check must be re-confirmed still present and still first-class, not superseded by the new layout-level check.

**Test requirements:** a test confirming unauthenticated access to an admin route redirects to `/log-in`; a test confirming authenticated-wrong-role access renders `UnauthorizedState` (not `notFound()`, not a silent redirect) with the correct role-appropriate `destination`; a test confirming `claim`/`register` do NOT render the full `AppShell`.

**Acceptance criteria:** both layouts correctly gate access per Section 2 decision 1; claim/register render outside the full shell per decision 2; existing pages unaffected; `tsc`/`lint`/tests clean.

**Dependencies:** Tasks 3 (`UnauthorizedState`), 4 (nav configs), 5 (`AppShell`).

**Rollback considerations:** reverting this task removes the shell wrapper from every admin/participant page at once — a large-surface but mechanically simple revert (delete the 2 layout files) since no page-level logic changed here.

---

## Task 7: Log-in page restyle + role-aware redirect fix

**Objective:** Fix the known pre-existing bug (log-in always redirects to `/my-application` regardless of role) and restyle the log-in/sign-up pages within a new `(auth)` layout.

**Files:**
- Create: `src/app/[locale]/(auth)/layout.tsx`
- Modify: `src/app/[locale]/(auth)/log-in/page.tsx`
- Modify: `src/app/[locale]/(auth)/sign-up/page.tsx`

**Existing behavior that must be preserved:** the `signInWithPassword` call and its error-handling exactly as today; the `ENABLE_SELF_REGISTRATION`-flagged dormancy of `sign-up` (styling only, no behavior change).

**Implementation steps:**
- [ ] **Step 1:** Write `(auth)/layout.tsx` — centered branded card, logo, no sidebar (pre-authentication).
- [ ] **Step 2:** Implement role-aware redirect: after successful sign-in, resolve the user's `profiles.role` and redirect accordingly — staff roles (`super_admin`, `agenda_allocation_manager`, `registration_admission_manager`, `communications_attendance_manager`) → `/dashboard`; `participant` → `/my-dashboard`. Decide during implementation whether this becomes a server action (more consistent with this codebase's established `*ForCaller` pattern) or stays client-side with an added role query — prefer the server-action approach for consistency, document the choice.
- [ ] **Step 3:** Restyle the log-in form with `Button`/`Card`/new tokens — same fields, same validation, same error surface, only markup and the Step 2 redirect logic change.
- [ ] **Step 4:** Restyle `sign-up/page.tsx` to match visually — no behavior change, stays behind its existing flag.
- [ ] **Step 5:** Write/update a test specifically for the role-aware redirect (new, real behavior) — a live-DB test seeding a staff user and a participant user, signing in as each, asserting the correct destination.
- [ ] **Step 6:** `npx tsc --noEmit`, `npm run lint`, run tests.

**Authorization and privacy considerations:** the redirect decision itself must be based on a server-verified role lookup, never a client-trusted value.

**Test requirements:** Step 5.

**Acceptance criteria:** staff and participant accounts land on their correct respective dashboards after login; `sign-up` unaffected behaviorally; `tsc`/`lint`/tests clean.

**Dependencies:** Task 2 (`Button`/`Card`), Task 6 (destination routes `/dashboard`/`/my-dashboard` should exist or at least be planned — acceptable to implement this task before Task 11's dashboard pages exist, since the redirect target just needs to be a valid route, not a finished page; confirm Task 6's layouts at least render *something* at those paths by this point, even if Task 11's real dashboard content lands later).

**Rollback considerations:** fully reversible; the redirect-destination change is the only real behavioral delta and is isolated to this task.

---

## Task 8: Public shell (header/footer/mobile nav) + homepage — VISUAL MILESTONE

**Objective:** Build the public-facing header/footer/mobile-navigation and the real homepage, replacing the placeholder. This is the first genuine visual milestone — the point at which the user reviews actual rendered pages.

**Files:**
- Create: `src/components/public/public-header.tsx`
- Create: `src/components/public/public-footer.tsx`
- Create: `src/components/public/public-navigation.tsx`
- Create: `src/components/public/public-mobile-nav.tsx`
- Create: `src/app/[locale]/(public)/layout.tsx`
- Create: `src/app/[locale]/(public)/page.tsx`
- Create: `src/app/[locale]/(public)/loading.tsx`, `src/app/[locale]/(public)/error.tsx`
- **Delete: `src/app/[locale]/page.tsx`** (same commit as creating the new homepage — no window where both exist)
- Create: `src/lib/content/public-content.ts` (structural config only — labels/hrefs/section ordering; actual copy lives in i18n or is clearly marked placeholder)

**Existing behavior that must be preserved:** the existing homepage's `metadata` intent (title "RCOY MENA 2026") carries forward conceptually; nothing else, since this page has no real logic to preserve.

**Implementation steps:**
- [ ] **Step 1:** Write `public-navigation.tsx` — link list (Home/About/Agenda/Speakers/FAQ/Partners/Contact/Accessibility). If a target page doesn't exist until Task 9, either sequence accordingly or create minimal stub pages now with an honest "Content will be published soon" `EmptyState` so links are never dead — prefer stubbing now.
- [ ] **Step 2:** Write `public-header.tsx` (server) — horizontal logo, `public-navigation`, `LanguageSwitcher` (reused from Task 5), CTA area using ONLY approved language (Participant Login / Claim Your Account / View Agenda / Learn More — never anything implying open registration), mobile-nav trigger.
- [ ] **Step 3:** Write `public-mobile-nav.tsx` (client) — reuse `MobileDrawer` (Task 5) with public-nav content rather than duplicating the accessibility logic, unless the public nav's simpler shape genuinely doesn't fit — prefer reuse.
- [ ] **Step 4:** Write `public-footer.tsx` — Privacy/Terms/Accessibility/Contact links, real approved contact info (from Task 9's Contact page content), social links ONLY if real URLs are supplied — omit the section entirely otherwise, never placeholder social links.
- [ ] **Step 5:** Write `(public)/layout.tsx` — no auth check, renders header+footer+children.
- [ ] **Step 6:** Write the real homepage — hero with serif headline (real copy, flagged for the user's review since exact wording wasn't specified), one of the approved context-appropriate CTAs, a brief "what is RCOY MENA" section, links into Agenda/Speakers/Partners. **Delete `src/app/[locale]/page.tsx` in this same commit.**
- [ ] **Step 7:** Add `(public)/loading.tsx`/`error.tsx`.
- [ ] **Step 8:** `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 9 — HARD STOP, VISUAL REVIEW CHECKPOINT:** Start `npm run dev`. Confirm zero server errors. Report the exact URLs for: homepage (`/en`, `/ar`), log-in (`/en/log-in`), admin area (`/en/dashboard` — may still be an empty/stub shell if Task 11 hasn't run, note this honestly rather than implying it's finished), participant area (`/en/my-dashboard` — same honest caveat), participant schedule (`/en/schedule`). **Leave the dev server running.** **Do not proceed to Task 9 or any further page styling until the user has reviewed and explicitly approved this milestone.** This is the single most important checkpoint in this entire plan — do not skip or soften it.

**Authorization and privacy considerations:** the public site has no auth gate by definition — the only privacy concern is ensuring no admin/participant data of any kind leaks onto any public page (a straightforward review point: this task's pages query nothing from `applications`/`import_batches`/etc. at all).

**Test requirements:** none beyond `tsc`/`lint` for this task specifically — the public pages are largely static/structural at this point; real content-driven tests (e.g. the Agenda page's data-source decision) land in Task 9.

**Acceptance criteria:** dev server running with zero errors; every listed URL loads and is visually reviewable; homepage shows no fake content; the old placeholder homepage file is gone with no URL collision; the user has explicitly approved before Task 9 begins.

**Dependencies:** Tasks 1–6 (fonts, tokens, primitives, states, nav, shell all needed for the public shell to look and behave correctly).

**Rollback considerations:** deleting `src/app/[locale]/page.tsx` is the one action in this task that isn't trivially reversible without care — if this task is rolled back, the old placeholder file must be restored from git history, not silently left absent (which would 404 the homepage).

---

## Task 9: Remaining public pages

*(Gated: do not start until Task 8's milestone is explicitly approved by the user.)*

**Objective:** Build the remaining 9 public pages, resolving the Agenda data-source question per Section 2 decision 3, with zero fabricated content anywhere.

**Files:**
- Create: `src/app/[locale]/(public)/about/page.tsx`
- Create: `src/app/[locale]/(public)/agenda/page.tsx`
- Create: `src/app/[locale]/(public)/speakers/page.tsx`
- Create: `src/app/[locale]/(public)/faq/page.tsx`
- Create: `src/app/[locale]/(public)/partners/page.tsx`
- Create: `src/app/[locale]/(public)/contact/page.tsx`
- Create: `src/app/[locale]/(public)/accessibility/page.tsx`
- Create: `src/app/[locale]/(public)/privacy/page.tsx`
- Create: `src/app/[locale]/(public)/terms/page.tsx`
- Possibly create: `src/lib/content/public-agenda-query.ts` (only if Step 2's investigation finds a safe query is genuinely buildable)

**Existing behavior that must be preserved:** n/a, all new pages — EXCEPT the Agenda investigation (Step 2), which must not accidentally expose any admin-only or participant-specific data through a new public query.

**Implementation steps:**
- [ ] **Step 1: About** — real copy if the user has supplied it by this point; otherwise the approved "Content will be published soon" `EmptyState` treatment.
- [ ] **Step 2: Agenda (Section 2 decision 3)** — investigate whether a query exists/can be built that returns ONLY currently-active, fully-published general-conference-schedule data (sessions joined through `schedule_publication_items` where `item_status = 'active'`, at the SESSION level, never touching `allocation_assignments`/participant-specific tables). Before writing any code, document in the implementation notes: (a) the exact tables and columns the proposed query touches, (b) the exact join path from `schedule_publication_items` to `sessions` to the specific fields to be displayed (title, time, room — enumerate them, do not select `*`), (c) the RLS policies currently defined on `sessions` and `schedule_publication_items` (read the relevant migration files — do not assume) and whether a public/anon-safe read path exists or would need to be added, and (d) explicit confirmation that no `allocation_assignments`, `applications`, or other participant-identifying table appears anywhere in the query. Only after all four are documented and genuinely support "yes, safe," implement it read-only, server-side. If any of the four raises doubt, use `EmptyState` ("The conference agenda will be published soon.") instead — no partial/uncertain implementation, and no query shipped without this documentation.
- [ ] **Step 3: Speakers** — grid layout, `EmptyState` by default (no fake speakers), structured to receive real entries via `public-content.ts` once supplied.
- [ ] **Step 4: FAQ** — accordion (check for an existing accordion primitive first; if none, build a minimal accessible one — keyboard-operable, correct `aria-expanded`), placeholder content clearly marked as such.
- [ ] **Step 5: Partners** — logo grid, `EmptyState` by default.
- [ ] **Step 6: Contact** — real approved contact info (needs the user's input if not already supplied), a `mailto:` action, structured layout, explicitly NO backend form (per Section 2 decision 4/approved scope).
- [ ] **Step 7: Accessibility** — describes real accessibility work actually done this phase (keyboard nav, focus management, RTL support, semantic states) — genuine content about genuine implementation, not generic boilerplate.
- [ ] **Step 8: Privacy / Terms** — standard structure, clearly marked as draft/placeholder pending real legal review, never presented as final without the user's explicit sign-off.
- [ ] **Step 9:** `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 10:** If Step 2 resulted in a real query, write a live-DB test confirming it correctly excludes drafts/cancelled/participant-specific data (mirroring this codebase's established RLS-adjacent test rigor).

**Authorization and privacy considerations:** Step 2 (Agenda) is the one place in this entire task with real data-exposure risk — this must be treated with the same care as any other public-facing query in this codebase, verified against real schema/status values, not assumed safe.

**Test requirements:** Step 10, if applicable.

**Acceptance criteria:** all 9 pages exist, render correctly in both locales, contain zero fabricated speakers/partners/dates/stats/testimonials; the Agenda page's data-source decision is documented in this task's implementation notes either way (real query with test, or explicit empty-state with the reasoning for not building the query yet).

**Dependencies:** Task 8 (public shell/layout must exist), and requires the user's explicit Task 8 approval before starting per the gate.

**Rollback considerations:** each page is independent and can be reverted individually without affecting the others.

---

## Task 10: Dashboard query modules (typed, server-only, authorization-preserving)

**Objective:** Build the typed, tested, authorization-preserving query layer that Task 11's dashboard pages will call — kept separate from presentation per the approved requirement.

**Files:**
- Create: `src/lib/dashboard/dashboard-types.ts`
- Create: `src/lib/dashboard/admin-dashboard-queries.ts`
- Create: `src/lib/dashboard/participant-dashboard-queries.ts`
- Create: test files (see below)

**Existing behavior that must be preserved:** none directly (new modules), but every query must correctly use the real, verified schema/status values from Section 0 — a wrong status string here would silently produce an always-empty or always-wrong dashboard card, a real correctness bug.

**Implementation steps:**
- [ ] **Step 1:** Define view-model types distinguishing the 4 real states, e.g.:
  ```ts
  type CardResult<T> =
    | { kind: 'data'; value: T }
    | { kind: 'empty' }       // entity has never existed
    | { kind: 'unauthorized' }
    | { kind: 'error'; message: string };
  ```
  A real `0` count is `{ kind: 'data', value: 0 }`, never collapsed into `empty`.
- [ ] **Step 2:** `admin-dashboard-queries.ts` — each function takes `{ userId, service }` (the established caller-object pattern), re-verifies `isAgendaStaffRole` internally as defense in depth:
  - `getRecentImportBatches` — last 5 `import_batches` (filename, status, uploaded_at, row_count, warning_count, error_count only — explicitly never selects any `application_answers`/raw-answer column).
  - `getImportsRequiringAttention` — count where `status IN ('failed', 'completed_with_warnings')`.
  - `getAcceptedParticipantCount` — count from `applications` where `status = 'accepted'`.
  - `getPendingInvitationsSummary` — counts grouped by the REAL status values (`not_sent`, `failed`, and `sent` = "sent but not yet claimed" — per Section 0's verified schema, no extra `accepted_at` check needed). Never selects `imported_email`.
  - `getUpcomingPublishedSessions` — sessions joined through `schedule_publication_items` where `item_status = 'active'` and a future start time, small limit.
  - `getAllocationRunStatus` — most recent `allocation_runs` row, or `{kind: 'empty'}` if none ever exist.
  - `getSchedulePublicationSummary` — counts by the real status values (`staged` drafts; `stale`/`changed`/`pending_review` items needing resolution; `active` publications).
- [ ] **Step 3:** `participant-dashboard-queries.ts` — every function takes the participant's own `userId`, scopes every query to their own `applicant_id` server-side (never trusting a client-supplied id):
  - `getMyApplicationStatus` — reads the caller's own `applications` row via `applicant_id = userId` (only valid once claimed; see `getMyClaimState` below for how the dashboard determines which case it's in).
  - `getMyClaimState` — MUST call the existing `findMyClaimableApplication()` (per Section 0's verified claim-state mechanism) rather than querying `participant_invitations` or `applications.applicant_id` directly. Wrap its result into `CardResult`: a returned `applicationId` → `{kind: 'data', value: {claimed: false, applicationId}}` (claimable, not yet claimed); an empty `{}` result → check `applications` for a row with `applicant_id = userId` — if found, `{kind: 'data', value: {claimed: true, applicationId}}`; if not found, `{kind: 'empty'}` (no invitation, nothing to claim, not an error). Never expose the "claimed by someone else / revoked / failed" distinction `findMyClaimableApplication()` deliberately withholds — the dashboard only needs to know "claimable," "already claimed by me," or "nothing to claim."
  - `getMySchedulePublicationState`
- [ ] **Step 4:** Write live-DB tests for both modules following this codebase's established `*-live.test.ts` conventions: real counts return correctly; a genuinely-zero-but-real entity returns `{kind: 'data', value: 0}` not `empty`; a never-existing entity returns `empty`; a forced query failure returns `error` (never silently becomes a displayed `0`); an explicit cross-participant isolation test proving one participant's query can never return another's data (mirroring `tests/rls/import.test.ts`'s rigor).
- [ ] **Step 5:** `npx tsc --noEmit`, `npm run lint`, run new tests.

**Authorization and privacy considerations:** this is the most privacy-sensitive task in the whole plan. Every admin query must be genuinely restricted to authorized roles (re-checked inside the function, not just trusted from the caller). Every participant query must be genuinely scoped to that one participant's own data — the cross-participant isolation test in Step 4 is non-negotiable, not optional.

**Test requirements:** Step 4, in full, including the explicit cross-participant isolation test and the query-failure-never-becomes-zero test.

**Acceptance criteria:** every function returns correctly-typed, correctly-distinguished results for all 4 states; the cross-participant isolation test passes; `tsc`/`lint`/tests clean.

**Dependencies:** none beyond the existing database schema (verified in Section 0) — can technically be built in parallel with Tasks 1–9, though sequenced here since Task 11 needs it immediately after.

**Rollback considerations:** fully reversible; nothing else depends on this until Task 11.

---

## Task 11: Admin dashboard and participant dashboard pages

**Objective:** Build the two real dashboard pages using Task 10's query layer, with the approved visual-density distinction (admin denser, participant calmer).

**Files:**
- Create: `src/app/[locale]/(admin)/dashboard/page.tsx`
- Create: `src/app/[locale]/(participant)/my-dashboard/page.tsx`

**Existing behavior that must be preserved:** n/a, both new pages.

**Implementation steps:**
- [ ] **Step 1:** Admin dashboard — server component, calls every function from `admin-dashboard-queries.ts`, renders a responsive card grid (desktop grid → mobile stacked list) using `Card`/`Badge`/`EmptyState`/`ErrorState` matched to each card's actual returned `CardResult` state. Each card links to its real module page. Dashboard is the FIRST item in the admin sidebar (already correctly ordered in Task 4's config).
- [ ] **Step 2:** Participant dashboard — server component, calls `participant-dashboard-queries.ts`, renders: welcome label (safe display name), application status, claim/account-linked state (with the post-claim language switch — no invitation-oriented copy once `getMyClaimState` indicates claimed), personal schedule-publication state, links to My Schedule/My Application, a clear notice if the schedule isn't published yet. Deliberately sparse — fewer cards, more whitespace, no admin-style dense metrics, per the approved calmer-participant-experience requirement.
- [ ] **Step 3:** `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 4:** Manually verify both pages load with real data against the live project (a fresh/empty-data state is acceptable and correctly exercises the `empty` rendering path — either is a valid, honest verification).

**Authorization and privacy considerations:** inherits Task 10's query-layer guarantees; this task's own responsibility is to render each `CardResult` state correctly and never paper over an `unauthorized`/`error` result with a friendly-looking fallback that implies success.

**Test requirements:** none new beyond Task 10's query tests — this task is presentation composition; a lightweight rendering smoke-test per dashboard is reasonable if the project's test conventions support component-level page tests, otherwise the manual verification in Step 4 is the primary gate.

**Acceptance criteria:** both dashboards render real data correctly in all 4 `CardResult` states; participant dashboard shows no admin-style density; post-claim language switch works correctly; `tsc`/`lint` clean.

**Dependencies:** Task 10 (query layer), Task 3 (state components), Task 6 (layouts must exist for these routes to render inside the shell).

**Rollback considerations:** fully reversible; independent of other pages.

---

## Task 12: i18n — expand message namespaces

**Objective:** Add every new namespace needed by Tasks 1–11's UI text, with real (not placeholder-English) Arabic translations.

**Files:**
- Modify: `src/messages/en.json`
- Modify: `src/messages/ar.json`

**Existing behavior that must be preserved:** the 5 existing namespaces (`landing`, `auth`, `registration`, `status`, `schedule`) and every key within them — this task ADDS namespaces, never restructures or removes existing keys (any existing page depending on them must keep working).

**Implementation steps:**
- [ ] **Step 1:** Add namespaces to both files in sync: `nav`, `shell`, `states`, `public` (sub-namespaced per page: `public.homepage.*`, `public.about.*`, etc.), `auth` (extended), `adminDashboard`, `participantDashboard`, `common`.
- [ ] **Step 2:** Grep the new files from Tasks 1–11 specifically for hardcoded UI strings that should route through `useTranslations` instead — fix any found. (Existing untouched pages are out of scope until Tasks 13–15.) Acceptance check for this step specifically: re-run the same grep after fixing and confirm zero remaining matches — a reviewer must be able to reproduce "zero hardcoded strings" mechanically, not take "fixed any found" on faith.
- [ ] **Step 3:** Obtain real Arabic translations for every new key — flag explicitly to the user any string where a professional translation isn't available yet, rather than silently shipping English text under the `ar` locale.
- [ ] **Step 4:** `npx tsc --noEmit`, `npm run lint`, `npm run build` (check whether `next-intl` is configured to fail the build on a missing message key in this project — if so, this is a strong regression gate; verify and note the actual behavior).
- [ ] **Step 5:** Commit.

**Authorization and privacy considerations:** none.

**Test requirements:** none beyond the build-time missing-key check (Step 4), if that mechanism exists.

**Acceptance criteria:** every new UI string introduced in Tasks 1–11 is translatable and has both real English and real Arabic text; existing namespaces untouched; `tsc`/`lint`/build clean.

**Dependencies:** logically follows Tasks 1–11 (needs their new strings to exist), though the namespace additions themselves have no code dependency.

**Rollback considerations:** fully reversible; a partial revert (only some new keys) risks leaving other new UI referencing missing keys — revert this task's additions atomically if reverting at all.

---

## Task 13: Restyle existing admin pages in place (participants, applications, import flow)

**Objective:** Apply the new visual system to every page under `(admin)/participants/*` and `(admin)/applications/*`, with zero logic change, and prove zero regression via the existing Phase 5.1 test suite.

**Files:** every existing `page.tsx`/related component under those two route trees — restyled, never moved.

**Existing behavior that must be preserved:** every server action call, every validation rule, the chunked/resumable import logic, the `existing_claimed` approval gate, rollback confirmation and its blocking rules — all byte-identical. This is Phase 5.1's most heavily-hardened, most-reviewed code in the whole project; this task is presentation-layer only.

**Implementation steps:**
- [ ] **Step 1:** `/participants` (list) — restyle using new tokens + `Card`/`Badge`, same data/columns/logic.
- [ ] **Step 2:** `/participants/[applicationId]` (detail) — restyle; ensure invitation status/sent-date/resend/revoke/failure-reason/claimed-state are all clearly, visually exposed (data already exists, this is a presentation upgrade).
- [ ] **Step 3:** `/participants/import` + all 4 wizard steps (`map`/`preview`/`confirm`/`rollback`) — restyle each, every server action call preserved exactly.
- [ ] **Step 4:** `/participants/imports` + `/participants/imports/[batchId]` — restyle history list and batch-detail audit view.
- [ ] **Step 5:** `/applications` + `/applications/[id]` — restyle.
- [ ] **Step 6:** `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 7:** Run the full relevant live-test suite (`tests/import/*.test.ts`, `tests/rls/import.test.ts`) individually per file (per this project's established gate-6 methodology — never as one giant parallel batch, which this project's history shows causes live-DB cross-test contamination) to confirm zero regression.

**Authorization and privacy considerations:** none new — this task must not touch any authorization logic at all; if a restyle accidentally changes how/whether a role check renders, that's a regression to catch in Step 7, not an intended change.

**Test requirements:** Step 7, run individually per file, results documented honestly (distinguish genuine regression from the pre-existing, unrelated Resend invitation-send external blocker).

**Acceptance criteria:** every page visually restyled; 100% of the existing Phase 5.1 live-test suite still passes; `tsc`/`lint` clean.

**Dependencies:** Tasks 1–6 (full design system + shell must exist to restyle against).

**Rollback considerations:** each page can be reverted independently; the test suite from Step 7 is the safety net for any partial revert too.

---

## Task 14: Restyle existing admin pages in place (agenda, allocation, schedule publication)

**Objective:** Apply the new visual system to every page under `(admin)/agenda/*` and `(admin)/allocation/*`.

**Files:** every existing `page.tsx` under those two route trees.

**Existing behavior that must be preserved:** all Phase 5 clustering/allocation/schedule-publication logic, exactly as-is — presentation-only changes.

**Implementation steps:**
- [ ] **Step 1:** Restyle `/agenda`, `/agenda/days`, `/agenda/sessions`, `/agenda/sessions/[id]`, `/agenda/rooms`, `/agenda/tracks`, `/agenda/session-types`, `/agenda/tags`, `/agenda/people`.
- [ ] **Step 2:** Restyle `/allocation`, `/allocation/extraction`, `/allocation/clustering`, `/allocation/runs`, `/allocation/runs/[id]`, `/allocation/runs/[id]/capacity`.
- [ ] **Step 3:** Restyle `/allocation/schedules`, `/allocation/schedules/changed`, `/allocation/schedules/participants/[applicationId]`, `/allocation/schedules/stage/[allocationRunId]`, `/allocation/schedules/stage/draft/[draftId]`.
- [ ] **Step 4:** `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 5:** Run the relevant existing Phase 5 test suites (`tests/agenda/`, `tests/allocation/`, `tests/schedule/`), individually per file, to confirm zero regression.

*(Note: given the volume of pages, consider splitting Steps 1–3 into separate sub-commits for reviewability during actual execution — a reasonable implementation-time judgment call, not a fixed requirement.)*

**Authorization and privacy considerations:** same as Task 13 — presentation-only, no authorization logic touched.

**Test requirements:** Step 5, individually per file.

**Acceptance criteria:** every page restyled; 100% of the existing relevant test suites still pass; `tsc`/`lint` clean.

**Dependencies:** Tasks 1–6.

**Rollback considerations:** same pattern as Task 13 — independent pages, test suite as safety net.

---

## Task 15: Restyle existing participant pages in place (claim, my-application, schedule)

**Objective:** Apply the new visual system to the remaining participant-facing pages, respecting the Task 6 Step 3 shell-exception for `claim`.

**Files:** `(participant)/claim/page.tsx`, `(participant)/my-application/page.tsx`, `(participant)/schedule/page.tsx`.

**Existing behavior that must be preserved:** `claim/page.tsx`'s `onAuthStateChange` subscription and its 5-second fallback timeout — established, security/timing-sensitive logic from Phase 5.1, must not be touched beyond markup.

**Implementation steps:**
- [ ] **Step 1:** Restyle `claim/page.tsx` within its Task 6-established simple centered-card shell (not the full `AppShell`) — markup only, auth-state logic untouched.
- [ ] **Step 2:** Restyle `my-application/page.tsx` within the full participant `AppShell`.
- [ ] **Step 3:** Restyle `schedule/page.tsx` within the full participant `AppShell` (already partially using Task 2's restyled `Card`/`Badge` via the existing `day-timeline`/`session-card` components — confirm visual consistency, no duplicate restyling).
- [ ] **Step 4:** `npx tsc --noEmit`, `npm run lint`, run `tests/import/claim-live.test.ts` and any existing participant-facing schedule tests to confirm zero regression.

**Authorization and privacy considerations:** none new — the claim flow's security properties (established in Phase 5.1) are explicitly preserved, not re-derived.

**Test requirements:** Step 4.

**Acceptance criteria:** all 3 pages restyled correctly in their appropriate shell context; zero regression in claim/schedule tests; `tsc`/`lint` clean.

**Dependencies:** Tasks 1–6, and specifically Task 6 Step 3's shell-exception implementation for `claim`.

**Rollback considerations:** independent pages, test suite as safety net.

---

## Task 16: Final verification pass

**Objective:** Whole-phase regression and completeness check before considering Phase 5.5 done.

**Files:** none new.

**Existing behavior that must be preserved:** everything from Phase 5.1 and Phase 5 — this task's entire purpose is confirming that.

**Implementation steps:**
- [ ] **Step 1:** `npx tsc --noEmit` — zero errors, whole worktree.
- [ ] **Step 2:** `npm run lint` — zero errors.
- [ ] **Step 3:** `npm run build` — succeeds; confirm every new route (`/dashboard`, `/my-dashboard`, `/about`, `/agenda` [public], `/speakers`, `/faq`, `/partners`, `/contact`, `/accessibility`, `/privacy`, `/terms`) appears in the build output alongside every pre-existing route (regression check — nothing should have disappeared from the route list).
- [ ] **Step 4:** Run the full test suite, individually per file (per this project's established methodology, never one giant parallel batch), documenting pass/fail honestly and distinguishing genuine regressions from the pre-existing, unrelated Resend invitation-send external blocker.
- [ ] **Step 5:** Confirm `git status` clean.
- [ ] **Step 6:** Manual review checklist: RTL/LTR correctness in both locales; mobile/tablet/desktop responsiveness; keyboard navigation through sidebar and mobile drawer; zero fake speakers/partners/dates/stats/testimonials anywhere; every admin route reachable and correctly gated; participant dashboard shows no cross-participant or admin-only data; post-claim language switch verified; logout genuinely ends the session.
- [ ] **Step 7:** Write a short implementation-notes addendum summarizing what shipped, every deliberate judgment call made during implementation (Task 6 Step 3's shell-nesting technique, Task 9 Step 2's Agenda data-source decision, Task 14's sub-commit splitting if applied), and what remains for a future phase (real public content, professional Arabic translation review if any keys were flagged in Task 12, real speaker/partner data).

**Authorization and privacy considerations:** Step 6's manual checklist is where the whole phase's privacy/authorization guarantees get one final, holistic confirmation — not a substitute for the per-task tests already run, but a final honest look across the whole surface.

**Test requirements:** Step 4, full individual-file run.

**Acceptance criteria:** all of Steps 1–6 pass; Step 7's addendum is written and accurately reflects real decisions made, not idealized ones.

**Dependencies:** all prior tasks.

**Rollback considerations:** n/a — this is a verification task, produces no new reversible code.

---

## Notes for the implementing agent

- **Never invent placeholder statistics, speakers, partners, dates, or testimonials.** Every "no data" case uses `EmptyState` with honest, approved copy.
- **Never let navigation configuration substitute for server-side authorization.** Every page keeps its own real role check regardless of what the sidebar shows or hides.
- **Task 8's Step 9 is a hard, explicit stop.** Do not proceed to Task 9 without the user's explicit visual approval.
- **Task 9 is gated on that same approval** — do not begin it early even if other work seems ready.
- **Section 2's 5 decisions are binding** — do not re-ask the user about unauthorized-access behavior, the claim/register shell exception, the Agenda data-source approach, the logout implementation requirements, or the "no shadcn" constraint. These are resolved.
- **This plan assumes `superpowers:subagent-driven-development`** (fresh implementer subagent per task, two-stage spec-compliance + code-quality review, verified commit before proceeding) — matching the discipline already established and proven across Phase 5.1's 28-task execution in this same project.
