# COY21 Digital Participation & Event Operations Platform — Build Spec

This document is the full build specification for the COY21 platform. It combines the original
approved concept proposal with a set of additional modules and details worked out afterward.
Use this as the source of truth to start building.

> **Context — this is NOT a greenfield build.** A working RCOY MENA 2026 platform already
> exists (full source code available locally). COY21 was always planned as an evolution of that
> same platform: RCOY MENA is the pilot, COY21 Antalya is the adapted next stage. Start by
> reviewing the existing RCOY MENA codebase and its data model before writing new code — reuse
> and extend what's there (auth, participant records, booking logic, QR/attendance system, etc.)
> rather than rebuilding from scratch. Treat everything in this document as the diff/extension
> needed to take the RCOY MENA platform to COY21, including things that need to change (not just
> things that need to be added):
> - **Location-specific content** (Local Info Hub, venue references) must move from Muscat/RCOY
>   context to Antalya/COY21 context.
> - **Dates** (event dates, booking deadlines, reminders) must update to COY21's schedule.
> - **Branding** (logo, colors — see §15) must switch from RCOY to the COY21 Türkiye 2026 identity.
> - **Scale**: check whether RCOY's session capacity / database assumptions hold for COY21's
>   likely larger participant count.
> - **Participant type / attendee codes** (§10): confirm whether RCOY already has an equivalent
>   type system, or whether DEL/VOL/KP/YNG/SPK needs to be added.

> **Overriding design principle: SIMPLICITY.** Every module in this document must be built as
> simply and easily as possible for the participant to use — this matters more than feature
> completeness. When a module could be built either as a rich/feature-heavy version or a
> stripped-down, obvious-at-a-glance version, always choose the simpler one. Concretely:
> - Minimal taps/clicks to complete any task (booking a session, uploading a document, checking
>   arrival status).
> - No jargon, no unnecessary steps, no screens that just explain other screens.
> - Mobile-first: most participants will use this on a phone, often with unfamiliar UI patterns
>   and possibly a second/third language — favor large tap targets, plain language, and obvious
>   next actions over dense information layouts.
> - If a feature needs a tutorial to be understood, simplify the feature instead of writing the
>   tutorial.

---

## 1. Background

Large international youth conferences such as COY21 involve interconnected processes:
registration, participant confirmation, programme management, session allocation,
communication, on-site check-in, attendance tracking, arrival/logistics coordination, and
post-event reporting.

Managed through separate spreadsheets, forms, and mailing lists, these processes lead to
duplicated records, inefficient coordination, manual session allocation, slower communication
and check-in, limited real-time visibility, and heavy manual effort in producing final reports.

Screening and selection remain the responsibility of a dedicated Selection & Screening Team and
happen outside the platform. Once completed, that team provides a single Excel sheet with
participant data and outcomes. The platform automatically creates a structured database of
accepted participants only — no manual data entry required.

The platform is being piloted at RCOY MENA 2026 (Muscat, 16–19 Sept 2026) before being adapted
for COY21 in Antalya. Pre-field internal testing of core workflows has already been completed
successfully.

## 2. Concept Overview

Two primary interfaces:

- **Participant Portal** — participants manage their own COY21 journey.
- **Administration & Operations Portal** — secure interface for authorized COY21 team members to
  manage applications, participants, sessions, and attendance.

The platform is modular: the Organizing Team activates only the modules it needs, in
coordination with Registration, Programme, Logistics, and Communications teams.

## 3. Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Front-End | Next.js | Powers both portals with a fast, responsive interface |
| Database & Auth | PostgreSQL via Supabase | Structured relational storage + secure auth/permissions |
| Email | Resend (or COY21-approved provider) | Transactional emails: confirmations, status updates, reminders |
| Attendance System | Progressive Web App (PWA) | Turns any authorized phone/tablet into a QR scanner, no app install needed |
| Hosting | Secure cloud deployment | To be finalized with Organizing Team (security, cost, data location) |

