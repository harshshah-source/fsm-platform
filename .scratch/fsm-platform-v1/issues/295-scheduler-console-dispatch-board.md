# #295 — Scheduler Console: from assignment table to dispatch board

Status: done
Filed: 2026-09-01 · **Implemented 2026-09-01** — report:
[`docs/progress/295-scheduler-console-dispatch-board.md`](../../../docs/progress/295-scheduler-console-dispatch-board.md)
Depends on: nothing open (all of #283/#284/#285, the 2026-08-28 composition correction, and the
2026-08-31/09-01 drag fixes are landed)
Source of truth for every claim below:
[`docs/audits/scheduler-console-dispatch-board-investigation-2026-09-01.md`](../../../docs/audits/scheduler-console-dispatch-board-investigation-2026-09-01.md)
— the twice-verified forensic investigation. **Do not repeat that investigation.** Every file:line in
this issue was re-verified on 2026-09-01 against the working tree while filing.

Visual references (presentation only — never copy their example people or ticket data):

1. `docs/audits/original-910f24cbf81faeceda03e423cfef2e83.jpg` — how an engineer/personnel row should read
2. `docs/audits/Planday-dashboard-1024x537.png` — how a schedule/work card should read
3. `docs/audits/scheduler Engine console.png` — the current Console, for before/after grounding

Per the CLAUDE.md surfacing rule, also read `docs/ui/desktop/v2-reference/` /
`docs/ui/desktop/approved-designs/` before touching the page; where they conflict with this issue,
this issue wins (it is an operator-directed supersession — see §10).

---

## 1. Product goal

Turn the Scheduler Console (`/dispatch/today`) from a technical assignment table into a
dispatcher-readable board:

```
ENGINEER COLUMN  +  DATE COLUMNS  +  FULL WORK/TICKET CARDS  +  CLEAR ACTION STATUS
```

Concretely, three visible changes:

1. **One engineer representation.** Delete the left `PeopleRail`; the board's own Engineer column
   becomes the single, richer personnel column. No operator capability may be lost (§5).
2. **Work cards instead of 8-char hash chips.** Cards showing Device, Vehicle, Plant, Company,
   Transporter and current device inactivity — with ticket identity kept internal (§6).
3. **A tri-state action status on today's cards** — troubleshooting started / untouched / aged
   untouched — derived **server-side** (§4).

This is a **read-model enrichment + UI representation** slice. It is not a scheduler rewrite — see
the must-not-touch list in §11.

## 2. Decisions already made (do not relitigate)

These settle the open questions in the investigation's §7. They came from the operator's request on
2026-09-01:

| Question (audit §7) | Ruling |
|---|---|
| Aging clock | **Time since assignment** — `batch_assignment_tickets.created_at` (the #241/#244 attempt-window start). Device inactivity is **not** a substitute; it stays a displayed metric only. |
| Aging threshold | A **new settings-registry key** (no schema change; `system_settings` rows are seeded from `SETTINGS_DEFAULTS`). Server publishes both the threshold and the derived state; React hard-codes neither. §4. |
| Colour | Action status gets its **own channel** (left status rail + status word). Crimson=critical-SLA, amber=capacity, violet=tier-cross, border=provenance all survive unchanged. §7. |
| Non-today columns | **Explicit card variants** per day mood, plus **one batched enrichment read** for the focused committed-future day. No N+1, no fabricated history. §8. |
| `FLOATING` | Preserved. The coverage pill renders all three of `DEDICATED | MULTI_PLANT | FLOATING`; never collapse FLOATING into another category. |
| Avatar | **No schema migration for a cosmetic field.** Deterministic initials fallback (precedent: `apps/admin/src/components/shell/TopBar.tsx:73`). |
| `chronicThreshold` defect (audit Risk 1) | **Fixed in this slice** — same file, same batched-helper pattern, and the new `agingThresholdHours` would otherwise inherit the identical silent hole. §4.4. |
| Supersession | This slice supersedes the People-rail region of the 2026-08-28 composition correction. Record it (§10) or the next session will "fix" the board back. |

---

## 3. Part A — backend: widen the `/dispatch/today` read model

All in `apps/backend/src/scheduling/dispatch-today-query.service.ts` (618 ln) plus one new pure
module and one small port widening. **No schema, no migration, no algorithm change.**

### 3.1 Widen `TodayTicket` (service interface at `:12`, client mirror in
`apps/admin/src/api/dispatchToday.ts:16`)

