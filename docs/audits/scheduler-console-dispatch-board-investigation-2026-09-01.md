# Scheduler Console → dispatch board: investigation before any code

**Date:** 2026-09-01 · **Branch:** `feat/autoplant-integration` · **Status:** investigation only, nothing implemented.

> **Revised 2026-09-01, same day, after an independent verification pass.** Every load-bearing claim
> below was re-checked against the code by a second session. Three were wrong or overstated and have
> been corrected in place: the third screenshot **is** in the repo (§5 Risk 7), and Risk 5's regression
> surface is **narrower** than first written — engineer *selection* already exists on the board and
> survives the deletion, while a click-to-inspect affordance the first pass missed does not (§5 Risk 5).
> Corrections are marked **[corrected]**. Everything not so marked was verified and stands.

Scope: what would have to change to turn the Scheduler Console (`/dispatch/today`) from a technical
assignment table into a dispatcher-readable board — one engineer column, day columns, full work cards,
domain-driven status colour. This document answers Phase A and Phase B (data contract) of the request.

---

## 1. The real implementation — file map

Nothing below is assumed; every path was read.

### Frontend (`apps/admin`)

| Concern | File |
|---|---|
| Page shell / composition | `src/pages/dispatch/TodaysDispatchPage.tsx` (744 ln) — the 3-column grid is one line: `xl:grid-cols-[15rem_minmax(0,1fr)_20rem]` at **:568** |
| The one lifted fetch | `src/pages/dispatch/console/useConsoleData.ts` — `GET /dispatch/today` + `GET /dispatch/changes-today`, `invalidate()` after every write |
| Non-today day data | `src/pages/dispatch/console/useDayContext.ts` — `GET /schedules?date=&detail=stops` (all non-today columns) + `GET /schedules/preview?date=` (**focused future column only**) |
| Day semantics | `src/pages/dispatch/console/dayAxis.ts` — `semanticOf()` → `past` \| `today` \| `future`; `visibleDays()`; `dayLabel()` |
| The board | `src/pages/dispatch/console/BoardGrid.tsx` (759 ln) — `DayHeader` **:358**, `CommittedChip` **:322**, `EngineerRow` **:455**, `BoardCell` **:527** |
| Duplicate engineer list | `src/pages/dispatch/console/PeopleRail.tsx` (155 ln) |
| Ticket chip | `src/pages/dispatch/console/WorkChip.tsx` — `ChipDragPayload` **:78**, `WorkChip` **:94**, `GhostChip` **:198**, `GrammarLegend` **:223** |
| Drop legality (single predicate) | `src/pages/dispatch/console/dropTargets.ts` — `dropAction(payload, seId, day, today)`, `intentFor()` |
| The only write path | `src/pages/dispatch/console/ActionsBand.tsx` (1146 ln) — `ActionPrefill` **:68**, `TicketActions`, `StopActions` |
| Selected-object detail | `src/pages/dispatch/console/Inspector.tsx` (716 ln) — already calls `apiTicketDetail(ticketId)` at **:431** |
| Work Pool | `src/pages/dispatch/console/WorkRail.tsx` (341 ln) — tabs Unassigned / Held / Changes + chronic toggle |
| Assign mode (separate region) | `console/AssignMode.tsx`, `console/AssignBoard.tsx` — has its **own** `assign-people-rail` |
| Capacity badge (7 surfaces) | `src/components/ui/LoadBadge.tsx` + `src/lib/capacity.ts` |
| API clients | `src/api/dispatchToday.ts`, `src/api/schedules.ts`, `src/api/schedulerPreview.ts`, `src/api/tickets.ts` |

### Backend (`apps/backend`)