## 4. Roles (Role-Based Access)

| Role | Responsibility |
|---|---|
| Super Administrator | Full system configuration and oversight across all modules |
| Data Import Coordinator | Uploads/verifies the Excel sheet of selection results |
| Programme Manager | Builds and maintains the conference agenda and session details |
| Allocation Manager | Oversees participant-to-session allocation and adjustments |
| Operations Manager | Monitors live attendance and operational indicators during the event |
| Check-in / Scanner Staff | Limited access: validate participants and record attendance only |
| Logistics Coordinator | Monitors arrival/travel data feed for reception planning *(new role, needed for §7)* |

## 5. Core Modules (from original approved proposal)

- **Selection Results Import** — imports a single Excel file from the Selection & Screening Team,
  auto-creates structured records for accepted participants.
- **Accepted Participants Database** — centralized profiles: personal details, country,
  affiliation, interests, accessibility/dietary requirements, language preferences.
- **Participant Confirmation** — participants confirm attendance, decline, or update info, with
  real-time confirmation-status tracking.
- **Programme & Agenda Management** — centralizes session info: titles, timings, venues, tracks,
  formats, speakers, capacities, eligibility, language, accessibility.
- **Session Preferences** — participants indicate preferred sessions/themes/interests.
- **Smart Session Allocation** — automated initial allocation from preferences + capacity +
  eligibility + diversity, with admin review/adjust. *(Note: superseded/complemented by the
  self-booking model in §8 below — participants book their own sessions; allocation logic can
  still assist with waitlists/diversity balancing if desired.)*
- **Personal Participant Agenda** — live personalized schedule reflecting programme updates.
- **Digital QR Credential** — secure per-participant QR for check-in, session attendance, identity
  verification. See §9 for the exact code format.
- **Scanner Application** — browser-based PWA, no dedicated hardware/app install.
- **Attendance Management** — records check-ins and session attendance centrally, live visibility
  by session/venue/day.
- **Operations Dashboard** — real-time indicators: acceptances, confirmations, attendance,
  no-shows, session capacity, programme changes, with team-specific views.
- **Communication System** — automated status-based notifications + targeted messaging to
  participant groups.

### Participant Journey (existing, extended)

```
Selection Results Import → Accepted Participant Record → Confirmation → Session Preferences →
Session Booking (self-service, see §8) → Personal Agenda → QR Credential → Arrival/Logistics
Data Submitted → Event Check-in → Session Attendance → Post-Event Reporting
```

## 6. Explicitly Outside Scope (unchanged)

Unless separately agreed, the platform is **not** responsible for: UNFCCC or COP accreditation,
visa issuance, government immigration procedures, **flight booking**, **accommodation booking**,
financial transactions, or external travel management.

> **Important distinction for §7 (Arrival & Logistics Tracking):** the platform does not book
> flights or accommodation. It only collects and displays data about trips *already booked*
> (by the participant or the Organizing Team) so the Logistics team has visibility for reception
> planning. This is data collection / logistics coordination, not booking, and does not
> contradict the scope boundary above.

---

## 7. NEW MODULE — Local Info Hub

**Problem it solves:** at COY19, participants had to search Google Maps themselves for basic
needs (restaurants, pharmacies, hospitals) in an unfamiliar city, and often couldn't find urgent
handbook info quickly when they didn't have the file on hand.

**Spec:**
- An embedded map inside the platform (not a separate site), **geo-scoped to Antalya only**.
- Category filters: Restaurants, Historic/Heritage sites, Pharmacies, Hospitals.
- Place data is **populated automatically from Google Places API** (not manually curated).
- Alongside the map, a short "Quick Reference" panel pulling the most critical points from the
  Participant Handbook (emergency numbers, safety instructions, key contacts) — so participants
  aren't blocked if they don't have the full handbook PDF open. This is a curated excerpt, not
  the full handbook.