New fields:

```ts
deviceId: string | null;          // already fetched — the include at :251 selects ticket.deviceId
vehicleNo: string | null;         // tickets.vehicle_id → vehicles.vehicle_no
companyName: string | null;       // tickets.company_id → company_master.name (companyTier already present)
transporterName: string | null;   // vehicles.transporter_id → transporters.name
inactivityHours: number | null;   // device_states.inactivity_hours — Number() the Decimal; NULL stays null
assignedAt: string;               // ISO — batch_assignment_tickets.created_at, already on the fetched row
troubleshootingStarted: boolean;  // unresolved TROUBLESHOOT_STARTED soft state exists
actionStatus: 'IN_PROGRESS' | 'NOT_STARTED' | 'AGING_UNTOUCHED';
```

Plant stays **stop-level** (`TodayStop.plantName`) — the card reads it from its stop; do not
duplicate it per ticket.

**Null discipline (audit §3 "inactivity"):** `inactivity_hours` NULL means *never recomputed*, and
must reach the client as `null`, never `0` — the card renders "Inactive —", not "Inactive 0h".
Precedent: `assignable-work-query.service.ts:98-105`.

### 3.2 One batched enrichment helper — never per-ticket queries

Fill the identity fields with **one** private helper in the existing style of `bucketByTicket` (`:366`)
/ `returnDueToday` (`:388`) / `availabilityBySe` (`:402`), called once over the payload's `ticketIds`
inside the existing `Promise.all` at `:259`. The join shape is already proven twice:

- raw-SQL: `ticket-query.service.ts` `FROM_JOINS` (`:186`) — `device_states` / `plants` /
  `company_master` / `vehicles` / `transporters`;
- Prisma-include: `MeTicketsQueryService` (SE app) — same shape minus transporter/inactivity.

Implementation freedom: either one `ticket.findMany` with nested selects
(`vehicle: {select: {vehicleNo, transporter: {select: {name}}}}, company: {select: {name}}`) plus the
device-state read, or widen the existing `bucketByTicket` device-state query to also select
`inactivityHours` (it already scans `device_states` for these exact tickets — one fewer query).
Requirement: **O(1) queries in board size**, not O(tickets).

### 3.3 Troubleshooting signal — widen the soft-state port, do not copy the query

The canonical "SE has started work" signal is an **unresolved `TROUBLESHOOT_STARTED`** soft state
(`resolved_at IS NULL`). Assignment is *not* troubleshooting.

The existing `SoftStateConflictPort.activeOnSiteTicketIds()`
(`src/scheduling/soft-state-conflict.ts:8`) is the **wrong population** — it deliberately includes
`ON_SITE` (adapter at `src/soft-state/soft-state-conflict.adapter.ts:21`). An SE standing at the site
who has not started troubleshooting must NOT read green.

Do:
- add `activeTroubleshootStartedTicketIds(ticketIds)` to the port; implement in
  `PrismaSoftStateConflictPort` with `type: 'TROUBLESHOOT_STARTED'` only, same
  `resolvedAt: null` + `distinct` shape; `NoConflictSoftStatePort` returns an empty Set.
- guard the empty-array input the same way every helper does (`if (ticketIds.length === 0)`) — the
  2026-09-01 session log records a production 500 from exactly this class of miss in
  `activeOnSiteTicketIds`.
- inject into `DispatchTodayQueryService` as `@Optional() @Inject(SOFT_STATE_CONFLICT)` with a
  `NoConflictSoftStatePort` fallback — the override-service precedent (`override.service.ts:210`),
  so the many existing specs that construct the service with only a PrismaService keep compiling.
  The provider already exists: `scheduling.module.ts:98`.

### 3.4 `actionStatus` — a pure function, derived at read time, never stored