| Concern | File |
|---|---|
| Console read endpoint | `src/scheduling/dispatch-today.controller.ts` — `GET /dispatch/today`, zone clamp in `parseZoneId()` |
| Console payload builder | `src/scheduling/dispatch-today-query.service.ts` (618 ln) |
| The one definition of "committed" | `src/scheduling/committed-day-load.ts` → `committedDayPlan()` **:80** |
| The six overrides (all writes) | `src/scheduling/override.service.ts` (1383 ln) |
| `GET /schedules` | `src/scheduling/zm-schedule-query.service.ts` |
| `GET /schedules/preview` | `src/scheduling/scheduler-preview.service.ts` |
| Ticket read w/ full identity | `src/ticketing/ticket-query.service.ts` — raw SQL, `SELECT_COLUMNS` **:162**, `FROM_JOINS` **:186** |
| "reached in-app during this assignment" idiom | `src/ticketing/special-ticket.query.ts` (#244) |
| Troubleshooting state | `src/soft-state/` — `activity-status.ts`, `soft-state.service.ts`, `soft-state-conflict.adapter.ts` |
| Scheduling↔soft-state port (already exists) | `src/scheduling/soft-state-conflict.ts` — `SoftStateConflictPort.activeOnSiteTicketIds()` |
| Thresholds | `src/settings/assignment-threshold.ts`, `src/settings/settings.service.ts` (`SETTINGS_DEFAULTS`) |

---

## 2. The complete flow, as built

```
engineer_master (isActive, zoneId)  ──┐
work_schedules (dateFrom<=day<=dateTo, live)
  └ plant_batch_assignments (AUTO_ASSIGNED|OVERRIDDEN)
      └ batch_assignment_tickets (removedAt: null)
          └ tickets → device_states.sla_bucket
committedDayPlan(prisma, day, {seIds})  ── the ONLY load definition
se_availability (window covering now)
                                       │
        DispatchTodayQueryService.today() ── decides nothing, joins only
                                       ▼
              GET /dispatch/today  (never takes a date — always istDate(now))
                                       ▼
       useConsoleData()  ── one fetch, every region reads it, invalidate() on write
                                       ▼
   PeopleRail (engineers[])    BoardGrid (engineers[] × days[])    WorkRail (rails)
                                       ▼
                    drag → dropTargets.dropAction() → ActionPrefill
                                       ▼
              Inspector / ActionsBand → POST /batches/:id/override
                                       ▼
                     OverrideService → invalidate() → refetch
```

Non-today columns do **not** come from this payload:

- **past + future** → `apiListSchedules(day, 'stops')`, filtered client-side to the zone
- **focused future only** → `getSchedulerPreview(day)` → `ZoneProjection`

---

## 3. Answers to the specific questions asked

**Which UI is duplicated / which is canonical.** `PeopleRail.tsx` and `BoardGrid.EngineerRow` render
the *same* `view.engineers[]` array. There is only ever **one** engineer dataset and one fetch — the
duplication is purely presentational, so removing the rail cannot desynchronise anything — verified at
`TodaysDispatchPage.tsx:573` and `:597`, which pass the *same* `engineers` variable to both. `AssignMode`
has a third engineer list (`assign-people-rail`), but it replaces the whole board region and is out of
scope.

**[corrected] The duplication runs deeper than the array, and that is good news.** Engineer *selection*
and the *load badge* are duplicated too: the board's `lane-<seId>` button already selects the engineer
and already renders `LoadBadge` (`BoardGrid.tsx:487-501`). Only the coverage pill, the stops/devices
line and the drop handlers exist solely on the rail. The board column is therefore already ~60% of the
canonical personnel cell, which is why Part 3 is a small change rather than a new component. See Risk 5.

**Which state belongs to the scheduler vs. the ticket.** Scheduler-owned: `work_schedules`,
`plant_batch_assignments` (incl. `status: OVERRIDDEN`), `batch_assignment_tickets` (`add_source`,
`added_by`, `coverage_type_at_assign`, `removed_at`, `removal_reason`, `deferred_to_date`).
Ticket-owned: `tickets.*`, `device_states.*`, `soft_states`, `troubleshooting_submissions`,
`failure_cycles`.

**How drag/drop works.** `WorkChip` / stop button / pool row sets `dataTransfer[DRAG_MIME]` to a
`ChipDragPayload = {type:'ticket'|'stop'|'pool', ticketId?, batchId?, fromSeId?}` and lifts the same
object into React state. Both drop surfaces (`BoardCell`, `PeopleRail`) call the *same*
`dropAction(payload, seId, day, today)`. **Nothing is written on release** — the drop sets a
`DropIntent` (`{sel, prefill}`), the Inspector opens on `sel`, prefilled. Matrix in `dropTargets.ts`:
ticket→today/other SE = `REASSIGN`; ticket→future (any SE) = `MOVE_TICKET` carrying `newSeId` **and**
`targetDate`; pool→today = `ASSIGN`; stop→today/other SE = `SWAP_SE`; everything else is refused by
*never becoming a drop target*.

**How adjusted assignments work.** `ADJUSTED` is **stop-level**, not ticket-level:
`stop.status === 'OVERRIDDEN'` → `<Badge tone="warning">adjusted</Badge>` in `BoardGrid`.
`BoardGrid` carries a long comment explaining that the moved ticket is *gone* from the stop
(`removedAt` filter) and the badge marks only the surviving stop.

**How dates work.** IST operating-day strings (`YYYY-MM-DD`) from the server; **no `new Date()`
reading of the browser clock**. `dayAxis.addDays` does UTC calendar math. `GET /dispatch/today` is
never given a date by design.

**Historical / live / future / committed.** Past = counts only (`batchCount`/`ticketCount`), immutable
by construction. Today = full fidelity, the only mutable column. Future = committed rows win over the
projection (`futureBadge()` at `BoardGrid.tsx:290`); otherwise ghost chips from the preview, with a
`bucketsAsOf` watermark and no write affordances.

**How troubleshooting state is represented.** `soft_states` — `SoftStateType` = `VIEWED` → `ON_SITE`
→ `TROUBLESHOOT_STARTED`, advancing resolves the prior. Active ⟺ `resolvedAt IS NULL`.
`TROUBLESHOOT_STARTED` is the canonical "SE has started work". **It is currently invisible to the
Console** — `DispatchTodayQueryService` never reads `soft_states`.

**How inactivity is calculated.** `device_states.inactivity_hours` (nullable `Decimal`), derived by
`DeviceStateService.recompute` from `latest_gps_datetime` against `inactivity_threshold_hours`
(default 24). Precedent for reading it inside scheduling already exists:
`assignable-work-query.service.ts:98-105` (`Number()` the Decimal; **null ≠ 0** — "never recomputed"
must not render as "just now").

**How engineer capacity is calculated.** `committedDayPlan()` — the *same* function dispatch enforces
against. The Console must never re-sum from visible stops; `PeopleRail`'s docblock says so explicitly.
`overCapacity = committed >= dailyCapacity` (`>=`, matching the engine's `OVER_CAPACITY` filter).

**How Dedicated / Multi Plant is determined.** `engineer_master.coverage_type` — enum
`DEDICATED | MULTI_PLANT | FLOATING`. Already on the wire as `TodayEngineer.coverageType` and already
rendered in `PeopleRail` as a Badge. **Three values, not two** — `FLOATING` is a real population
(territory-polygon SEs, `EngineerTerritoryCoverage`).

**All engineers in the zone.** Already satisfied server-side:
`engineerMaster.findMany({ where: { isActive: true, zoneId } })` — the roster is built first and lanes
are mapped over *it*, so an engineer with no schedule still gets a lane with `committed: 0` and
`stops: []`. Nothing filters by having work. The only narrowing is the client-side find box
(`TodaysDispatchPage.tsx:260`), which is a user action.

---

## 4. Data contract: what exists, what is missing

### Engineer — **complete today**, except the avatar

| Field asked for | Status |
|---|---|
| `id` / `name` | `TodayEngineer.seId` / `.name` (from `users.name`) ✅ |
| `capacity` / `assignedCount` | `.dailyCapacity` / `.committed` (from `committedDayPlan`) ✅ |
| `stopCount` / `deviceCount` | derivable from `.stops` (already done in `PeopleRail`) ✅ |
| `type` (Dedicated / Multi Plant) | `.coverageType` ✅ |
| `zone` | implicit — the payload is zone-scoped ✅ |
| `avatar` | **DOES NOT EXIST.** `users` has no photo column; `engineer_master` has none; `media_objects` is `kind ∈ {TROUBLESHOOT, VOUCHER, INSTALL}` with slots `BEFORE/AFTER/PART/PLATE/RECEIPT/PHOTO/BILL/INSTALL_PHOTO` — no profile slot. |

→ **Zero backend change for the engineer column.** The avatar must be a deterministic initials
fallback (precedent: `TopBar.tsx:73` already computes brand-tinted initials). Do not add a photo
column for a cosmetic requirement.

### Ticket / work card — **six of eight fields are not on the wire**

`TodayTicket` today: `ticketId, sortOrder, slaBucket, companyTier, addSource, addedBy, addReason,
coverageTypeAtAssign, systemPlaced, returnDueToday, failureCycles`.

| Field asked for | On `/dispatch/today`? | Where it lives |
|---|---|---|
| Device | ❌ | `tickets.device_id` |
| Vehicle | ❌ | `vehicles.vehicle_no` via `tickets.vehicle_id` |
| Plant | ⚠️ stop-level only (`TodayStop.plantName`) | `plants.name` |
| Company | ❌ (only `companyTier`) | `company_master.name` via `tickets.company_id` |
| Transporter | ❌ | `transporters.name` via `vehicles.transporter_id` |
| Inactive hours | ❌ | `device_states.inactivity_hours` |
| Troubleshooting status | ❌ | `soft_states.type = TROUBLESHOOT_STARTED`, `resolved_at IS NULL` |
| Adjusted | ⚠️ stop-level (`TodayStop.status === 'OVERRIDDEN'`) | `plant_batch_assignments.status` |

**The join already exists and is already correct**, in `ticket-query.service.ts`:

```sql
LEFT JOIN device_states ds ON ds.device_id = t.device_id
JOIN      plants p         ON p.plant_id   = t.plant_id
LEFT JOIN company_master c ON c.company_id = t.company_id
LEFT JOIN vehicles v       ON v.vehicle_id = t.vehicle_id
LEFT JOIN transporters tr  ON tr.transporter_id = v.transporter_id
```

`MeTicketsQueryService` proves the same shape works through Prisma `include` for the SE app
(`plant.name`, `company.name`, `vehicle.vehicleNo`, `device.state.slaBucket`, `activeSoftState`) — it
is missing only `transporterName` and `inactivityHours`.

→ **This is an enrichment, not a new DTO.** One batched query over the payload's `ticketIds`, in the
style of the existing `bucketByTicket` / `returnDueToday` / `availabilityBySe` private helpers, filling
fields seeded on `TodayTicket`. No algorithm, no schema, no migration.

### Status semantics — needs a *new* published field and a *chosen* threshold

The requested tri-state does not exist anywhere. It decomposes into two facts and one policy:

```
troubleshootingStarted := EXISTS soft_states s
                          WHERE s.ticket_id = t AND s.resolved_at IS NULL
                            AND s.type = 'TROUBLESHOOT_STARTED'
age                    := device_states.inactivity_hours   (or assignment age — see Risk 3)
threshold              := ???                              (see Risk 3)
```

`activityStatus` (ADR-0023, `soft-state/activity-status.ts`) is the **engineer's** display label
(`BUSY` when any TROUBLESHOOT_STARTED is held) — not a per-ticket state. It cannot be reused directly,
but its precedent is exactly right: *derived at render time, never stored*. The new field should be a
sibling of it — a pure function over inputs the query already loads, in the domain layer, published as
`actionStatus: 'IN_PROGRESS' | 'NOT_STARTED' | 'AGING_UNTOUCHED'`, with the threshold published
alongside it so the client never re-derives the rule.

---

## 5. Risks and conflicts found — read before designing

### Risk 1 (bug, pre-existing) — `chronicThreshold` is never sent, and `failureCycles` is always null

`apps/admin/src/api/dispatchToday.ts` declares `chronicThreshold: number` as required and
`TodayTicket.failureCycles`. The backend `DispatchTodayView` **has neither**: it returns no
`chronicThreshold`, and both `failureCycles` sites are hardcoded `null`
(`dispatch-today-query.service.ts:307` and `:523`), next to a comment referring to an
`attachFailureCycles` function **that does not exist in the repo**. Same in `HEAD`, not just the
working tree.

Consequence: `chronicThreshold` is `undefined` on the wire, so `failureCycles != null && >= undefined`
is always false — the `CHR ×n` token can never light and the Work Pool's chronic filter can never
match. It is green only because all six admin test fixtures hand-write `chronicThreshold: 3`, and no
backend test asserts the field. This is the exact "server owns the rule, client never hard-codes it"
precedent the new status threshold is supposed to follow — so it should be fixed in the same slice, or
the new field will inherit the same silent hole.

### Risk 2 — one reusable card cannot be rendered on all four column moods

Part 22 asks for one `TicketCard` used across history / live / future / committed. The other three
sources cannot feed it:

- `GET /schedules?date=&detail=stops` returns `{ticketId, sortOrder, addSource, addedBy,
  coverageTypeAtAssign, systemPlaced}` — **no device, vehicle, company, transporter or inactivity.**
- `GET /schedules/preview` returns `plan[].plants[].ticketIds` — bare id strings.
- Past columns return counts only, by deliberate design (`BoardGrid` §6.3 rule 5).

So either the component renders a documented reduced variant per mood (honest, matches the existing
"each column renders at the fidelity its source can honestly answer" rule, no backend change), or
`GET /schedules?detail=stops` grows the same enrichment (more work, and it widens a read used
elsewhere). **Recommendation: one component, an explicit `variant` prop, full fidelity on today only.**
Silently drawing a full card with five blank rows on a past column would be the same class of lie the
codebase's provenance grammar exists to prevent.

### Risk 3 — "the aging threshold" does not have one existing answer

Three candidate rules exist, and they mean different things:

| Key | Default | Meaning |
|---|---|---|
| `inactivity_threshold_hours` | 24 | *Measurement.* Sets `is_inactive`, the Fleet-Uptime denominator, the Soft Inactive Count zones are graded on. `assignment-threshold.ts` states in as many words that it must **not** be moved for dispatch reasons. |
| `se_assignment_threshold_hours` (#238) | 24 | *Dispatch.* When silence becomes an SE's problem. Ladder-constrained to `SLA_BANDS` lower bounds. Already used by the tickets queue's `HELD · n/24h` badge (`ticketBadges.tsx:41`). |
| `troubleshoot_started_stale_warning_hours` | 2 | *Stale work.* An SE holding TROUBLESHOOT_STARTED too long — the opposite population. |

None of them means "assigned, untouched too long". Reusing `se_assignment_threshold_hours` is the
closest honest fit **but** its clock is device silence, which starts long before the ticket was
assigned — a ticket dispatched at hour 30 against a 24 h threshold is `AGING_UNTOUCHED` the instant it
lands, so on the default nearly every red would be yellow. **This is a business-rule decision and needs
the operator, not a default.** The two candidate clocks:

- **device silence** — `device_states.inactivity_hours` (what "Inactive 18h" on the card shows), or
- **time since assignment** — `batch_assignment_tickets.created_at`, which is what "untouched too
  long" actually reads as, and which #244 already treats as the attempt window's start.

### Risk 4 — the colour vocabulary is already spent

`index.css` carries an explicit comment: *"Amber is over-capacity and crimson is critical — never the
same colour for two changes."* Concretely, today:

- **crimson / `--color-critical`** = CRITICAL+ SLA bucket (the `CRIT` token)
- **amber / `--color-warning`** = at/over capacity (`LoadBadge`, seven surfaces; and the amber board
  cell in `BoardCell`)
- **violet / `--color-tier-cross`** = a human crossed a coverage tier
- **border style** = provenance (solid+dot engine · dashed human · dotted unrecorded)

Painting cards red / yellow / green for action status collides head-on with the first two — #290 was a
whole slice spent fixing exactly this collision. The card can carry the tri-state without breaking it
(a left status rail plus a word, in the `RET` / `CHR` token idiom), but the mapping must be decided
deliberately, and the four existing channels have to survive or be consciously retired.

### Risk 5 — removing `PeopleRail` loses a drop target and a coverage pill, but not selection

**[corrected]** The first pass framed this as "the engineer cell must be rebuilt or the drag fix
regresses." That overstated it. What column 1 already has, and what it genuinely lacks, is now separated.

**Already on the board, and free.** `BoardGrid.EngineerRow` renders the name as a real button — test id
`lane-<seId>`, with `aria-pressed` and an `onClick` selecting `{kind:'engineer', id: seId}` — and a
`LoadBadge` beneath it (`BoardGrid.tsx:487-501`). So engineer
**selection** and the **committed/capacity badge** are *already* duplicated between the rail and the
board, and both survive the rail's deletion untouched. Part 3 is therefore mostly a **move**, not a build.

**What column 1 does not have, and must inherit:**

| Lost with the rail | Where it must land |
|---|---|
| `onDragOver` / `onDrop` → `dropAction(payload, seId, today, today)` (`PeopleRail.tsx:100-119`) | the `lane-` cell — **call the same predicate, never a copy** |
| The coverage-type pill (`DEDICATED` / `MULTI_PLANT` / `FLOATING`) | the new personnel cell (Part 3 asks for it anyway) |
| The `n stops · n devices` line | the new personnel cell |

The drop handler is the one that matters: `PeopleRail` shipped inert and was made droppable on
2026-08-31 because operators drag a device onto *the engineer's name in the list*, not onto their cell
out in the grid — filed as *"I can't drag and drop a device"*. Losing it silently re-opens that ticket.

**The test surface is exactly three files** (`grep -rn "person-\|console-people-rail"`):

- `scheduler-console-composition.test.tsx:664,679` — drops on `person-<seId>`; retarget to `lane-`.
- `todays-dispatch.test.tsx:110` — asserts a name *inside* `console-people-rail`; retarget to `lane-`.
- `scheduler-console-phase1.test.tsx:407` — **[corrected]** clicks `person-se-2` and asserts the
  Inspector reads `Priya M.` / `floating`. The first pass missed this: the rail is a **click-to-inspect**
  affordance too, not only a drop target. `lane-` already does the same thing, so this is a retarget
  rather than a rebuild — but it is a third file, not the two originally counted.
- `scheduler-console-phase1.test.tsx:229` asserts the rail is *absent* when a CSM has chosen no zone.
  That assertion stays valid after deletion and needs no change.

### Risk 6 — `ADJUSTED` is a stop fact, and Part 19 would move it onto a ticket

`BoardGrid` carries an explicit warning that `adjusted` must not be read as "the ticket you moved is
still here, modified". Putting an `ADJUSTED` ribbon on a *ticket* card re-creates precisely the
misreading that comment exists to prevent. If the card is the new unit, the honest per-ticket
equivalents are `addSource === 'MANUAL_DAY_MOVE'` (moved here by a person) and the existing provenance
channel — with the stop-level badge staying on the stop header inside the cell.

### Risk 7 — process

`CLAUDE.md`'s surfacing rule points at `docs/ui/desktop/v2-reference/` and
`docs/ui/desktop/approved-designs/` as authority and says *do not redesign*. The current composition is
itself an operator-approved correction
(`docs/audits/scheduler-console-ui-composition-correction.md`, 2026-08-28), which explicitly rules the
People rail a region and rules ghost / committed chips deliberate. This request supersedes parts of
that. That is the operator's call to make — but the composition-correction doc and `INDEX.md` need to
record the supersession, or the next session will "fix" the board back.

**[corrected]** The first pass claimed the third screenshot was not in the repo. It is:
`docs/audits/scheduler Engine console.png`, alongside the two reference images. It was opened and read
on the verification pass, and it confirms the composition this document describes — a left
`ENGINEERS 15` rail carrying `25/25` load badges, `DEDICATED` / `MULTI PLANT` tags and
`2 stops · 25 devices` lines; a narrow `ENGINEER` column on the board repeating the same names;
8-character hash chips as the ticket unit; `Mon, 31 Aug HISTORY` / `Tue, 1 Sept LIVE` /
`Wed, 2 Sept COMMITTED` day headers with an `ADJUSTED` badge on a stop; and the Work Pool rail
(`Unassigned 225` / `Held 1` / `Changes 6`, plus the `WITHHELD BY POLICY 1179` count-only card).

Nothing in §1–§4 was derived from that image, so no other finding changes. It does confirm two things
the file map asserts from code: the ticket unit really is `ticketId.slice(0, 8)` (`WorkChip.tsx:120`),
and `ADJUSTED` really does sit on the **stop** header, not on a ticket (Risk 6).

---

## 6. Smallest correct change (proposal, not yet approved)

**Backend — one file, plus one bug fix. No algorithm, no schema, no migration.**

1. `dispatch-today-query.service.ts` — widen `TodayTicket` with `deviceId, vehicleNo, companyName,
   transporterName, inactivityHours, troubleshootingStarted, actionStatus` (plant is already on the
   stop). Fill them with **one** batched helper in the existing private-method style, using the join
   proven by `ticket-query.service.ts` and the soft-state read proven by `PrismaSoftStateConflictPort`
   — a port `scheduling` already depends on.
2. New pure module (sibling of `soft-state/activity-status.ts`) —
   `deriveActionStatus({troubleshootingStarted, ageHours, thresholdHours})` →
   `IN_PROGRESS | NOT_STARTED | AGING_UNTOUCHED`, precedence exactly as specified (started wins, then
   aged, then not-aged). Unit-tested in isolation.
3. Publish `actionThresholdHours` (and fix `chronicThreshold` while in there) on `DispatchTodayView`,
   so no client hard-codes either.

**Frontend — delete one component, restructure one grid, add one card.**

4. Delete `PeopleRail.tsx`; drop the `15rem` track from `TodaysDispatchPage.tsx:568`
   (→ `xl:grid-cols-[minmax(0,1fr)_20rem]`).
5. Widen `BoardGrid`'s name column from `minmax(7rem,8rem)` (`BoardGrid.tsx:77`) to ~`18rem` and grow
   `EngineerRow`'s first cell into the personnel cell. **[corrected] This extends the existing cell
   rather than replacing it** — the `lane-` button and `LoadBadge` are already there and stay; what is
   added is the initials avatar, the coverage pill, the stops/devices line, and `PeopleRail`'s
   `onDragOver`/`onDrop` moved over verbatim (same `dropAction` call, not a copy). Retarget the three
   `person-` / `console-people-rail` test references to `lane-` (Risk 5). Row / cell alignment is
   preserved for free because it is already one CSS grid, not a sidebar plus a table.
6. New `WorkCard.tsx` beside `WorkChip.tsx`, taking the same `ChipDragPayload` and the same
   `DRAG_MIME` — identity (`ticketId`, `batchId`, `fromSeId`) is carried unchanged, so drag/drop,
   `dropAction`, `intentFor`, the Inspector and every override are untouched. `WorkChip` stays for the
   Work Pool rows and the reduced column variants unless the operator wants it retired.
7. Widen the focused day column; keep context columns narrow.

**Explicitly not touched:** `override.service.ts`, `committed-day-load.ts`, the recommender,
`scheduler-preview.service.ts`, capacity, zone rules, commitment, run logic, `dropTargets.ts`
semantics.

---

## 7. Decisions needed from the operator before Phase C

1. **The aging clock** — device silence (`inactivity_hours`) or time since assignment
   (`batch_assignment_tickets.created_at`)? And which threshold key governs it? (Risk 3)
2. **Colour** — how red / yellow / green coexists with crimson = critical and amber = over-capacity,
   given #290 was a slice spent separating exactly those two. (Risk 4)
3. **Non-today columns** — reduced card variant (no backend change, honest) or widen
   `GET /schedules?detail=stops` too? (Risk 2)
4. **`FLOATING`** — the third coverage type; the request names only Dedicated / Multi Plant.
5. **Supersession** — confirm this replaces the 2026-08-28 approved composition, so `INDEX.md` and the
   correction doc can record it.
