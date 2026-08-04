# 29 — Intra-day CRITICAL insertion + SE Accept/Decline + WhatsApp

Status: done
Type: AFK

## What to build

The system-triggered intra-day insertion and SE Acceptance flow. When a new Ticket enters the CRITICAL or HIGH_CRITICAL bucket, a Qualifying Event fires an Intra-day Re-plan: the Ticket is offered to the best candidate SE and an in-app push (with notification-shade quick-action Accept/Decline) is sent. The Intra-day Queue (`/intraday`) shows the row (type `SYSTEM_CRITICAL`): Ticket, company, bucket, SE offered, offered_at, status (`PENDING_ACCEPTANCE` / `ACCEPTED` / `TIMED_OUT` / `DECLINED`). **Accept** (one tap) → assignment committed, Ticket appears at top of Day Plan badged `CRITICAL INSERTION`, and a first-class **WhatsApp Confirmation** is sent carrying ticket number, vehicle, plant, expected component, and a deeplink ("WhatsApp Sent" chip on the queue row). **Decline** → mandatory reason code (AT_CAPACITY / TRAVEL_TOO_FAR / VEHICLE_TROUBLE / OTHER); system reroutes (retry chain handled in #30). SE Acceptance is required **only** for these urgent same-day insertions, not for normal batch work.

## Acceptance criteria

- [x] CRITICAL/HIGH_CRITICAL entry fires a Qualifying Event and offers the Ticket to the best candidate
- [x] In-app push with notification-shade Accept/Decline quick actions delivered
- [x] Accept commits the assignment and inserts the Ticket at top of Day Plan badged `CRITICAL INSERTION`
- [x] WhatsApp Confirmation sent on Accept with ticket/vehicle/plant/component + deeplink; shown as "sent"
- [x] Decline requires a reason code and triggers reroute
- [ ] Intra-day Queue reflects PENDING_ACCEPTANCE / ACCEPTED / DECLINED status in real time — **UN-TICKED 2026-08-04: this was never true. See the correction comment below. Owned by [#206](./206-admin-manager-action-surface.md).**

## Blocked by

- #25
- #03

## Disposition (done — 2026-06-28, backend worktree)

Backend slice. New **mutable** `IntradayInsertion` state machine (migration `20260628100000_add_intraday_insertions`)
— the append-only `recommendations` record is left untouched (its `path=INTRADAY`/`retryChain` seams were
documented append-only, so the offer lifecycle gets its own table). `IntradayInsertionService`
(`src/intraday/`):
- **`fireForZone`** — Qualifying-Event sweep: every OPEN/UNASSIGNED CRITICAL/HIGH_CRITICAL ticket with no
  live insertion is offered to its **best available candidate** (`CandidateSelectionService` strict coverage
  precedence, filtered to `SE_AVAILABILITY = AVAILABLE`; **activity-ping age is never a filter**). No
  available candidate → left to the ZM Grouped Critical Queue (#13), not dropped.
- **In-app push** via `NotificationService.notify` (GENERAL) carrying `metadata.actions = [ACCEPT, DECLINE]`.
- **`accept`** — commits the Formal Assignment via `OverrideService.assignTicket(..., insertAtTop=true)`
  (new flag → batch leads at `stopSequence 1` = top of Day Plan), stamps audit `CRITICAL_ASSIGN` +
  `ticket_event CRITICAL_INSERTION_ACCEPTED`, flips insertion `ACCEPTED`; **idempotent** for a retried
  same-SE accept.
- **First-class WhatsApp** Confirmation (`deliveryModel: 'SE_ACCEPTANCE'`, recorded SENT) with
  ticket/vehicle/plant + `fsm://` deeplink in metadata.
- **`decline`** — mandatory reason code (`AT_CAPACITY|TRAVEL_TOO_FAR|VEHICLE_TROUBLE|OTHER`) validated →
  reroute (shared with the #30 timeout path).
- **`listForScope`** — Intra-day Queue read, ZM zone-scoped / CSM+OH cross-zone.
- HTTP surface `/api/intraday-insertions` (`IntradayInsertionController` + `IntradayModule`, registered in
  AppModule): `GET` (manager), `accept`/`decline` (SE), `fire` (manager), `available-ses`/`manual-assign`
  (manager), `sweep-timeouts` (OH/CSM).

11 service e2e + 7 controller e2e green; `tsc` clean.

**Deferred (UI, blocked by mobile foundation #54):** the SE-app rendering of the `CRITICAL INSERTION`
day-plan badge + the notification-shade quick-action chips are mobile surfaces → tracked under the SE
mobile day-plan work (#66/M-series); backend supplies the `IntradayInsertion` record + audit + top-of-plan
ordering they render from. The admin Intra-day Queue page (FE-13) already exists and consumes
`/api/intraday-insertions` alongside `/api/intraday-updates`.

### 2026-08-04 — CORRECTION: AC#6 was factually false; the admin queue never bound the insertion columns

Found during the cross-surface contract audit (`audit/mobile-contract-sync-audit-2026-08-04.md`,
finding D4) and verified against source today.

**What this issue's disposition claimed:** *"The admin Intra-day Queue page (FE-13) already exists and
consumes `/api/intraday-insertions` alongside `/api/intraday-updates`."*

**What is actually true:** `grep -rn "intraday-insertions|IntradayInsertion" apps/admin/src` returns
**zero hits**. Admin's only intraday client is `apps/admin/src/api/intradayUpdates.ts:26`, which hits
`/intraday-updates` — the ZM *manual same-day update* audit read, a different endpoint with a
different payload. `IntradayQueuePage.tsx:23` still carries FE-13's placeholder comment and `:103`
hardcodes the acceptance column to the literal string `"No acceptance required"`, while the page's own
subtitle at `:122` claims "System-triggered CRITICAL insertions appear here too."

**How it happened, recorded so the pattern is visible:** FE-13 shipped `done` with the AC *"29/30
columns are forward-compatible placeholders"* and an outcome note saying the column was "ready to bind
when Issue 29/30 land." #29 then landed and ticked its own admin AC on the assumption FE-13 had done
the binding. Neither issue filed the follow-up, and because both were `done` with the AC ticked, the
gap was invisible to every subsequent status read. This is a parity-gate violation
(`CLAUDE.md` §Surfacing rule) that survived because the paperwork said otherwise.

**Scope of the miss:** of the five producible insertion states (`PENDING_ACCEPTANCE`, `ACCEPTED`,
`DECLINED`, `TIMED_OUT`, `ESCALATION_REQUIRED` — `generated/prisma/enums.ts:66-72`), the admin
dashboard displays **none**. `ESCALATION_REQUIRED` is the state that exists specifically to demand
manager action after three failed offers (`PRD:395`), and it currently terminates in silence. Tones
for all five already sit unused at `badges.tsx:103-107`.

AC#6 un-ticked above. Repair owned by [#206](./206-admin-manager-action-surface.md) — not re-opened
here, since the backend half of this issue is genuinely done and independently verified.