New pure module `apps/backend/src/scheduling/ticket-action-status.ts` (precedent for
derived-at-render-never-stored: ADR-0023's `soft-state/activity-status.ts` — a sibling in spirit;
that one is the *engineer's* label and cannot be reused for a per-ticket state):

```ts
export type TicketActionStatus = 'IN_PROGRESS' | 'NOT_STARTED' | 'AGING_UNTOUCHED';

export function deriveTicketActionStatus(input: {
  troubleshootingStarted: boolean;
  hoursSinceAssignment: number;   // (now − batch_assignment_tickets.created_at) in hours
  agingThresholdHours: number;
}): TicketActionStatus
```

Precedence, exactly:

1. `troubleshootingStarted` → **`IN_PROGRESS`** (green — started wins over everything)
2. else `hoursSinceAssignment >= agingThresholdHours` → **`AGING_UNTOUCHED`** (yellow)
3. else → **`NOT_STARTED`** (red)

`now` is the same `opts.now ?? new Date()` the service already threads (`:211`) — for testability,
never a second clock. Unit-test the module in isolation (boundary: exactly at threshold is
AGING_UNTOUCHED, matching the `>=` convention of `overCapacity` at `:280`).

**Do not** use `inactivity_threshold_hours` (a measurement definition — moving/reusing it for
dispatch restates every Fleet-Uptime KPI; `assignment-threshold.ts:8-21` forbids it in as many
words), **do not** use `se_assignment_threshold_hours` (its clock is device silence, which starts
long before assignment — on the default nearly every red would be yellow the instant it lands), and
**do not** use `troubleshoot_started_stale_warning_hours` (the opposite population).

### 3.5 The new threshold key

Register in `SETTINGS_DEFAULTS` (`src/settings/settings.service.ts:25`), following the
`troubleshoot_started_stale_warning_hours` pattern:

```
assigned_untouched_aging_hours: {
  value: 4,
  description: 'An assigned ticket with no TROUBLESHOOT_STARTED soft state for this many hours ' +
    'renders as AGING_UNTOUCHED on the dispatch board. Clock starts at assignment ' +
    '(batch_assignment_tickets.created_at), NOT at device silence — distinct from ' +
    'se_assignment_threshold_hours, whose clock is the device, and from ' +
    'inactivity_threshold_hours, which is a measurement definition.',
},
```

Add a validator (positive finite number) in `SETTING_VALIDATORS` per the special-attempt precedent.
The **default of 4 is a filed guess** — it is operator-tunable at runtime through the existing
settings registry, so it is not blocking; flag it to the operator in the completion report.

### 3.6 Publish the rules on `DispatchTodayView`

Root-level additions:

- `agingThresholdHours: number` — read per request (the `readAssignmentThresholdHours` free-function
  style over the Prisma client is the precedent, `assignment-threshold.ts:84`), so an operator edit
  takes effect on the next fetch with no restart.
- `chronicThreshold: number` — **the Risk-1 fix.** The client
  (`apps/admin/src/api/dispatchToday.ts:156`) has declared this required since Phase 3.4 and the
  backend has never sent it, so `failureCycles >= undefined` is always false and the `CHR ×n` token
  and Work Pool chronic filter can never fire outside the six hand-written test fixtures. Publish
  the ADR-0021 threshold (`REPEAT_THRESHOLD = 3`, `src/ticketing/repeat-escalation.service.ts:6`)
  via one **shared exported constant** — move/export it so the escalation scan and this payload
  read the same number; do not create a second literal `3`.

And fill `failureCycles` — currently hardcoded `null` at `:307` (board tickets) and `:523` (held
rail), beside a comment referencing an `attachFailureCycles` that never existed; the client's
`TodayUnassignable.failureCycles` (`dispatchToday.ts:93`) also has no server counterpart. One batched
`failureCycle.groupBy({by: ['deviceId']})` count over the payload's devices (lifetime count per
device — what the `WorkChip` copy "lifetime failure cycles" and WorkRail copy "N+ recorded failures
on the same unit" already promise), applied to board tickets, the held rail, and the unassignable
rail (add the field to the server's `TodayUnassignable`). Add a **backend** test asserting
`chronicThreshold` and a non-null `failureCycles` reach the wire — the absence of exactly that
assertion is how Risk 1 stayed green.

### 3.7 Batched card summaries for the focused committed-future day

The other day sources cannot feed a full card (audit Risk 2): `GET /schedules?date=&detail=stops`
carries no device/vehicle/company/transporter/inactivity, and the preview carries bare ticket ids.
Do **not** widen `GET /schedules?detail=stops` (it returns all zones' rows and is consumed
elsewhere); add one batched read:

- `POST /dispatch/card-summaries` — body `{ ticketIds: string[] }` (POST-as-read is established for
  bodies that don't fit a URL: `distribute-preview`, `override/preview`). Cap ids (~500; refuse
  larger with a stated code).
- Response: `{ summaries: Array<{ ticketId, deviceId, vehicleNo, companyName, transporterName,
  inactivityHours }> }` — the §3.1 identity fields, **no `actionStatus`** (see §8 for why).
- Same controller/guard/zone posture as `dispatch-today.controller.ts` (`parseZoneId` precedent);
  return rows only for tickets whose plant is inside the caller's permitted zone — a ZM must not be
  able to enumerate another zone's fleet by guessing ticket ids.
- Implementation: extract §3.2's enrichment into a shared private service method both reads call.
  **One request per focused day, not one per card.**

---

## 4. Part B — frontend: one personnel column, work cards, status channel

### 4.1 Delete `PeopleRail`, keep every capability it carries

- Delete `apps/admin/src/pages/dispatch/console/PeopleRail.tsx` (155 ln) and its usage in
  `TodaysDispatchPage.tsx` (rendered at `:573`; the board consumes the same `engineers` variable at
  `:597` — one dataset, so nothing can desynchronise).
- Grid: `TodaysDispatchPage.tsx:568` `xl:grid-cols-[15rem_minmax(0,1fr)_20rem]` →
  `xl:grid-cols-[minmax(0,1fr)_20rem]`.
- **Read `PeopleRail.tsx` in full before deleting** and port every fact it renders; the known list
  (audit Risk 5) is below, but the deletion must not silently drop anything the rail shows.
- `AssignMode`'s separate `assign-people-rail` is **out of scope** — it replaces the whole board
  region and stays as is.

### 4.2 Grow `EngineerRow`'s first cell into the personnel cell

`BoardGrid.tsx` — widen the name column (`:77`, `minmax(7rem,8rem)` → ~`18rem`) and extend the
existing cell. **This is a move, not a build** — already there and staying:

- the `lane-<seId>` button with `aria-pressed`, selecting `{kind:'engineer', id: seId}`
  (`BoardGrid.tsx:487-501`) — engineer click-to-inspect survives for free;
- the `LoadBadge` (committed/capacity, amber at `>=` capacity — the one shared definition).

Added to the cell (visual model: reference image 1):

- circular avatar with **deterministic initials fallback** (port the `TopBar.tsx:73` approach; no
  photo field exists and none is added);
- SE name (existing button), `committed/dailyCapacity` (existing badge);
- coverage pill rendering the true enum: `DEDICATED` / `MULTI_PLANT` / `FLOATING`;
- the `n stops · n devices` line (derivable from `stops`, as the rail already does);
- availability, if the rail renders it (`TodayEngineer.availability` is on the wire — verify while
  porting).

**The drop target moves verbatim (the regression that must not happen).** The rail's
`onDragOver`/`onDrop` (`PeopleRail.tsx:100-119`) call
`dropAction(payload, seId, today, today)` — move those handlers onto the personnel cell **calling
the same predicate in `dropTargets.ts`, never a copy** (the file's docblock explains why one
predicate). This capability was added 2026-08-31 because operators drag a device onto *the
engineer's name*, not onto a grid cell — filed as *"I can't drag and drop a device"*. Losing it
re-opens that ticket.

Roster completeness needs **no work**, only a guard test: the server builds lanes from
`engineerMaster.findMany({where: {isActive: true, zoneId}})` and maps lanes over the roster, so a
zero-work engineer already gets a lane (`committed: 0`, `stops: []`). Don't add client-side
filtering; the find box (`TodaysDispatchPage.tsx:260`) remains the only narrowing.

### 4.3 `WorkCard.tsx` — the new ticket unit on the focused column

New component beside `WorkChip.tsx` (which **stays** for Work Pool rows and compact/context
renderings — retire it only if the operator later says so). Visual model: reference image 2.

Card face (full/today variant): Device (`deviceId`), Vehicle (`vehicleNo`), Plant (from the
enclosing stop's `plantName`), Company (`companyName`), Transporter (`transporterName`),
`Inactive XXh` (`inactivityHours`; `null` renders as em-dash/"not recomputed", never `0h`), plus the
existing tokens carried over unchanged: `CRIT`, `RET`, `CHR ×n`, the `systemPlaced` dot, and the
provenance border treatment (`provenanceTreatment`).

**Identity rules (hard):**

- `ticketId` remains the domain identity for selection, drag, overrides, Inspector, and mutations.
  Device number / display text are labels, never keys.
- The card sets the **same** `ChipDragPayload` (`WorkChip.tsx:78` — `{type, ticketId, batchId,
  fromSeId}`) under the **same** `DRAG_MIME` (`:85`), and lifts it into the same React drag state.
  With payload and predicate unchanged, `dropAction`'s whole matrix (`dropTargets.ts:39-49`),
  `intentFor`, `ActionPrefill`, the Inspector prefill flow, cross-day `MOVE_TICKET` (carrying
  `newSeId` + `targetDate`), `SWAP_SE`, pool `ASSIGN`, and the "nothing is written on release"
  contract are all untouched by construction.
- Card click selects `{kind:'ticket', id: ticketId}` exactly as the chip does.

**`Inactive XXh` is informational; it is NOT the aging signal.** The rail/label colour comes only
from `actionStatus`. Two different clocks, deliberately (§2): a device can be silent 40h while its
ticket was assigned 10 minutes ago — that card is red-with-"Inactive 40h", not yellow.

### 4.4 Status channel rendering

- `IN_PROGRESS` → green rail + word ("Started");
- `NOT_STARTED` → red rail + word ("Untouched");
- `AGING_UNTOUCHED` → yellow rail + word ("Aged" / "Aged Nh+" using the published threshold).

Rules (audit Risk 4 — the colour vocabulary is already spent; #290 was a whole slice separating it):

- The channel is a **left status rail + status word** (+ optionally a subtle tint), in the
  `RET`/`CHR` token idiom — colour is never the sole carrier, so it survives beside crimson and
  amber without redefining them.
- Untouched, verbatim: crimson = CRITICAL+ SLA (`CRIT` token), amber = at/over capacity
  (`LoadBadge`, amber board cell), violet = tier-cross, border style = provenance
  (solid+dot engine · dashed human · dotted unrecorded). `index.css` carries the "never the same
  colour for two changes" comment — new tokens (e.g. `--color-action-*`) rather than reusing
  `--color-warning`/`--color-critical`.
- Update `GrammarLegend` (`WorkChip.tsx:223`) to teach the new channel and the card anatomy.
- No client-side threshold math beyond comparing nothing: the client renders the server's
  `actionStatus` enum; it never re-derives it from hours.

### 4.5 ADJUSTED / provenance — do not move a stop fact onto a ticket

`ADJUSTED` is stop-level (`stop.status === 'OVERRIDDEN'` → warning Badge on the stop header) and
means "this surviving stop was modified", explicitly NOT "the moved ticket is still here"
(`BoardGrid`'s long comment; audit Risk 6). Keep the badge on the stop header inside the cell. The
honest per-ticket signals already exist and carry over to the card: the provenance border/dot and
`addSource` (e.g. `MANUAL_DAY_MOVE` = a person moved it here). **Never** print a blanket "ADJUSTED"
ribbon on ticket cards.

---

## 5. Multi-day board — variants per column mood

Fidelity follows what each source can honestly answer (the standing §6.3 rule). One `WorkCard`
component with an explicit `variant` prop; a full card with five blank rows is the class of lie the
provenance grammar exists to prevent.

| Column mood | Source (unchanged) | Renders |
|---|---|---|
| Past | `GET /schedules?date=&detail=stops` via `useDayContext` | **Counts only, as today** (`batchCount`/`ticketCount`). Deliberate: the enrichment fields (inactivity, current names/state) are *live-now* facts — painting them onto a historical column fabricates historical operational state. No cards. |
| Today (focused) | `GET /dispatch/today` (§3) | **Full card**: identity fields + tokens + provenance + status rail. The only mutable column. |
| Committed future, focused | committed rows from `detail=stops` + **one** `POST /dispatch/card-summaries` call for that day's visible ticketIds (§3.7) | **Committed variant**: identity fields + current `Inactive XXh` (labelled as current), committed badge (`futureBadge()` at `BoardGrid.tsx:290` logic preserved), **no status rail** — troubleshooting/aging semantics don't exist before the work's own day, and a grey/red rail on Wednesday's work would be noise or a lie. Enrichment fetch failed → render the compact committed chips as now (graceful reduced state), never blank card rows. |
| Committed future, unfocused context | `detail=stops` (already fetched) | Existing compact committed chips/counts — context columns stay narrow. |
| Projected future (focused only) | `GET /schedulers/preview` ghost ids | **Ghost variant**: id-only, existing ghost styling + `bucketsAsOf` watermark, no write affordances, visibly NOT a committed assignment. Do not enrich (a projection is conditional; dressing it as operational fact makes it read committed). |

Caching/invalidation: per `(zone, version, day)` exactly as `useDayContext` does — the summaries
cache drops on the lifted fetch's `invalidate()` counter, so a committed override refreshes them.

## 6. Drag/drop preservation checklist (regression gate)

Every row must hold after the change — the payload/predicate design means most hold by construction;
tests make them stay held:

- [ ] Ticket drag identity: `ChipDragPayload.ticketId` + `batchId` + `fromSeId` unchanged, same `DRAG_MIME`.
- [ ] Stop (batch) drag → `SWAP_SE` on another SE, today only.
- [ ] Pool row drag → `ASSIGN` on today.
- [ ] Cross-day drag → `MOVE_TICKET` carrying `newSeId` + `targetDate` (the diagonal stays legal).
- [ ] Engineer-name drop: the personnel cell accepts the drops `PeopleRail` accepted, via the same `dropAction` (same-day semantics: `dropAction(payload, seId, today, today)`).
- [ ] Refusal stays a cursor state (illegal targets never become drop targets), never a post-hoc error.
- [ ] Nothing writes on release: drop → `DropIntent` → Inspector opens prefilled → existing `POST /batches/:id/override`. No new write path.
- [ ] Work Pool tabs (Unassigned / Held / Changes) and the chronic toggle keep working — with the §3.6 fix, chronic now works against real data for the first time.

## 7. Acceptance criteria

Backend:
1. `GET /dispatch/today` carries the §3.1 fields on every board ticket, filled by batched reads
   (query count independent of ticket count — assert with the existing query-counting test idiom if
   one exists, otherwise by inspection in review).
2. `actionStatus` follows §3.4 precedence exactly; unit tests cover started-wins, threshold
   boundary (`>=`), and the two clocks being independent (silent-40h/assigned-10min → NOT_STARTED).
3. `troubleshootingStarted` is true only for an unresolved `TROUBLESHOOT_STARTED`; `ON_SITE` alone
   does not light it (adapter-level test).
4. `agingThresholdHours` and `chronicThreshold` are published; `failureCycles` is a real count on
   board tickets and both rails; a backend test asserts all three on the wire.
5. `POST /dispatch/card-summaries` returns identity fields for in-zone tickets only; empty input →
   empty result (no 500); over-cap input refused with a stated code.
6. Settings key registered + validated; changing it changes `actionStatus` on the next fetch
   without restart.
7. `tsc --noEmit` clean in both apps; full backend + admin suites green.

Frontend:
8. `PeopleRail.tsx` deleted; exactly one engineer representation on the normal Console; the
   personnel cell shows avatar-initials, name, committed/capacity, coverage pill (three values),
   stops·devices; zero-work engineers still get a lane.
9. Engineer cell accepts the same-day drops the rail accepted, through the shared `dropAction`;
   engineer click still selects/inspects (`lane-` button).
10. Focused-today column renders `WorkCard`s with all six data fields; ticket identity drives
    selection/drag/Inspector; `Inactive —` for null inactivity.
11. Status rail/word matches `actionStatus`; the four existing colour channels visibly unchanged
    (CRIT token, amber LoadBadge/cell, violet tier-cross, provenance borders); legend updated.
12. §5 variants render per mood; past stays counts; ghost stays ghost; committed-future focused
    shows enriched cards via one batched call; its fetch failure degrades to compact chips.
13. Stop-level `adjusted` badge stays on the stop header; no ticket-level ADJUSTED anywhere.
14. §6 checklist all green (existing composition/drag tests + retargets below).

## 8. Test surface (verified exhaustive for the rail: `grep -rn "person-\|console-people-rail"`)

Retargets, not rebuilds:
- `scheduler-console-composition.test.tsx:664,679` — drops on `person-<seId>` → retarget to `lane-<seId>`.
- `todays-dispatch.test.tsx:110` — name asserted inside `console-people-rail` → assert in the personnel cell.
- `scheduler-console-phase1.test.tsx:407` — clicks `person-se-2`, asserts Inspector shows `Priya M.` / `floating` → retarget to `lane-se-2` (the lane button already selects).
- `scheduler-console-phase1.test.tsx:229` — asserts the rail absent with no zone chosen: stays valid, no change.

New: unit tests for `ticket-action-status.ts`; adapter test for the TROUBLESHOOT_STARTED-only read;
service test for the enrichment fields + published thresholds (the missing assertion behind Risk 1);
controller test for `card-summaries` zone clamp; `WorkCard` render/variant tests; personnel-cell
drop test (same predicate, both accept and refuse paths).

The six admin fixtures that hand-write `chronicThreshold: 3` stay valid — the server now actually
sends what they fake.

Process: TDD per the `/tdd` skill; completion report to `docs/progress/295-scheduler-console-dispatch-board.md`.

## 9. Explicitly out of scope / must not touch

`override.service.ts` semantics, `committed-day-load.ts` (never re-sum load from visible stops —
`committedDayPlan` is the one definition), the recommender, `scheduler-preview.service.ts`,
capacity/zone/commitment/projection logic, `MOVE_TICKET`/`DEFER_TICKET`/override semantics,
run-decision logic, `dropTargets.ts` drop-legality matrix, AssignMode and its `assign-people-rail`,
`GET /schedules` response shape, the SE mobile read (`MeTicketsQueryService`), and every existing
colour meaning. No new schema, no migrations.

## 10. Process obligations for the implementing session

- Record the supersession: `docs/audits/scheduler-console-ui-composition-correction.md` (2026-08-28)
  ruled the People rail a region and hash chips deliberate — add a dated supersession note pointing
  here (the doc's own Risk-7 instruction), and update `docs/SYSTEM-STATE-2026-07.md` §(Console) in
  place. Update this issue's status + INDEX.md session log as always.
- Surface to the operator in the completion report: (a) the `assigned_untouched_aging_hours = 4`
  default is a guess awaiting their number; (b) the open question below if it turns out to matter.

## 11. One open question — resolve during implementation, do not block on it

> **RESOLVED during implementation (2026-09-01).** The population is real: submitting resolves the
> soft state (`troubleshoot-submission.service.ts:157-160`) while the assignment row stays live until
> a verification decision, so a finished job did flip green to red. Fixed along the line recommended
> below — see slice 6b in the progress report.

**Submitted-but-visible work.** Per the operator's rule, `IN_PROGRESS` ⟺ unresolved
`TROUBLESHOOT_STARTED`. If submitting a troubleshooting report *resolves* that soft state while the
ticket can still sit on today's visible plan, such a ticket would flip green → red after the SE did
the work. First verify whether that population can appear on the board at all (does submission
change ticket/assignment state off the live plan?). If it cannot, note it and move on. If it can,
the recommended honest extension — flag in the report, don't silently invent policy — is to also
count a `troubleshooting_submissions` row within the current assignment window (the #244
"reached-during-assignment" idiom, `special-ticket.query.ts`) as `IN_PROGRESS`.