## 8. NEW MODULE — Venue Map Tab (Green Zone)

**Problem it solves:** the Green Zone is large (comparable to a COP venue) and participants get
lost.

**Spec (for this build phase):**
- Reserve a dedicated tab/route in the platform for the venue map.
- The actual map graphic will be produced later by the Comms team — for now, build the tab as a
  placeholder that can have the final map image/interactive map dropped in without restructuring
  the app.
- Each session row in the Personal Agenda (§9) links to this map, ideally deep-linking to/
  highlighting the specific room for that session.

## 9. NEW MODULE — Personal Agenda & Self-Service Session Booking

**Booking model:** participants **book their own sessions themselves** before the event
(self-registration, not organizer-assigned).

**Booking rules:**
- Every session has a **maximum capacity**; booking auto-closes once full.
- The platform **automatically prevents time-conflict bookings** — a participant cannot book two
  overlapping sessions.
- **Deadline:** booking for a session closes either a few hours before the session starts, or by
  11:59 PM the day before (exact rule configurable per session).
- **After the deadline:** self-booking is closed, but a participant may still join in person if a
  seat is physically open in the room (organizer/staff-managed, not a platform self-service
  action).
- **No self-cancel/edit after the deadline.**
- **Reminder:** each participant receives exactly one email reminder 30 minutes before each of
  their booked sessions, containing: session name, speaker, room number.

**Agenda UI:**
- List view. Participant selects a day (tab or list), and sees **only the sessions they
  personally booked** for that day — not the full conference agenda. This avoids information
  overload/confusion.
- Sessions are **color-coded by category/type** for quick visual scanning.
- Each session row is a simple table/list item showing:
  - Time range (start–end)
  - Room/hall name
  - Link to the full Green Zone map, pinpointing that room (§8)
  - QR code for that participant (see §10) used for attendance check-in at that session

## 10. Digital QR Credential — Code Format

Each participant is issued one **unique, persistent QR credential** (not one QR per session),
scanned by staff at the door of each session and at conference check-in.

**Code format:** `COY21-[TYPE]-[SEQ]`, e.g. `COY21-DEL-0001`

| Participant type | Code |
|---|---|
| Delegate | DEL |
| Volunteer | VOL |
| Knowledge Partner | KP |
| Youngo (mostly liaisons/facilitators) | YNG |
| Speaker | SPK |

- `[SEQ]` is a zero-padded sequential number (0001, 0002, …), **auto-generated at registration**
  per type.
- This same code is:
  - Printed on official documents (invitation letter, accommodation letter, visa support letter,
    etc.) as the participant's reference ID.
  - Encoded into the participant's QR credential.
  - The single identifier tying all systems together — one unified database, one source of
    truth.
- Per the original security model: QR codes should carry an encrypted identifier only and not
  expose personal data directly; validation happens server-side; duplicate-attendance scans are
  prevented; scans return real-time status (Valid / Already Checked In / Wrong Session /
  Invalid Credential).

## 11. NEW MODULE — Arrival & Logistics Tracking

**Problem it solves:** at COY19, organizers didn't know the reporting user's flight arrival time,
causing avoidable trouble picking him up from the airport.

**Spec:**
- A **mandatory** form/section unlocked as soon as a participant's ticket is booked — whether
  fully funded and booked by the Organizing Team, or self-booked (fully or partially funded).
- Participant uploads/enters: flight ticket (PDF upload option, especially for partially-funded
  participants who booked themselves), departure/arrival flight number, date & time, airport,
  and the same for any other trip legs (return, connecting flights).
- Data feeds a live dashboard/table for the Logistics team, sorted by arrival time, so airport
  reception can be planned and staffed accurately instead of ad hoc.
- **Automatic reminder** sent to any participant who hasn't yet submitted their arrival data
  (timing/threshold to be configured).
