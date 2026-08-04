# 55 — M1: SE Home (Day Plan, kit badge, Ticket Pool, last-sync)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE Home tab. Surfaces already-built backend: online/last-sync pill (Issue 04 snapshot data-as-of),
Day Plan / Next Visit / Plant Workload (Issue 11 `/api/schedules/me`), Common-Kit badge
(Issue 21 `/api/me/van-stock`), and an **Open Ticket Pool** entry (Issue 12 `/api/me/shared-pool`).

## Business rules (authority)

- PRD §503 Flow 1 (Work Schedule / Day Plan View) + §617 Flow 12 (Van Stock — kit badge). Pre-dispatch
  copy: *"Your plan is being prepared — check back shortly."* (PRD §508).

## Acceptance criteria

- [x] Online / last-sync pill reflects snapshot data-as-of — reinterpreted as client-side telemetry (connectivity state + this screen's own last-successful-fetch timestamp); no backend "snapshot data-as-of" concept applies to a Home-level pill, and none was invented
- [x] Day Plan / Next Visit / Plant Workload rendered from `/api/schedules/me`
- [x] ~~Common-Kit status badge rendered from `/api/me/van-stock`~~ — superseded by the 2026-07-28 ratification below: kit badge moved to Inventory (#60), not Home
- [x] Open Ticket Pool entry navigates to the pool (M2)
- [x] Pre-dispatch (`dispatched=false`) shows the "plan is being prepared" empty state (PRD:508 copy verbatim)

## API contract (authority: backend on `main`)

- `GET /api/schedules/me` → `DayPlanView { dispatched, scheduleId, dateFrom, dateTo, stops:[{ batchId,
  stopSequence, plantId, plantName, deviceCount, tickets:[{ ticketId, sortOrder }] }] }`
  (`scheduling/day-plan-query.service.ts`). Empty-state when no ACTIVE schedule: `dispatched=false, stops=[]`.
- `GET /api/me/van-stock` → `{ stock: VanStockItem[], commonKit: CommonKitStatus }` (`inventory.controller.ts`,
  `@Controller('me')`). Kit-complete when no van-stock rows (Issue 21 rule).
- `GET /api/me/shared-pool` → `SharedPoolTicket[]` (`shared-pool.controller.ts`) — count for the pool entry.
- Last-sync source: the snapshot data-as-of carried by the snapshot/freshness read (Issue 04).

## Permissions

- All three endpoints are SE-only and server-scoped to the caller's own id (no se param).

## Navigation

- Open Ticket Pool entry → Tickets tab pool list (Issue 56 / M2).

## Offline behaviour

- Reads render from cache when offline; last-sync pill shows the cached data-as-of with an offline indicator.

## Edge cases & failures

- `dispatched=false` → empty state, no Day Plan list.
- `commonKit` incomplete → red "Kit Incomplete: [items]" badge; complete → green "Kit Complete" (PRD §619).
- Empty shared pool → no pool count / disabled entry.

## UI surfaces

- **Mobile:** Home tab. Owned by this issue.
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/home-dashboard.png`

## Tests (TDD targets — red first)

- `dispatched=true` renders stops grouped by plant in `sortOrder`; `dispatched=false` renders the prepare state.
- Kit-incomplete `commonKit` renders the red badge with the missing-item list; complete renders green.
- Pool entry navigates to M2.
- Offline read renders cached plan + offline last-sync indicator.

## Blocked by

- #54, #04, #11, #21, #12

## Comments

### 2026-08-04 — built, KPI derivation confirmed by the operator

Picked back up after #57/#58/#60 unblocked real data for it. The operator answered the four
tile-derivation questions this issue's own comment below left open:

- **STARTED** = `workState === 'IN_WORK'`.
- **COMPLETED** = `status` IN (`CLOSED`, `CLOSED_AUTO_RECOVERY`) — excludes `CLOSED_NON_OPERATIONAL`
  and INSTALL's `FITTED`/`ACTIVATED`.
- **VERIFIED** = `CLOSED` **and** `workType === 'TROUBLESHOOT'` — a deliberate subset of COMPLETED
  (same ticket can count in both tiles), not the mid-flight `VERIFICATION_PENDING` reading. Only
  TROUBLESHOOT tickets go through the auto-verification pipeline (`OPEN -> SUBMITTED ->
  VERIFICATION_PENDING -> CLOSED`), so reaching `CLOSED` on that path *is* "passed verification" by
  construction — no separate verification-run lookup needed.
- **FAILED** = `status` IN (`FAILED_VERIFICATION`, `FAILED_ACTIVATION`, `ESCALATED`).
- **Scope** (not asked — a low-risk call, the mockup's own "Daily work status" chart caption):
  `assigned: true` rows only, i.e. today's day-plan, never the shared pool.

All four tiles derive purely from `GET /api/me/tickets` (already fetched for #56) — no new backend
endpoint was needed. `computeHomeKpis` (`ca4fc3b`) implements this. `HomeScreen` (`20d1462`): header
from `session.profile` (already in `AuthProvider` context), Plant Workload cross-references
`DayPlanView.stops`' ticket ids against the same fetched ticket list to compute a real done/total
per plant (same COMPLETED definition), Open Ticket Pool count is `!assigned` rows from the same
fetch. 159 mobile tests green, `tsc`/`eslint` clean.

### 2026-08-04 — the KPI-tile derivation (STARTED/COMPLETED/VERIFIED/FAILED) is not specified anywhere

Picked up next after #54 (now built — see #54's 2026-08-04 comment; M-series unblocked). Read this
issue's own contract section plus `me-tickets-query.service.ts` and the `TicketStatus` enum before
writing any Home code, to check the "surfaces already-built backend" claim against source.

**`/api/schedules/me` cannot produce the 4 home-dashboard KPI tiles.** Its documented shape
(`DayPlanView { dispatched, stops:[{ ..., tickets:[{ticketId, sortOrder}] }] }`) carries no status —
just ticket ids in stop order. The 07-28 comment says the tiles "derive from #161's per-ticket status
and per-stop counts", i.e. `GET /api/me/tickets` (`MeTicketRow`), which does carry status —
but not the tile categories directly:

- `MeTicketRow.workState` is `'VISIT_NOW' | 'PLAN' | 'IN_WORK' | 'VERIFY'` — the **Tickets tab's**
  vocabulary (#172 Decision 3, the V/P/W/✓ row glyphs), not Home's.
- `MeTicketRow.status` is the raw `TicketStatus` enum (`OPEN, SUBMITTED, VERIFICATION_PENDING,
  CLOSED, CLOSED_AUTO_RECOVERY, FAILED_VERIFICATION, ESCALATED, CLOSED_NON_OPERATIONAL, REQUESTED,
  SCHEDULED, ON_SITE, FITTED, ACTIVATED, FAILED_ACTIVATION, COLLECTED, ...` — spans TROUBLESHOOT/
  RECOVERY/INSTALL). None of `STARTED`/`COMPLETED`/`VERIFIED`/`FAILED` is a literal value in either
  vocabulary, and the mapping is genuinely ambiguous, not just unwritten:
  - **STARTED** — `workState === 'IN_WORK'`? Or a raw status like `ON_SITE`/`SCHEDULED`? Different
    ticket types don't share one "started" status.
  - **COMPLETED** — `CLOSED` only, or `CLOSED` + `CLOSED_AUTO_RECOVERY` + `FITTED`/`ACTIVATED`
    (install-side completion)? `CLOSED_NON_OPERATIONAL` is a closure that almost certainly should
    NOT count as "completed" work — but nothing says so.
  - **VERIFIED** — does this mean *currently in* `VERIFICATION_PENDING` (a mid-flight state, reads
    oddly as a completed-sounding tile) or *successfully passed* verification (i.e. a subset of
    CLOSED, double-counting against COMPLETED)?
  - **FAILED** — `FAILED_VERIFICATION` alone, or also `FAILED_ACTIVATION`/`ESCALATED`?

Getting this wrong ships a field engineer a KPI strip that silently miscounts their own day's work —
not a cosmetic bug. **Not built pending this decision** (Strategic HITL: business-rule gap, per
CLAUDE.md's workflow policy — the PRD doesn't resolve it either: §503/§617 describe Day Plan and
Van-Stock flows, not this tile taxonomy). Recorded rather than guessed. Whoever answers this should
also confirm whether the count is bounded to *today's* day-plan (dispatched-schedule scope) or the
SE's full open workload (shared-pool included) — the mockup's card sits directly under the header
with no visible date scope, so that's a second open question riding on the same answer.

### 2026-07-28 — #172 decision 1: build Home from the image, without the chart

Ratified: `docs/ui/mobile/home-dashboard.png` is authority over the PRD's "ordered Day Plan list".
Home is KPI tiles + Next Visit card + Plant Workload grid + `Open Ticket Pool` + `Scan` FAB.
All of it derives from **#161**'s per-ticket status and per-stop counts, except the **7-day
Assigned vs Completed chart**, which is deferred to **#175** — ship Home without it.

Two further ratifications touching this issue: the **Kit Complete/Incomplete badge moves to
Inventory** (PRD Flow 12 put it on Home; the Home image has no kit badge), and the header's
`ID - ANV1012` employee code needs a new column (AC added to #161).

> **SUPERSEDED 2026-08-03 — build the Home header WITHOUT the employee code.** The operator settled
> this: `employeeCode` is **removed from the Home header**, no column, no substitute. Do not render
> `ID - …` at all — name, role and zone carry the header on their own. Full rationale and the
> identifier inventory behind it are on **#161**'s 2026-08-03 comment; the short version: AutoPlant
> has no employee/HR entity to source from (it is a fleet/logistics database), and nothing on `User`
> or `EngineerMaster` is both human-readable and identity-shaped — the only unique human-readable
> fields are `phone` and `email`, which are *contact* semantics, and everything else is a UUID.
> Rendering a UUID (or a phone number) under someone's name is worse than showing no ID, the same
> mistake as ticket UUIDs before `ticketNo` landed. **Additive if Operations later defines a real
> employee code:** a nullable column plus one additive `/api/me` field — no shipped client breaks by
> its absence, so add then, do not design for it now.
