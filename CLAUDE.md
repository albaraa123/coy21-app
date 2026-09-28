# CLAUDE.md — COY21 Digital Participation & Event Operations Platform

## Read this first, before touching any code

Full specification: [`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md) — this is the source of truth.
Read it in full before making changes.

## Critical context

**This is NOT a greenfield build.** This folder should already contain a full copy of the
working **RCOY MENA 2026** platform (Next.js + Supabase). RCOY MENA was the pilot; COY21
(Antalya) is the adapted next stage of the same platform. Your job is to **review and extend**
the existing codebase — not rebuild from scratch.

Before writing any new code:
1. Explore the existing project structure (routes, components, database schema, auth setup).
2. Identify what already exists for: participant records, confirmation flow, session
   booking/allocation, QR credential + attendance scanning, admin/ops dashboard.
3. Cross-reference against `docs/BUILD_SPEC.md` to see what needs to change vs. what needs to
   be newly added.

## What must change from RCOY MENA → COY21 (not just additions)

- **Location content**: Local Info Hub and venue references move from Muscat/RCOY to
  **Antalya/COY21**.
- **Dates**: event dates, booking deadlines, and reminder timing must update to COY21's schedule.
- **Branding**: switch from RCOY branding to the COY21 Türkiye 2026 identity — see §15 of the
  build spec for exact colors (primary teal, accent orange) and logo usage rules. Logo files
  should be placed in `assets/branding/` (add them there if not already present).
- **Scale**: check whether RCOY's session capacity / DB assumptions hold for COY21's likely
  larger participant count.
- **Participant type / attendee codes**: confirm whether RCOY already has an equivalent type
  system, or whether the `COY21-[TYPE]-[SEQ]` format (DEL/VOL/KP/YNG/SPK, §10 of the build spec)
  needs to be added.

## Non-negotiable design principle: SIMPLICITY

Every module must be built as simply and easily as possible for the participant to use — this
matters more than feature completeness.

- Minimal taps/clicks to complete any task (booking a session, uploading a document, checking
  arrival status).
- No jargon, no unnecessary steps, no screens that just explain other screens.
- Mobile-first: most participants will use this on a phone, often with an unfamiliar UI and
  possibly a second/third language — large tap targets, plain language, obvious next actions.
- If a feature needs a tutorial to be understood, simplify the feature instead of writing the
  tutorial.

## Environment / infrastructure — confirm before making DB changes

- This project uses a **separate, dedicated Supabase project** for COY21 — it must **not** share
  a database with RCOY MENA.
- Before running any migration or writing to the database, confirm `.env.local` points to the
  COY21 Supabase project (check `NEXT_PUBLIC_SUPABASE_URL`), not the RCOY one.
- If the schema hasn't been applied yet to the new Supabase project, start there: replicate the
  RCOY schema (structure only, no participant data) as the baseline, per §13 of the build spec.

## Build order (see §14 of the build spec for full detail)

1. Core: participant DB, attendee code generation, document uploads, confirmation flow.
2. Agenda & Booking: sessions, capacity, conflict prevention, deadline logic, reminders.
3. Attendance: QR credential + scanner PWA + real-time validation.
4. Arrival & Logistics Tracking + Logistics dashboard.
5. Local Info Hub + Venue Map tab placeholder.
6. Operations Dashboard, Communication System, reporting.

Work through these in order. Don't jump ahead to a later phase before the current one is solid.

## Tech stack (unchanged from RCOY MENA)

| Layer | Technology |
|---|---|
| Front-end | Next.js |
| Database & Auth | PostgreSQL via Supabase |
| Email | Resend (or COY21-approved provider) |
| Attendance | Progressive Web App (PWA), no app install needed |

## First task

Start by reading `docs/BUILD_SPEC.md` in full, then explore the existing codebase and give a
short summary of: what already exists and can be reused as-is, what needs to be adapted
(location/dates/branding/codes), and what's genuinely new (Local Info Hub, Arrival Tracking).
Do this before writing or editing any code.