- This module does not book travel — see the scope note in §6.

Related fields (from accommodation/logistics side, to live in the same participant record):
- Accommodation details: hotel name, location, room number.
- Airport location info and shuttle times/timetable (downloadable/viewable).

## 12. Extended Participant Profile Fields

In addition to the fields already in the Accepted Participants Database (§5), the participant
profile/onboarding should capture:

**Personal Info**
- Photo, Nationality, Full name, Country of residence, Email, LinkedIn, Area(s) of interest
- Allergy info, Accessibility needs

**Documents** (upload/download center)
- Invitation Letter
- Accommodation Letter
- Flight ticket (with upload option for partially-funded/self-booked participants)
- Visa support letter
- Handbook 2026

**Emergency Contacts** — dedicated section, separate from general personal info.

**Agenda section (participant-facing)**
- Session registration/booking (§9)
- COY certificate (planned — not yet scoped; may later connect to attendance data from §10,
  decision deferred)
- Compliments / feedback form

---

## 13. Suggested Data Model (entities, high level)

This is a starting point for schema design, not a final ERD:

- **participants** — id, code (COY21-TYPE-SEQ), type, name, nationality, country_of_residence,
  email, linkedin, areas_of_interest[], allergy_info, accessibility_needs, photo_url,
  confirmation_status
- **documents** — participant_id, type (invitation/accommodation/ticket/visa/handbook), file_url,
  uploaded_by
- **emergency_contacts** — participant_id, name, relationship, phone, email
- **accommodation** — participant_id, hotel_name, location, room_number
- **travel_legs** — participant_id, leg_type (outbound/return/connecting), flight_number,
  departure_airport, arrival_airport, datetime, ticket_file_url
- **sessions** — id, title, description, category (for color coding), start_time, end_time,
  room_id, speaker, capacity, booked_count
- **rooms** — id, name, venue_map_ref (link/coords into the Green Zone map)
- **bookings** — participant_id, session_id, booked_at, status
- **attendance_scans** — participant_id, session_id or "check-in", scanned_at, scanned_by,
  result_status
- **places** (Local Info Hub) — sourced live from Google Places API, not stored long-term except
  as cache; category, name, location, geo-bounds = Antalya
- **handbook_excerpts** — short curated entries (title, body, category) shown in the Local Info
  quick-reference panel

## 14. Build Priorities (suggested phasing)

1. Core: participant DB, code generation (§10), document uploads, confirmation flow.
2. Agenda & Booking: sessions, capacity, conflict prevention, deadline logic, reminders (§9).
3. Attendance: QR credential + scanner PWA + real-time validation (§10, existing core module).
4. Arrival & Logistics Tracking (§11) + Logistics dashboard.
5. Local Info Hub (§7) + Venue Map tab placeholder (§8).
6. Operations Dashboard, Communication System, reporting (existing core modules).

## 15. Branding & Visual Identity

Two logo files are provided alongside this spec: `COY21_Logo_Primary.png` (full-color, for light
backgrounds) and `COY21_Logo_White.png` (reversed/white version, for dark backgrounds).

- **Mark:** a turtle icon (line art) containing a small mountain, a sprouting plant, waves, and a
  sun — paired with the "COY21 Türkiye 2026" wordmark.
- **Colors:**
  - Primary teal/dark teal (used for the turtle outline and most of the wordmark, including
    "COY" and "Türkiye 2026")
  - Accent orange (used for the sun accent in the icon and the "21" in the wordmark)
  - White (background / reversed logo use)
- Use the primary teal as the main UI color (buttons, headers, active states) and the orange as
  a sparing accent color (highlights, badges, calls to action) — consistent with the logo, not
  introducing new brand colors.
- Use the white/reversed logo only on dark or colored backgrounds; it will not be visible on
  white.

---

concept), extended through working sessions covering lessons learned from COY19 and a
participant-profile mind map.*
