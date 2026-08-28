# Scheduler Console — Product Vision Analysis

> **Status: discussion document. Nothing here is a specification and nothing here was implemented.**
> No component, route, endpoint, schema or migration was touched while producing it.
>
> **Date:** 2026-08-27 · **Branch:** `feat/autoplant-integration` · **HEAD:** `56f5aec`
>
> **Evidence discipline.** Every non-obvious claim carries a tag:
>
> | Tag | Means |
> |---|---|
> | `[CODE]` | Read directly out of `apps/backend/src`, `apps/admin/src` or `prisma/schema.prisma` during this investigation, at the cited path |
> | `[DOC]` | Established by an existing repo document and not independently re-verified here |
> | `[INFER]` | A reasoned conclusion from `[CODE]`/`[DOC]` facts — not an implementation fact |
> | `[OPEN]` | Genuinely unresolved; nobody has decided, or nobody has looked |
> | `NOT AVAILABLE` | The backend cannot answer this today |
>
> **Companion documents.** This document deliberately does **not** restate what three existing
> documents already establish. Where they answer a question, they are cited rather than copied:
>
> | Document | Lines | Cited as |
> |---|---:|---|
> | `docs/audits/scheduler-engine-technical-walkthrough.md` | 5,474 | **W§n** |
> | `docs/audits/scheduler-engine-ui-specification.md` | 2,712 | **UI§n** |
> | `docs/audits/scheduler-console-understanding-and-discussion.md` | 1,487 | **D§n** |
>
> **D** already covers the console question for the *dispatch* surfaces: capability inventory,
> fragmentation findings, the three IA options, commit semantics, and the standing rulings that a merge
> would overturn. **This document's new ground is the five things the brief adds that D does not
> cover** — Attention Required (§10), the ticket journey (§12), the telemetry drill-down (§13),
> configuration control (§15), and run scheduling (§16) — plus a re-verification of D's current-state
> claims and a materially different recommendation about where to start (§30).

---

## 0. Read this first — three facts that change what the discussion is about

### 0.1 The working tree still does not compile

`apps/backend/src/scheduling/scheduler-preview.service.ts:221` carries an uncommitted stray edit — the
docblock closes with `*/` and a trailing `'` opens a never-terminated string literal:

```
/** Release a hold — the ticket re-enters the very  ZOPerational HEAD scope is not defined. next run* . */'
```

`npx tsc --noEmit` reports exactly one error:
`src/scheduling/scheduler-preview.service.ts(221,110): error TS1002: Unterminated string literal.`
`[CODE — measured 2026-08-27]`

This was first flagged 2026-08-26 (W§0.2), restated 2026-08-27 (D§0.2), and **is still present**. It
makes the Scheduler Preview and the holds surface unbuildable. It is a prerequisite to any console
work and is not part of this discussion.

### 0.2 Three of the brief's "new" requirements are already built — in the wrong place

This is the single most important finding in this document and it reframes the whole exercise.

| Brief asks for | Already exists as | Where it lives today | Reachable from a scheduler surface? |
|---|---|---|---|
| §9 "Historical ticket journey" | `TicketDetailDrawer` — six tabs: Overview · **Lifecycle** · Forms · Verification · Components · **Assignment History** | `/tickets` | **No** |
| §10 "Zone → company → plant → device/telemetry drill-down" | Zone Dashboard: `zone-overview` → `company-plant-overview` → `/devices` list, with real telemetry columns | `/` and `/reports/device` | **No** |
| §4 "Repeatedly untroubleshooted devices" | **Special tickets (#244)** — `isSpecial`, `specialAttempts`, a tuned threshold, a per-attempt evidence trail | `/tickets` (badge + filter + count) | **No** |

`[CODE — apps/admin/src/pages/tickets/TicketDetailDrawer.tsx:24-25; apps/admin/src/api/dashboard.ts:139-152;
apps/admin/src/api/tickets.ts:135-164; apps/backend/src/ticketing/special-ticket.query.ts]`

**Consequence for the discussion.** The gap between the vision and the product is much less about
*missing capability* than the brief assumes, and much more about **three concepts that were built for
the fleet-health product and never connected to the scheduler product**. That is a cheaper problem and
a different one. It also means a console built without them would be the *fourth* place these
questions are answered.

### 0.3 The brief's central scheduling premise is contradicted by the engine

> *"The intention is that repeated failures can lead to priority treatment in scheduling."*

Today, repeated failure does the **opposite**, in three independent ways, and the third is the serious
one. Full evidence in §10.2. In one line: `repeat_failure_penalty` **subtracts** from the score
(`scoring.ts:114,127`), that subtraction is **structurally inert** because it is a ticket-level term in
a candidate-level comparison (`recommender.service.ts:548-552`), the ticket ordering ignores repeat
failure entirely (`canonical-sort.ts:82-113`), and at 3 repeats in 7 days the ticket is flipped to
`ESCALATED` — which **removes it from dispatch altogether**, because every dispatch and recovery read
filters `status: 'OPEN'`. `[CODE]`

This is not a UI problem and no console layout fixes it. **It is the most consequential product
decision on the table** (§29 P1).

---

## 1. Product Vision Restated

Stripped of proposed layout, the vision is four claims about *outcomes*:

1. **One workspace, not a tour.** A manager doing normal scheduler work — understand today, find what
   needs them, understand why the engine decided what it decided, change it, see the result — should
   not have to navigate between destinations and lose context at each hop.
2. **Complete operational authority, contextually placed.** Every existing scheduler mutation stays
   available; none is removed to simplify the screen. What changes is *where* each one appears.
3. **Truthful state.** Scheduler decision vs human decision vs projection vs current state vs proposed
   action must never collapse into one visual representation.
4. **Teaches while you use it.** Coverage tier, hard filter, score, unassignable reason, preview vs
   committed — each explainable in place, none of it dumped on the screen by default.

Two things the brief says that are worth pinning as *constraints*, not aspirations, because the
codebase already agrees with them: **do not reimplement engine logic in the frontend** (brief §17;
already this repo's `#282 R5` / `#272 R9`), and **do not invent data** (already `#282 R6` and the
engine's own first rule, *"never fabricate a default"*). `[DOC — D§14]`

**Where the vision is under-specified, and this matters:** it uses "Scheduler" to mean two different
systems. The morning batch dispatch engine (05:00 IST, zone-by-zone, `recommender/` + `scheduling/`)
and the fleet-health pipeline that *creates the work* (ticket creation, failure cycles, telemetry,
repeat escalation, Special) are separate subsystems with separate owners. Brief requirements §3 (zone /
company / plant status, inactive counts, telemetry), §4 (repeat failures) and §10 (drill-down) are
mostly the **second** system. Brief requirements §5–§8 are the first. Treating them as one "Scheduler
Console" is a legitimate product choice, but it is a choice, and §23/§24 argue it should be made
explicitly rather than by layout.

---

## 2. Users and Responsibilities

Derived from `@Roles` decorators, not from job titles. `[CODE — controller decorators]`

| | **ZONAL_MANAGER** | **CENTRAL_SERVICE_MANAGER** | **OPERATIONS_HEAD** |
|---|---|---|---|
| Zone scope | Own zone, clamped **server-side at every read** | Global; **must name a zone** for the cockpit | Global; **must name a zone** for the cockpit |
| Primary question | *"Is my zone's day intact, and what needs me?"* | *"Which zone is in trouble, and can I intervene?"* | *"Is the engine behaving, and is the policy right?"* |
| Overrides · holds · assign · escalations | ✓ | ✓ | ✓ |
| Trigger a dispatch run (`POST /schedules/dispatch-run`) | ✗ | ✓ | ✓ |
| See in-flight runs | ✗ | ✓ | ✓ |
| See **when the run fires** (`nextFireAt`) | ✗ | ✗ | ✓ |
| Edit the dispatch cron | ✗ | ✗ | ✓ |
| SE assignment threshold | ✗ | ✓ | ✓ |
| Scoring weights | ✗ | ✗ | ✓ |
| Bulk unassign / rebalance | ✗ | ✗ | ✓ |
| Special-attempt threshold, cluster multiplier, eligibility mode | ✗ | ✗ | ✓ |
| SE coverage (DEDICATED / MULTI_PLANT / FLOATING) | ✓ | ✓ | ✓ |
| Approve / override a vehicle return date | ✓ own zone | ✓ | ✓ |
| Acting-as-zone | n/a | ✓ (honoured inconsistently — D§6 F6) | ✓ (same) |

`[CODE — schedules.controller.ts; org/scoring-weights; settings/setting-authority.ts;
engineers.controller.ts:186-205; vehicle-unavailability.controller.ts:39]`

**Three consequences the brief should absorb:**

1. **The ZM's console is genuinely a different product from the CSM/OH's, and simpler.** No zone
   picker, no run trigger, no engine config. The repo's stated rule is *hide, don't disable* — *"showing
   a permanently-disabled control teaches nothing"* `[DOC — UI§4.4]`. A single console that renders the
   union of three roles' controls, greyed out, would violate brief §12 ("easy to learn") on the very
   screen that requirement is about.
2. **The CSM/OH have a landing-state problem no ZM has.** `GET /dispatch/today` returns
   `400 ZONE_REQUIRED` without a zone and *refuses to guess on purpose* — *"'all zones' is not a
   cockpit, it is a different product."* `[CODE — dispatch-today.controller.ts:53-58]` Their first
   moment in the console is a zone picker, or it is a fleet view that does not exist (§26 gap A1).
3. **A ZM cannot answer "why is my deck empty at 04:55?"** — `dispatch-schedule` is OH-only, `in-flight`
   is OH/CSM, and the hour is configurable so it cannot be inferred. This is a hole in the ZM's
   *primary* screen (§26 gap B2). `[CODE — schedules.controller.ts]`

**Challenge to the brief's framing.** The brief says the console "should support both zone-level
operation and broader management/oversight where the backend actually permits it." The backend permits
almost no broader oversight for the dispatch surfaces (one exception: the work pool, which *is*
pan-India for CSM/OH — and that asymmetry is itself a bug the moment both appear on one screen, D§6
F5). It permits a great deal of it for the *fleet-health* surfaces (`zone-overview` is pan-India, so is
`fleet-summary`, so is `activity-trend`). **The oversight layer the brief wants already exists — on the
Zone Dashboard, not the scheduler.** See §13.

---

## 3. What the Manager Needs to See

Mapped from the brief's own questions to what the backend can actually answer.

### Today

| Question | Answerable | By what | Bound |
|---|:--:|---|---|
| What has the Scheduler decided for today? | ✓ | `GET /dispatch/today?zoneId=` — run badge, 6 counters, crew lanes, 4 rails, escalations, recovery, in one call | **One zone. Today only** — there is no `date` parameter `[CODE — dispatch-today-query.service.ts]` |
| Which engineer is assigned to which plant/device/ticket? | ✓ | `engineers[].stops[].tickets[]` with plant, device, provenance | — |
| What is currently happening? | ⚠ | Committed plan + soft-state chips (`VIEWED` / `ON_SITE`) | **No GPS, no ETA, no route, no live position.** Ruled out by `#258 Q6` / `#272 R7` `[DOC]` |
| What remains unresolved? | ⚠ | `rails.unassignable[]` with `poolEmptyReason`, `rails.held[]`, `situation` counters | **Two of six funnel populations are missing from the live read** (§25 constraint 10) |
| What requires my attention? | ⚠ | `criticalNeedsYou`, `escalations[]`, `recovery.state`, `overCapacity`, `seSkips[]`, MV staleness | Scheduler-internal only. Nothing about Special, ESCALATED, deferral approvals or component blocks reaches this payload. See §10 |

### Future

| Question | Answerable | By what | Bound |
|---|:--:|---|---|
| What has the Scheduler decided for tomorrow? | **✗ — the question is malformed** | — | **Nothing is decided for tomorrow.** The run happens at 05:00 tomorrow. The honest answer is a projection, not a decision — §11 |
| What would the Scheduler decide on another date? | ✓ | `GET /schedules/preview?date=` — the real recommender, writes suppressed, count-pinned to zero writes | D+1 and beyond rank on **today's** severities; `bucketsAsOf` must be shown `[DOC — W§5.3]` |
| What will happen if the configuration stays unchanged? | ✓ | Same endpoint — that is exactly what it computes | It cannot compare two configurations (§15.4) |

### Historical

Covered in §12. Short version: the *ticket* journey is well served and lives on `/tickets`; the
*scheduler decision* half of it is only addressable if you already know the run id.

### Operational situation

| Brief asks for | Exists | Source |
|---|:--:|---|
| Zone status | ✓ | `GET /dashboard/zone-overview` — per-zone fleet counts + `byBucket` + `trendPctVsPrevDay` |
| Company status | ✓ | `GET /dashboard/company-plant-overview?companyId=` |
| Plant status | ✓ | Same, `?plantId=`; plus `fleet-directory` |
| Inactive counts | ✓ | `FleetCounts.inactiveOperational` / `inactivePct` / `neverReported` |
| Device / vehicle state | ✓ | `GET /devices` — see §13.2 for the full column list |
| Telemetry-derived information | ✓ | `latestGpsDatetime`, `tripCreationDatetime`, `isInactive`, `inactivityHours`, `slaBucket` |
| Engineer assignment to plants | ✓ | `se_coverage` (per SE × plant × type) + `GET /schedules/engineers` |
| Capacity / workload | ⚠ | `committed / dailyCapacity` rides on six reads; **there is no capacity endpoint** `[DOC — UI§11.1]` |
| Outstanding / unresolved work | ✓ | `GET /dashboard/zone-operations` — open / assigned / unassigned / liveBatches / overriddenBatches / engineersEngaged |
| Attention-required work | ⚠ | `GET /dashboard/action-required` exists — **and 7 of its 9 cards are stubs** (§10.1) |

`[CODE — apps/admin/src/api/dashboard.ts:24-157; apps/backend/src/dashboard/dashboard.service.ts:291-303]`

**The brief's instruction — "if the user clicks an inactive count, drill into a company/plant/device
overview table using existing telemetry" — describes a feature that shipped.** It is the Zone Dashboard
(`/`). §13 documents exactly what it can show.

---

## 4. What the Manager Needs to Do

The complete mutation inventory is D§4.3 (M1–M20) and is not restated. What matters for this
discussion is the classification the brief asks for, and one correction.

**Every scheduler mutation, by whether the console can host it today:**

| Class | Actions | Can the console host it with **zero** backend work? |
|---|---|---|
| **Ticket-scoped** | assign · reassign · remove from plan · defer · hold · release hold · open trace · see candidates | **Yes.** Every required id (`ticketId`, `batchId`, `plantId`, `seId`, `stopSequence`) is already in the `GET /dispatch/today` payload `[CODE — D§6 F1, re-verified]` |
| **Engineer-scoped** | swap whole stop · reorder stops · split batch · open day plan · see load | **Yes**, same reason |
| **Selection-scoped** | distribute (3 strategies) · assign a multi-engineer plan · assign a plant's work | Yes — but these live in `/assign` and carry the *draft* semantics that make the merge hard (§21) |
| **Exception-scoped** | resolve an escalation · reassign stranded work · re-run an EXHAUSTED zone | **Yes** for the first two. **There is no "recover now" and no "retry this zone" API** — do not draw one `[DOC — W§5.11/5.12]` |
| **Run-scoped** | run dispatch now (CSM/OH) · check in-flight | **Yes** — and `#282 R1` already approved relocating it (§16.1) |
| **Config-scoped** | threshold · weights · cron · planner pin · coverage · special threshold | Possible, but §15 argues most should stay out and §24 says why |

**The correction the brief needs.** Its example interaction pattern —
`select ticket → ticket actions` — is right, but it omits the one thing that decides which subset is
legal: **is the ticket on a plan or not?** `POST /schedules/holds` returns `409 TICKET_NOT_HOLDABLE` for
an assigned ticket; `assignTicket` refuses an already-assigned one. `[DOC — UI§20.2, §7.6]` So the
action set is a function of `(object type × assignment state × role)`, not of object type alone. That
is a three-way matrix, and getting it wrong produces exactly the "console that offers you a button that
409s" failure brief §12 is trying to avoid.

**Capabilities the brief names that do not exist.** Restated from D§4.4 because they will otherwise
reappear in a wireframe: *approve the plan* (deliberately absent — inaction means the run proceeds),
*cancel / pause a run*, *recover now*, *commit all changes as one transaction*, *fleet-wide scheduler
dashboard*, *live GPS / ETA / map*, *run progress %*. `[DOC — D§4.4]`

---

## 5. Scheduler Objects and Relationships

The code answers the brief's "what is the primary object" question unambiguously: **the (zone,
operating day) pair.** `dispatch_run_zones` is keyed on it; `dispatch_zone_recoveries` is *"one row per
zone per operating day"*; schedule closure, the pool clamp, the cockpit read and the changes ledger all
key on it. `[CODE — D§15.1, re-verified]`

```
                        ZONE  ×  OPERATING DAY (IST)          ← the console's frame
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
   DISPATCH RUN                 WORK POOL                   ENGINEERS
   (an attempt)                 (what is waiting)           (who can go)
        │                           │                           │
   dispatch_run_zones          tickets ── failure_cycles    engineer_master
        │                        │            │              se_coverage (tier)
   recommendations              plants     device_states     se_availability
        │                        │         (telemetry)      planner pins
   plant_batch_assignments   companies         │
        │                        │         devices ── vehicles
   batch_assignment_tickets   zones                │
   (THE ATTEMPT WINDOW)                       transporters
        │
   dispatch_decision_traces  ← the "why", top-5 runners-up only
   ticket_events             ← the "what happened", append-only
   soft_states               ← "the SE opened it / is on site"
   troubleshooting_submissions ← the only success writer
```

**Four relationships a console must not get wrong.** The first three are restated from D§2.5; the
fourth is new to this document.

1. **Coverage tier is inviolable; score only decides *within* one tier.** A FLOATING engineer can never
   out-score an eligible DEDICATED one. The only thing that crosses tiers is a human's planner pin.
   **A flat, score-sorted candidate list is therefore forbidden anywhere in the console.**
   `[DOC — W§1.2; tier-score-chooser.ts:55-72]`
2. **`recommended + unassignable` is not the funnel.** Six populations, each routing to a *different
   team*. Collapsing them into one "not dispatched" number turns a supplier delay into what looks like
   a fleet outage. `[DOC — W§1.3]` — **and see §10.3: there is now a seventh.**
3. **`null` never means zero.** `NOT_ENFORCED ≠ passed`; `NOT_AVAILABLE ≠ 0`; null rank ≠ unranked; null
   provenance ≠ system. `[DOC — W§1.5]`
4. **`batch_assignment_tickets` is the attempt ledger, and it is the join between the two halves of the
   product.** It is *"the only thing every assignment path writes — the 05:00 run, intraday accept,
   `assignTicket`, and the new row a REASSIGN/SPLIT_BATCH opens"*.
   `[CODE — special-ticket.query.ts:26-31]` It is how #244 derives Special, and it is the row that
   makes "this ticket has been tried four times" answerable at all. **Nothing on any scheduler screen
   reads it.** That is the concrete seam between §10 and §12 and it already exists.

---

## 6. Current Scheduler Capabilities

Not restated — D§4 is the complete inventory (32 endpoints: R1–R32 reads, V1–V4 previews, M1–M20
mutations) and was spot-checked against the controllers during this pass without finding a
discrepancy. Three structural facts from it that this document depends on:

- **`GET /dispatch/today` is a single call that carries almost the whole operating day** — run,
  recovery, six counters, crew lanes, ordered stops, tickets with provenance, four rails and
  escalations. `[CODE — dispatch-today-query.service.ts:126-150]`
- **Every id the six override commands need is already in that payload.** The cockpit is one screen
  away from being commandable and **zero endpoints away**. `[CODE — D§6 F1]`
- **Previews are the real engine with writes suppressed**, not a re-implementation, and that is pinned
  by e2e write-count assertions. `[DOC — W§5.3]`

Two capabilities the brief asks about that D does not inventory, because they are outside the
scheduling module:

| Capability | Endpoint | Roles | Purpose |
|---|---|---|---|
| **Special-ticket queue** | `GET /tickets?special=true`, `GET /tickets/special-count`, `GET /tickets/:id/attempts` | MANAGER, zone-scoped | The repeatedly-tried-and-failed population, with per-attempt evidence |
| **Vehicle return-date decision** | `GET /vehicle-unavailability`, `POST /:id/approve`, `POST /:id/override`, `POST /:id/resume-sla`, `GET /:id/history` | MANAGER (ZM own-zone) | The only approve/override workflow in the scheduling path |

`[CODE — ticketing/ticket-query.service.ts:295-395; ticketing/vehicle-unavailability.controller.ts]`

---

## 7. Current UI / Capability Distribution

The scheduler cluster is `≈6,552` lines across 18 surfaces `[DOC — D§5.1]`. The nav today
`[CODE — components/shell/nav.ts:102-228]`:

```
Operations              Zone Dashboard /  ·  Tickets  ·  Assign Work /assign  ·  Create Install
                        SE Activity  ·  Manage SEs  ·  SE Planner  ·  Verification Review
                        Readiness & Vehicle /readiness/vehicle-unavailability   ← deferral approvals
                        Non-Operational  ·  Cross-Zone  ·  Tier Overrides
                        Recovery Decisions  ·  Leave Requests  ·  Expense Vouchers

Dispatch  (#281)        Today's Dispatch     /dispatch/today      "What is happening now"   [PRIMARY]
                          Scheduler Preview  /schedules/preview   "What the next run would do"
                          Schedules          /schedules           "Committed day plans"
                          Intra-day Queue    /intraday            "Changes to today's plan"  [DEAD]
                          Dispatch Runs      /dispatch-runs       "What past runs did"

Components & Warehouse  ·  Analytics (Reports · Device Detail · Cohort · Root Cause · Efficiency)
Policy (CSM+OH)         SE Assignment Threshold /assignment-threshold
Admin (OH)              Coverage  ·  Bulk Unassign  ·  Plant Zones  ·  Settings  ·  Build Health  ·  …
```

**The dispatch cluster carries the tense model as visible copy** (each row has a `hint` naming the
operator question it answers) — that is `#281`'s delivered work and any console sits on it. `[CODE]`

**What the brief's requirements actually map to, across the whole app:**

| Brief requirement | Lives today at | Same cluster as the scheduler? |
|---|---|---|
| §3 Today / Future / plan inspection | `/dispatch/today`, `/schedules/preview`, `/schedules` | ✓ Dispatch |
| §3 Zone / company / plant / inactive counts | `/` (Zone Dashboard) | ✗ Operations |
| §4 Repeat untroubleshooted | `/tickets` (Special badge + filter + count) | ✗ Operations |
| §4 Deferral approvals | `/readiness/vehicle-unavailability` | ✗ Operations |
| §4 Override attention | `/dispatch/today` rails + `/schedules/:id` | ✓ Dispatch |
| §6 Actions | `/schedules/:engineerId` (overrides) + `/assign` (hand-out) | ✓ Dispatch, split across two |
| §7 Configuration | `/settings`, `/assignment-threshold`, `/engineers/manage` (coverage), `/engineers/planner` | ✗ three different groups |
| §8 Manual run | **`/bulk-unassign`** — an OH-only rebalance page | ✗ **wrong page entirely** |
| §9 Ticket journey | `/tickets` drawer, 6 tabs | ✗ Operations |
| §10 Telemetry drill-down | `/`, `/reports/device` | ✗ Operations + Analytics |

**Seven of the ten requirement clusters are outside the Dispatch group.** The fragmentation the brief
is reacting to is therefore *larger* than the four-dispatch-nouns problem the repo has already recorded
three times — but it is also *different in kind*: those seven are not fragmented scheduler screens,
they are **other products' screens that the scheduler needs to reference**. Merging them and merging
`/schedules/preview` into a console are not the same act and should not be decided together (§24).

---

## 8. Current User Workflow

Traced end-to-end for the highest-frequency real task: *a ZM sees the deck at 08:30, spots that a
plant's ticket is unassigned again, and wants to know why and fix it.*

```
1  /dispatch/today?zoneId=N      "unassignable: 3"                       → rail names the ticket
2  … the rail says NO_COVERAGE or ALL_DROPPED, nothing more
3  navigate /dispatch-runs       find today's run                        ← needs the runId to explain
4  /dispatch-runs/:runId         find the zone card
5  /dispatch-runs/:runId/zones/N find the ticket in the unassignable table
6  inline trace                  finally: which SEs, which filter, which verdict
7  navigate /schedules/:seId     pick an engineer, override
8  navigate back to /dispatch/today  did the zone counter move?
9  … and to answer "has this happened before?": /tickets → search → Assignment History tab
```

**Nine navigations, five destinations, three of which the ZM has to know exist.** Steps 3–6 exist only
because a trace is not addressable without its run (§26 gap S3). Step 9 is on a different product's
page and nothing on the scheduler links to it.

The same task for a CSM adds a step 0 ("choose a zone") and, if they wanted to trigger a run, a hop to
an OH-only page they cannot open.

**This is the honest case for the console** and it is stronger than the brief's abstract framing. It is
also, note, mostly fixable **without** merging any pages: steps 3–6 collapse if the trace is reachable
from the rail, steps 7–8 collapse if the lane is commandable, and step 9 collapses with one link. That
is §30's argument.

---

## 9. Desired Unified Console Workflow

The brief's loop, tested step by step against what the backend supports. (This table is D§3.2,
re-verified, with the attention step re-scored.)

| Step | Supported? | By what | Where it breaks |
|---|:--:|---|---|
| **Understand** | ✓ per zone | `GET /dispatch/today` | Zone-scoped only; no fleet-wide aggregate exists |
| **Identify attention** | ⚠ | rails, escalations, recovery, counters | **Scheduler-internal only.** Special, ESCALATED, deferral approvals, component blocks are all invisible here — §10 |
| **Select** | ✓ | rails carry `ticketId`; lanes carry `seId`/`batchId`; pool carries `(companyId, plantId)` | Two selection shapes coexist: ticket-shaped and plant-shaped (D§6 F5) |
| **Understand why** | ✓ inside a run | `GET /dispatch-runs/:runId/tickets/:ticketId/trace` — the richest surface in the product | **Not addressable without the run id** |
| **Explore options** | ✓ | `GET /schedules/candidates?plantIds=` — the engine's own eligibility, dropped candidates included | Runners-up 7..N were never stored (top-5 bound); live candidates carry no score |
| **Preview a change** | ⚠ **3 of 6** | `POST /batches/:id/override/preview`; `distribute-preview`; `GET /schedules/preview` | `REMOVE_TICKET` / `DEFER_TICKET` / `REORDER` are refused `400 NOT_PROJECTABLE` **deliberately** — *"zeros would read as 'this move costs nothing'"* |
| **Understand impact** | ✓ for the 3 | two capacity lanes, rank context, route effect, conflicts | **No staleness signal at all**; the confirm's own 409 is the only defence |
| **Commit** | ✓ | 6 overrides + assign + holds + escalation resolve + bulk-unassign | **Every one commits immediately and individually.** No change-set exists outside bulk-unassign |
| **See result** | ✓ | per-item results + changes-today ledger | **The app has no query cache** — "refresh" means calling `refetch()` on each affected read |

**Verdict, unchanged from D§3.3 and worth repeating because it bounds every wireframe:** the loop is
supportable end-to-end **for one zone and one change at a time**. It is not supportable pan-India, and
it is not supportable as an accumulated multi-change commit. Both are backend work, and both are things
a console UI would very easily *imply* it does.

**The one addition this document makes to that verdict.** The "identify attention" step is the weakest
link, not the "commit" step — and it is weak for a reason no layout fixes: the attention signals the
brief actually cares about (brief §4) are computed in a *different subsystem* and are not on the
scheduler's read path at all. §10 is therefore the most important section of this document.

---

## 10. Attention Required Model

### 10.1 There is already an "Action Required" concept, and it is 7/9 dead

`GET /dashboard/action-required` returns nine urgency-ordered cards. Seven of them return
`{count: 0, available: false}` and render as *"coming soon"*.
`[CODE — dashboard.service.ts:291-303, 876-884; ActionRequiredPanel.tsx:44-48]`

| # | Card | Wired? | Note |
|---|---|:--:|---|
| 1 | Auto-dispatched batches awaiting review | ✗ | Source "Issue 11" |
| 2 | **Vehicle Unavailability & readiness conflicts** | ✗ | **The data exists** — `GET /vehicle-unavailability` serves it and a page renders it. Only the card is unwired |
| 3 | CRITICAL insertions awaiting SE acceptance | ✗ | `intraday_insertions` exists |
| 4 | Failed Verification items | ✗ | `/verification` renders them |
| 5 | Component-Blocked tickets | ✗ | `component_blocked_queue` exists |
| 6 | WAITING_COMPONENT over 7 days | **✓** | Real query |
| 7 | Non-Op awaiting manager confirmation | ✗ | — |
| 8 | Manual assignment required (retry exhausted) | ✗ | — |
| 9 | Recovery Tickets stalled 14+ days | **✓** | Real query |

**This is the honest starting point for brief §4, and it is a better one than a new concept.**
Two of the seven stubs (2 and 4) are wired to data that is already served and already rendered
elsewhere — they are a `COUNT(*)` each. `[INFER, from CODE]`

**Challenge to the brief.** Building "Attention Required" as a new console concept while nine cards sit
half-built on the dashboard is how a product ends up with two attention queues that disagree. The
question to settle is not *"what should Attention Required contain"* but *"is `action-required` the
one attention model, and does the console consume it or replace it?"* (§29 P4).

### 10.2 "Repeatedly untroubleshooted devices" — the full trace

The brief asks six questions about this. Answered in order, from code.

**(1) What data exists?** Three distinct concepts, currently conflated in the brief:

| Concept | Meaning | Where | Affects scheduling? |
|---|---|---|---|
| **`failure_cycles.repeat_failure`** | The **device** broke again after a previous episode closed. Immutable; chains via `previous_failure_cycle_id` | `schema.prisma:2385-2410` | See (3) — **no** |
| **`ESCALATED`** | 3+ repeat episodes in 7 days, or a failed verification | `repeat-escalation.service.ts`, `verification.service.ts:91` | **Yes — it removes the ticket from dispatch.** See (5) |
| **Special (#244)** | The **ticket** repeatedly entered an SE's workload, was *reached in the app*, and never produced a submission | `special-ticket.query.ts` | **No, by explicit ruling** |

**Special is the one that matches the brief's words** — *"assigned/tried repeatedly but remain
unresolved."* Its definition is unusually careful and worth quoting, because it is the definition a
console would render:

> An **attempt window** is a `batch_assignment_tickets` row — *"the only thing every assignment path
> writes."* **Reached** is a `soft_states` row inside that window — the mobile auto-posted `VIEWED`,
> which *"proves the SE opened the ticket in the app. It does NOT prove handset delivery, and a
> server-side assignment alone is therefore not an attempt."* **Success** is a
> `troubleshooting_submissions` row. A window is **countable** when it was reached, produced no
> submission, and ended `PLAN_EXPIRED` or `VEHICLE_UNAVAILABLE` — *"every other reason is an approved
> exclusion… somebody decided the attempt should end, so it is not evidence the ticket resists
> repair."* `[CODE — special-ticket.query.ts:24-40]`

**(2) How is repeat failure currently represented in the UI?** Three separate badges on `/tickets`,
deliberately visually distinct: `REPEAT` (device fact, orange), `ESCALATED` (cycle state, red),
`SPECIAL` (attempt observation, violet). `[CODE — ticketBadges.tsx:60-85]` Plus a `Special` toggle
filter with a server-side count, and an **Assignment History** tab showing every window with its
evidence (`reached` / `submitted` / `countable` / `removalReason` / SE name / open+close times) and the
verdict rendered as *"SPECIAL · 3/3 reached and unresolved"*.
`[CODE — TicketsPage.tsx:265-277; TicketDetailDrawer.tsx:418-470]`

**This is a better-built explainability surface than anything on the scheduler side**, and it is
invisible from every scheduler screen.

**(3) Does repeat failure already influence scoring? — Yes, and the answer is worse than "no".**

`repeat_failure_penalty` is a real, seeded weight (`0.2`) and it is **subtracted**:

```ts
const penalty = features.repeatFailure ? 1 : 0;
const baseScore = wRank*rs + wUrgency*urgency − wRepeat*penalty + wRepeatBonus*penalty + wAge*age + wDistance*ds;
```
`[CODE — scoring.ts:114, 121-128; org-seed.ts:81]`

Three things follow:

- **In DEFICIT (Catch-up) mode a repeatedly-failing device scores *lower*.** `repeat_failure_bonus` is
  a PREVENTIVE-only component and defaults to 0 in the DEFICIT set. `[CODE — scoring.ts:52-55]`
- **The penalty is structurally inert anyway.** The code says so itself: *"Every field but
  `distanceFromPrevStopKm` comes from the TICKET, which is the structural fact behind #258 Q-A:
  candidates for one ticket share an identical `baseScore`, so without a per-candidate term the score
  cannot order them at all."* `[CODE — recommender.service.ts:548-552]` The score selects an
  **engineer** for a ticket, so a ticket-level term shifts every candidate identically and **cancels
  out of every comparison**. Only `distance` and the per-candidate cluster multiplier discriminate.
- **The ticket *ordering* ignores repeat failure entirely.** `compareCandidates` is: Company Tier desc
  → Device Bucket desc → Return-Due-Today (sub-CRITICAL only) → Priority Rank asc → Oldest Inactive →
  Device ID. **There is no repeat term and no Special term.** `[CODE — canonical-sort.ts:82-113]`

> **So: `repeat_failure_penalty` is a live, seeded, Operations-Head-editable weight that appears in
> every persisted `score_breakdown` and changes no decision.** It is a sibling of the three dead levers
> `#266` closed the vocabulary to prevent — except this one is *inside* the closed vocabulary.
> `[INFER, from CODE]` This should be verified with a targeted test before it is treated as settled,
> but the code comment at `recommender.service.ts:548-552` asserts the general form of it directly.

**(4) Can a manager currently promote or prioritise a repeat failure?** **No — not through any
scheduler mechanism.** The available levers are: an **SE Planner pin** (biases *who*, not *whether* or
*when*, and affects only the next run), a **manual assign** (`POST /schedules/assign` — puts it on a
plan today, bypassing ranking entirely), and a **company tier override** (promotes every ticket for
that company in that zone, which is a blunt instrument). There is no per-ticket priority, no "pin to
tomorrow's run", no boost. `[CODE — se-planner.controller.ts; schedules.controller.ts; tier-overrides]`

**(5) The serious finding: escalation removes the ticket from the scheduler.**

`RepeatEscalationService` runs on a cron (`BUSINESS_SWEEP_REPEAT_ESCALATION_CRON`, wired at
`business-sweep-scheduler.service.ts:240-243`; the class docstring's *"Scheduling (cron) is deferred"*
is stale). At 3 repeat episodes in 7 days it flips the failure cycle **and the ticket** to `ESCALATED`.
`[CODE — repeat-escalation.service.ts:26-70]`

Then:

| Reader | Filter | Effect on an ESCALATED ticket |
|---|---|---|
| Recommender ticket selection | `status: 'OPEN'` | **Never dispatched again** `[CODE — recommender.service.ts:326-328]` |
| Auto-recovery sweep | `status: 'OPEN'` | **Never auto-closed, even if the device starts reporting** `[CODE — auto-recovery.service.ts:126-129]` |
| Vehicle-return resume sweep | `status: 'OPEN'` | Never resumed `[CODE — vehicle-return-resume.service.ts:62]` |
| Troubleshoot submit gate | `status: 'OPEN'` | An SE cannot submit against it `[CODE — troubleshoot-submission.service.ts:167]` |

And there is **no transition out of `ESCALATED` back to `OPEN` anywhere in the codebase** — a grep for
writers finds only the two that set it. The only exit is a Non-Operational marking, which closes the
ticket as `CLOSED_NON_OPERATIONAL`. `[CODE — non-operational.service.ts:47-53; grep across
apps/backend/src]`

The escalation's own intended consequence — *"notify ZM + Warehouse Manager"* — is explicitly
**unwired**: *"wired when the notification spine lands."* `[CODE — repeat-escalation.service.ts:16-17]`

> **Stated plainly: the current system's answer to a chronically-failing device is to take it out of
> the scheduler, tell nobody, and leave it in a state with no exit.** This is `[CODE]`-verified as a
> code path. **It is not measured** — nobody has counted how many tickets are actually sitting in
> `ESCALATED` in either database, and that count is the first thing this discussion needs (§30 step 1).

**(6) Would a configuration or a new mechanism be needed?** Depends entirely on which outcome is wanted
— and these are genuinely different products:

| Desired outcome | Mechanism | Cost |
|---|---|---|
| *"Show me chronic devices and let me act"* | Surface Special + ESCALATED as attention items; the manager uses manual assign | **Zero backend.** Two `COUNT(*)`s and a link |
| *"Chronic devices should be dispatched sooner"* | A term in `compareCandidates` — the **ordering**, not the score | Small, high-blast-radius. Ordering is *"the only thing that orders the dispatch path"* and is spec-pinned by ADR-0017 |
| *"Chronic devices should get a better engineer"* | A **per-candidate** term (e.g. prefer an SE who has not already failed on this device) | Real design work; nothing like it exists |
| *"ESCALATED should mean escalated, not exiled"* | A path out of `ESCALATED`, or exclude it from the dispatch filter | **This is a bug fix, not a feature** `[INFER]` |
| *"Special should sort"* | #244 explicitly forbids this without materialisation: *"If Special ever needs to affect sorting, that is a recorded architectural consequence requiring a follow-up (materialisation), not a quiet change here"* | Medium — needs a stored counter + reclassification story |

`[CODE — special-ticket.query.ts:16-22; canonical-sort.ts:1-13]`

### 10.3 The funnel has a seventh population, and it is the invisible one

D§2.5 Fact 2 lists six. `ESCALATED` is a seventh, and unlike `plant deactivated` and `device departed`
it is not merely uncounted — it is *terminal*:

```
tickets in the zone
   ├─ recommended                 → placed on a plan
   ├─ unassignable                → OPS: nobody could take it
   ├─ withheldBelowThreshold      → NOBODY: policy working as intended
   ├─ componentBlockedWithheld    → WAREHOUSE: part on order, SLA paused
   ├─ bucketlessDropped           → ENGINEERING: no ranking data
   ├─ deferred / held             → nobody: a decision already taken      [no run-level count]
   ├─ plant deactivated           → nobody                                [NO COUNT ANYWHERE]
   ├─ device departed             → nobody                                [NO COUNT ANYWHERE]
   └─ ESCALATED                   → nobody, permanently                   [NO COUNT ANYWHERE, NO EXIT]
```

### 10.4 Deferral approvals — the brief conflates two different things

**There are two deferral mechanisms and only one of them has an approval step.**

| | **ZM deferral** (`DEFER_TICKET`) | **Vehicle return date** (#245/#246) |
|---|---|---|
| Who initiates | A manager, from the override dialog | **The SE, in the field**, filing a Vehicle Unavailability report |
| What is recorded | `tickets.deferred_until` (a DATE) + an audit row | A `vehicle_unavailability_reports` row: `proposed_from` (SE's entry, **immutable**), `expected_from` (**authoritative**), reason code, transporter contact, GPS, notes |
| Approval | **None. The manager's own act is the decision.** | **Yes** — `POST /:id/approve` accepts the SE's date; `POST /:id/override` replaces it and **requires a reason**. Both stamp `decided_by` / `decided_by_role` / `decided_at` / `decision` and write an audit row **in the same transaction** |
| Effect on scheduling | Every unassigned-work reader spreads `notDeferredOn(day)` — one predicate, deliberately not six copies | `deferralDateFor()` derives `deferred_until` from the authoritative return date; and `returnDueToday` **promotes** the ticket in `compareCandidates` when the date arrives (below CRITICAL+) |
| Effect on SLA | None | Primary SLA **pauses**; a manager-only secondary clock keeps running |
| Surfaced where | Cockpit "held" rail; `/schedules/:engineerId` | `/readiness/vehicle-unavailability` |
| Conflict handling | `409 CONFLICT_DEFERRED` on assign → confirm + reason | `409 VU_NOT_DECIDABLE` if the report stopped being live while the manager looked at it |

`[CODE — override.service.ts; ticketing/deferral.ts; vehicle-unavailability.controller.ts:135-175;
canonical-sort.ts:88-100]`

**Answering the brief's list for the mechanism that *does* have approvals:** inspect the request ✓
(reason code, transporter contacted, name/number, notes, GPS, both SLA clocks) · see the ticket ✓ ·
see the requested date ✓ (`proposedFrom`, immutable, shown beside the authoritative `expectedFrom`) ·
understand the reason ✓ · approve / reject / modify ✓ **(approve or override — there is no "reject";
the absence is a fact, not a date to argue with)** · understand the resulting scheduler effect
**⚠ partially** — the file response returns the derived `deferredUntil`, but the approve/override
responses' scheduler consequence is not spelled out on screen and the supersession chain
(`GET /:id/history`) is a separate call. `[CODE — vehicleUnavailability.ts:59-85]`

> **The brief's instruction — "do not invent an approval mechanism; trace the actual existing deferral
> behavior and identify gaps" — is well-founded, and the answer is: one exists, it is thorough, it is
> audited, and it is on a page called "Readiness & Vehicle" that no scheduler surface links to.**

**Gaps in the approval flow itself:**

| Gap | Evidence |
|---|---|
| No count anywhere — the `vehicle_unavailability` Action Required card is `available: false` | `dashboard.service.ts:294` |
| No aging signal — a report can sit undecided indefinitely; `expected_from` is authoritative *from arrival* whether or not anyone decided | `[INFER — the row is usable undecided]` |
| A manager cannot decline a return date, only accept it or replace it with a different date | `[CODE — the two legs are approve and override]` |
| No upper bound on the date, deliberately: *"a +90-day return is accepted… Management approval is the control"* — but nothing surfaces a +90-day approval as unusual | `deferral.ts:56-60` |

### 10.5 Override attention — what actually warrants an item

The brief asks which exception states warrant an attention item. From the payloads that exist:

**Warrants one** (each has a named cause and an owner): `recovery.state = EXHAUSTED` (the day's plan
did not complete and only a re-run fixes it) · `escalations[]` (a CRITICAL insertion needs a human;
`insertionType` tells you **which door works**) · `rails.unassignable[]` grouped by `poolEmptyReason`
(`NO_COVERAGE` → coverage config; `ALL_DROPPED` → readiness) · `situation.overCapacity` · zone `error`
+ `seSkips[]` · `configSnapshot.eligibilityMv.stale` (the FLOATING pool was selected from a stale view)
· `build.staleBuild` · run `status = PARTIAL` **with an empty `errors[]`** (a real, confusing state).

**Does not warrant one, and putting it in one would be an error:** `policyWithheld` (the count is
policy working correctly, and it is **deliberately never itemised** — those tickets get no
recommendation, no row and no trace, so there is nothing to list) · `conflicts.onSite` reading empty
(the soft-state feed is a seam) · `VEHICLE_ON_TRIP` / `COMPONENT_UNAVAILABLE` reading `NOT_ENFORCED`
(two unbuilt integrations, honestly recorded). `[DOC — D§19.4]`

**Should warrant one and cannot today:** Special tickets, ESCALATED tickets, undecided return dates,
component-blocked tickets, failed verifications — all real, all counted or countable, none on the
scheduler's read path.

---

## 11. Scheduler Plan Across Time

The brief's mental model — Today / Tomorrow / Future date / Historical — **does not survive contact
with the implementation**, and the way it fails is instructive.

**There are four temporal objects, and they have four different addressing schemes, four different
mutabilities and three different trust levels:**

| Object | Addressed by | Endpoint | Mutable? | Trust | Voice |
|---|---|---|:--:|---|---|
| **Committed plan (today)** | `zoneId` only — **there is no date parameter** | `GET /dispatch/today?zoneId=` | **Yes** — every override writes | Fact | *"Ravi is assigned"* |
| **Committed plans (any day)** | `?date=` + engineer | `GET /schedules?date=` | Yes | Fact | *"was assigned"* |
| **Projection** | `?date=` (any IST day, all zones in scope) | `GET /schedules/preview?date=` | **No — zero writes, e2e count-pinned** | Conditional | *"would be assigned"* |
| **Historical run** | `runId` | `GET /dispatch-runs/:runId…` | **Immutable evidence** | Fact, frozen | *"decided"* |

`[CODE — dispatch-today.controller.ts; schedules.controller.ts; scheduler-preview.service.ts]`

**Consequences the brief's model gets wrong:**

1. **"Tomorrow" is not a thing the scheduler has decided.** Asking for "what the Scheduler decided for
   tomorrow" invites a screen that shows a projection in the indicative mood. `#280 R2` exists
   precisely to forbid that: *"a single merged page that blurs a projection into a result would be a
   worse error than the present fragmentation, because it would make an operator believe a preview is a
   commitment."* `[CODE — 280:96-103]`
2. **A date picker on the live console would be a lie.** `GET /dispatch/today` is `istDate(now)`,
   always. A date control there would have to silently switch endpoints — and therefore silently switch
   mutability and trust. `[CODE]`
3. **The projection ranks on *today's* severities even for D+7.** `bucketsAsOf` is returned precisely
   so a screen can say so; it is *"the ranking inputs' staleness, taken from the very rows that were
   ranked."* `[CODE — recommender.service.ts:440-444]` A future-date view that omits it over-promises.
4. **The projection's staleness token is unusable.** `signPreviewToken` is called and
   `checkStaleness()` is fully implemented at `scheduler-preview.service.ts:135` — and **no controller
   route calls it.** The SDS documents "re-submit the token, get FRESH or STALE" as working. It is not.
   `[CODE — grep across every scheduling controller returns nothing]` **Do not draw a staleness badge
   on the preview.**

**Recommended model — three tenses, not four, and mode is a property of the endpoint, not a picker:**

```
   COMMITTED (today, this zone)      ← the console's home. Indicative voice. Mutable.
        │  "Ravi is assigned"           GET /dispatch/today
        │
        ├── PROJECTED (a chosen day)  ← a deliberate destination. Conditional voice. Zero writes.
        │      "would be assigned"      GET /schedules/preview?date=      + bucketsAsOf watermark
        │
        └── DECIDED (a chosen run)    ← immutable evidence. Past tense. Own object, own lifetime.
               "decided, at 05:02"      GET /dispatch-runs/:runId…
```

**The visual grammar must carry the tense, not a label.** `#282`'s provenance grammar already
distinguishes system vs human vs unknown; the tense axis is a second dimension and the two must not
share an encoding. `[INFER, from DOC — D§14 C2/C9]` §18 returns to this.

---

## 12. Historical Ticket Journey

The brief's proposed timeline, stage by stage, against the backend. **Every stage is either backed by a
real row or marked.**

| Stage | Backing row | Timestamp | Actor | Reason | Queryable today | Where |
|---|---|:--:|:--:|:--:|:--:|---|
| **Detected** (device went silent) | `device_states.latest_gps_datetime` + `failure_cycles.opened_at` | ✓ | system | — | ✓ | `GET /devices`, `GET /devices/:id/cycles` |
| **Created** | `tickets.created_at` + `ticket_events` (OPEN) | ✓ | ✓ `actor_id`/`actor_role` (null for system) | ✓ `reason_code` | ✓ | `GET /tickets/:id` → `lifecycle[]` |
| **Scheduler considered it** | `recommendations` + `dispatch_decision_traces` | ✓ | run | ✓ full trace | ⚠ **only via `runId`** | `GET /dispatch-runs/:runId/tickets/:id/trace` |
| **Scheduler did NOT consider it** | — | — | — | — | **✗ NOT AVAILABLE** | see below |
| **Assigned** | `batch_assignment_tickets.created_at` + `add_source`/`added_by`/`add_reason` | ✓ | ✓ | ✓ | ✓ | `GET /tickets/:id/attempts` |
| **Unassigned / removed** | `batch_assignment_tickets.removed_at` + `removal_reason` | ✓ | ⚠ **`ticketsRemovedSince` is deliberately unattributed** | ✓ code | ✓ | ↑ |
| **Deferred (ZM)** | `tickets.deferred_until` + audit row | ✓ | ✓ | ✓ | ⚠ current value only — **no history of previous deferral dates** | `GET /tickets/:id` |
| **Deferred (vehicle)** | `vehicle_unavailability_reports` + supersession chain | ✓ | ✓ SE **and** decider | ✓ | ✓ **full chain** | `GET /vehicle-unavailability/:id/history` |
| **Held** | `tickets.held_until` | ✓ | ✓ approver | ✓ | ✓ | cockpit held rail |
| **Rescheduled** | a *new* `batch_assignment_tickets` row | ✓ | ✓ | ✓ | ✓ | attempts list |
| **Reached** (SE opened it in the app) | `soft_states` (`VIEWED` / `ON_SITE`) | ✓ | ✓ SE | — | ✓ as a per-window boolean | attempts list |
| **Troubleshooted** | `troubleshooting_submissions` — root cause, action taken, diagnosis, photos, GPS, presence source | ✓ | ✓ SE | ✓ | ✓ | `GET /tickets/:id/forms` |
| **Verified** | `verification_runs` | ✓ | system | ✓ outcome | ✓ | Verification tab |
| **Resolved / closed** | `tickets.closed_at`, `closure_type`, `closure_reason` | ✓ | ✓ | ✓ | ✓ | Overview tab |
| **Escalated** | `ticket_events` (`reason_code: REPEAT_ESCALATION`) | ✓ | system | ✓ | ✓ | Lifecycle tab |

`[CODE — schema.prisma:2598-2616 (TicketEvent); ticketing/special-ticket.query.ts:150-230;
apps/admin/src/api/tickets.ts:59-164; TicketDetailDrawer.tsx:24-25]`

**So the answer to brief §9 is: the journey is real, it is well-modelled, it is already rendered in six
tabs, and the scheduler cannot see it.**

**The three genuine holes:**

1. **`NOT AVAILABLE FROM CURRENT IMPLEMENTATION` — "the scheduler looked at this ticket and did not
   place it."** Four of the funnel populations produce **no recommendation, no row and no trace**:
   `withheldBelowThreshold`, `componentBlockedWithheld`, `bucketlessDropped`, and anything excluded by
   the zone/plant/device gates. They exist only as **run-level counts**. A ticket that has been silently
   withheld for three weeks has an empty scheduler history that is indistinguishable from one nobody has
   ever run against. `[CODE — recommender.service.ts:399-431 count-only]` This is the single biggest
   journey gap and it is a **backend** gap.
2. **A trace is not addressable without its run.** There is no `GET /tickets/:id/decision` and no
   `GET /tickets/:id/traces`. Answering *"why is this here?"* requires first finding the run. `[DOC —
   G-UI-5]` The fix is a small read: the ticket's most recent trace, or its list of traces.
3. **`ticket_events.actor_id` is a bare uuid with no name lookup**, same as `changes-today.actorId`
   (§26 gap S5). The operator-facing history shows a UUID for the person who acted.
   `[CODE — schema.prisma:2605]`

**One thing the brief should not ask for.** A unified "one timeline" merging `ticket_events`,
`batch_assignment_tickets`, `soft_states`, `troubleshooting_submissions`, `audit_logs` and the traces
into a single ordered feed is tempting and would be *wrong to build as a backend endpoint*: those
sources have different retention, different attribution quality, and different meanings for a null
actor. The existing tabbed shape keeps each source's meaning intact. Merging them visually into one
scrollable column (with source-typed rows) is fine; merging them into one *data structure* is where the
"never fabricate a default" rule gets broken. `[INFER]`

---

## 13. Zone / Company / Plant / Telemetry View

### 13.1 It exists

```
GET /dashboard/zone-overview            → per zone: FleetCounts + byBucket + trendPctVsPrevDay
GET /dashboard/fleet-summary            → pan-India: FleetCounts + companies + plants + sync freshness
GET /dashboard/fleet-directory          → companies[] and plants[], each with FleetCounts + lastActivityAt
GET /dashboard/company-plant-overview   → ?companyId= / ?plantId= / ?zoneId= — the drill-down grid
GET /dashboard/zone-operations          → openTickets · assigned · unassigned · liveBatches
                                          · overriddenBatches · engineersEngaged   (scoped by status filter)
GET /dashboard/critical-queue           → CRITICAL+ clusters grouped by company → plant, with tickets
GET /dashboard/activity-trend?range=    → inactive stock vs troubleshoot vs install, hour/day/month
GET /dashboard/operating-mode           → per zone: DEFICIT|PREVENTIVE + silentCount + eligibleCount
GET /devices?…                          → the device/vehicle table (paged, filtered, sorted)
GET /devices/:id/cycles                 → every failure episode for one device
GET /devices/:id/downtime-trend         → lifetime + monthly + root-cause trend
```
`[CODE — apps/admin/src/api/dashboard.ts; apps/admin/src/api/devices.ts]`

### 13.2 Exactly what can be shown — no invention

**`FleetCounts`** (the same shape on zone, company and plant rows): `mirroredDevices` ·
`operationalDevices` · `warehouseDevices` · `reportingOperational` · **`inactiveOperational`** ·
`healthyOperational` · **`neverReported`** · `inactivePct` · `fleetHealthPct` · `byBucket` (per SLA
bucket). `[CODE — dashboard.ts:24-57]`

**Device row** (`GET /devices`): `deviceId` · `vehicleNo` · `deviceType` · `imsiNo` · `dealType`
(RECURRING | ONE_TIME) · `plantName` · `zoneName` · `companyName` · `slaBucket` ·
**`latestGpsDatetime`** · **`tripCreationDatetime`** · **`isInactive`** · `openTicketId` ·
`openTicketStatus` · **`openTicketIsSpecial`** · `assignmentState` · **`assignedSeName`** · `batchId` ·
`batchStatus` · `scheduleId`. Sortable by `LONGEST_INACTIVE` / `NEWEST_ACTIVITY` / `SLA_SEVERITY` /
`DEVICE_ID` / `PRIORITY`; filterable by `ALL` / `INACTIVE` / `ACTIVE` / **`NEVER_REPORTED`**.
`[CODE — devices.ts:17-140]`

**Underneath**, `device_states` also holds `inactivityHours`, `eligibleForUptime`,
`hasOpenFailureCycle`, **`isDeparted`**, `firstReportedAt` (the commissioning anchor, write-once) and
`computedAt` (the freshness stamp). `[CODE — schema.prisma:2334-2380]`

**The device row already carries the scheduler's answer** — `assignedSeName`, `batchId`, `batchStatus`,
`openTicketIsSpecial`. The two products are joined in this one read and nowhere else.

### 13.3 What must NOT be shown

| Tempting | Reality |
|---|---|
| Live GPS position / a map / a route line / ETA | **NOT AVAILABLE.** No live GPS in Phase 1; ruled out by `#258 Q6` and `#272 R7`. `latestGpsDatetime` is a *timestamp*, not a coordinate on any operator surface. Distance exists only as a scoring term |
| "Telemetry freshness" as a single number | Three different clocks: `device_states.computedAt` (recompute), `lastSnapshotAt` (ingest), `lastMasterSyncAt` (master). They are not interchangeable |
| A "not reporting" figure combining inactive + never-reported | **Explicitly rejected by operator decision P4 (#223)** — *"the third state is reported separately, not folded into a widened 'not reporting' figure"* |
| Zone counts that reconcile with dispatch counts | **They will not.** Report cubes bucket by **UTC day**; scheduling buckets by **IST day**. *"A report figure and a dispatch figure 'for the same day' cover different 24-hour windows."* `[DOC — W§6.1]` |
| An inactive count that matches the recommender's pool | Also no: `inactivity_threshold_hours` (24, the *measurement* definition) and `se_assignment_threshold_hours` (the *dispatch* gate) are **deliberately separate settings** — see §15.2 |

### 13.4 The one honest way to connect this to the console

The brief's requirement — *"when I see a number, I should be able to drill down and understand what
caused it"* — is satisfiable **without moving anything**, because both halves already exist and both
are zone-scoped:

```
Console zone header  →  "1,204 devices · 87 inactive · 12 critical"     (dashboard/zone-overview)
                            │
                            └─ click →  company/plant grid              (company-plant-overview)
                                            └─ click → device table     (/devices?plantId=)
                                                          └─ each row already names its SE and batch
```

**But it needs a rule, and the rule is the interesting part:** these figures are a *different clock and
a different population* from the dispatch funnel. Putting them in the same header as
`recommended / unassignable / held` without a visible separation would produce the exact
"one 'not dispatched' number" error D§2.5 Fact 2 warns about. **Recommendation: fleet-health figures
belong in a distinct band, visually and semantically ("the fleet"), never interleaved with the funnel
("the day").** `[INFER]`

---

## 14. Assignment and Override Authority

**The business requirement — "the manager has full operational authority to override Scheduler
decisions where the system allows manual intervention" — is already the implemented policy**, and more
strongly than the brief assumes. Three standing rules:

- **Overload is visible, never blocked, on every manual path.** *"Overload is an administrative right,
  so it is a seen decision rather than a refused one."* `[DOC — W§17.4]` The escalation manual-assign
  modal *deliberately* offers over-capacity and kit-short SEs. `[DOC — UI§18.6]`
- **Tier precedence is displayed and crossable by a human, never blocked.** A planner pin is *"searched
  across ALL passing candidates, not just the winning tier, and that is a deliberate operator ruling"*
  — *"a higher score can never cross a tier, while a human's pin still can."*
  `[CODE — recommender.service.ts:650-660]`
- **A human decision never looks like a system one.** `add_source` / `added_by` / `add_reason` /
  `coverage_type_at_assign` are persisted per ticket row, not derived. `add_source === null` is
  **unknown provenance**, not "system" — *"drawing it solid would be the single lie this whole grammar
  exists to prevent."* `[DOC — #282 R2]`

**Where authority is genuinely bounded, and these are safety rules, not gaps:**

| Bound | Why it exists |
|---|---|
| `REMOVE_TICKET` / `DEFER_TICKET` / `REORDER` cannot be previewed (`400 NOT_PROJECTABLE`) | Answering with zeros would read as *"this move costs nothing"* |
| `REORDER` renumbers **every** stop `1..n` | Two queued reorders on one schedule are not composable — this is why a draft basket is hard (§21) |
| An override's write is conditional on the row still being live; losing that race aborts **and the audit entry rolls back with it**, surfacing as `404 BATCH_NOT_FOUND` | After an override, a 404 means *"somebody else got there first"*, not "gone". A console must translate it |
| `ON_SITE` soft-state and `DEFERRED` gate the swap/reassign confirms | The SE is standing at the plant |
| `409 CONFLICT_VEHICLE_UNAVAILABLE` on placing a hold | The vehicle is already known absent |
| The RBAC ladder does not widen: `dispatch-run` stays OH+CSM, `bulk-unassign` stays OH, weights stay OH | `#272`, `#282`, D§14 C10 |
| **No approval gate, ever** | *"Approval is never required — inaction means the 05:00 run proceeds exactly as if nobody looked."* **No screen may show an Approve button for a plan** |

`[DOC — D§14; UI§19.3, §30.3]`

**The one authority the brief asks for that the system does not grant: per-ticket priority.** A manager
can change *who* and *whether*, but not *where in the queue*. The ordering is `compareCandidates` and
nothing outside it can influence a ticket's rank except a company tier override (company-wide) or a
vehicle return date (`returnDueToday`, sub-CRITICAL only). `[CODE — canonical-sort.ts]` This is the
mechanism §10.2(6) is really asking about.

---

## 15. Scheduler Configuration Control

The brief asks eight questions. Answered as one table, then the naming problem.

### 15.1 The complete configuration surface

| # | Setting | Storage | Who | Written via | **Effective when** | On screen today |
|---|---|---|---|---|---|---|
| C1 | **`dispatch_cron`** | `system_settings` | **OH** | `PUT /schedules/dispatch-schedule` | **Immediately** — the live job is re-registered by `setTime`, no restart. Validated *before* persisting, so a bad value never reaches the row or the registry | `/settings` |
| C2 | **`se_assignment_threshold_hours`** | `system_settings` | **CSM + OH** | `PUT /settings/assignment-threshold` (the generic writer **refuses** the key) | **Next run.** Read per run, never cached. Raising it withholds the existing backlog from the very next dispatch | `/assignment-threshold` |
| C3 | **Scoring weights** (`priority_rule_config`, per weight-set / mode) | table | **OH** | `POST /org/scoring-weights` | **Next run** — frozen into `configSnapshot.priorityRules` | `/settings` |
| C4 | **`plant_cluster_multiplier`** (1.25) | `system_settings` | **OH** | `PUT /settings/:key` | **Next run** — frozen into the snapshot | `/settings` |
| C5 | **`inactivity_threshold_hours`** (24) | `system_settings` | **OH** | `PUT /settings/:key` | **Next recompute** — this is a *measurement* definition (`is_inactive`, the uptime denominator, the Soft Inactive Count) | `/settings` |
| C6 | **`eligibility_mode`** (`pgi` \| `all-deployed`) | `system_settings` | **OH** | `PUT /settings/:key` | Next recompute — frozen into the snapshot | `/settings` |
| C7 | **`special_ticket_attempt_threshold`** | `system_settings` | **OH** | `PUT /settings/:key`, **validated against a closed option list** | **Immediately and retroactively** — Special is derived at read time, so a change reclassifies the whole open book | `/settings` |
| C8 | **SE Planner pins** (date × plant × engineer) | `se_planner` | MANAGER | `POST` / `DELETE /planner` | **The named date's run only** | `/engineers/planner` |
| C9 | **SE coverage** (DEDICATED / MULTI_PLANT / FLOATING per plant) | `se_coverage` | MANAGER | `POST` / `DELETE /engineers/:seId/coverage` | **Next run** — this is the *tier* the whole precedence ladder is built on | `/engineers/manage` |
| C10 | **`daily_capacity`** per engineer | `engineer_master` | MANAGER | `PATCH /engineers/:seId` | **Next run** — frozen into `configSnapshot.capacity` | `/engineers/manage` |
| C11 | **Company tier overrides** (company × zone, expiring) | `company_tier_overrides` | MANAGER | tier-override endpoints | **Next run** — frozen into the snapshot | `/tier-overrides` |
| C12 | Soft-state timeouts, stale-work warning hours, telemetry retention, recompute canary % | `system_settings` | **OH** | `PUT /settings/:key` | Various sweeps | `/settings` |

`[CODE — settings/settings.service.ts:24-108; dispatch-schedule.service.ts:110-145;
recommender.service.ts:324; engineers.controller.ts:148-205; dispatch-run.service.ts:1183-1250]`

### 15.2 The three answers the brief most needs

**"What is frozen into the next run's snapshot?"** — `captureConfigSnapshot` freezes, at admission,
*before* the run row is written: every **active** `priority_rule_config` row; five named settings
(`plant_cluster_multiplier`, `eligibility_mode`, `se_assignment_threshold_hours`,
`inactivity_threshold_hours`, `dispatch_cron`); **every engineer's `dailyCapacity` + `isActive`**; every
active, unexpired company tier override; and the **freshness of the FLOATING-eligibility materialised
view** (`lastSuccessAt` / `lastAttemptAt` / `lastError` / a computed `stale`). Plus the build stamp.
`[CODE — dispatch-run.service.ts:1183-1250]`

**"What affects the current run?"** — **Nothing.** The snapshot is taken before the run row exists and
the run reads its inputs once. A configuration change during a run affects the *next* one. `[INFER,
from CODE]`

**"What is effective immediately?"** — Only two: **C1** (the cron, because the job is re-registered) and
**C7** (the Special threshold, because Special is derived at read time and *"a threshold change has to
reclassify the whole open book retroactively"*). `[CODE — special-ticket.query.ts:16-22]`

**"What cannot currently be configured?"** — and this is the important half:

| Not configurable | Value | Why it matters |
|---|---|---|
| **The DEFICIT / PREVENTIVE switch threshold** | `DEFAULT_DEFICIT_THRESHOLD_PCT = 0.02`, a **constructor-injected constant with no settings key** | This is the **largest single behavioural lever in the scheduler**: it selects the whole weight set, turns `repeat_failure_bonus` and `device_age` on, and decides whether the Install backlog is scheduled at all. An operator can see the mode (`GET /dashboard/operating-mode`) and cannot move it `[CODE — reports/soft-inactive-count.service.ts:25,70,152]` |
| The repeat-escalation threshold | `REPEAT_THRESHOLD = 3`, `ESCALATION_WINDOW_MS = 7 days`, both consts | Decides which tickets get removed from dispatch (§10.2) `[CODE — repeat-escalation.service.ts:5-6]` |
| The trace runners-up bound | `TRACE_RUNNERS_UP = 5` | Bounds explainability permanently `[DOC]` |
| The recovery-stall and waiting-component windows | `RECOVERY_STALL_DAYS = 14`; 7 days | Drive the two live Action Required cards `[CODE — dashboard.service.ts:306]` |
| Business-sweep cron expressions | env vars only, not settings | Only `dispatch_cron` was promoted to a settings row (#213) |
| Ticket ordering | `compareCandidates`, code | ADR-0017; deliberately not data |

### 15.3 Manager-friendly naming — a proposal per lever

The brief is right that raw component names are hostile. Proposed operator vocabulary, with the
one-line explainer each control should carry:

| Internal | Operator name | The explainer |
|---|---|---|
| `se_assignment_threshold_hours` | **"Send an engineer after…"** | *"How long a device must be silent before the 05:00 run will plan a visit. Raising it holds existing tickets back from the next run."* |
| `inactivity_threshold_hours` | **"Count a device as down after…"** | *"The measurement definition — it sets uptime and the zone's health score. It does not change when an engineer is sent."* (These two are near-identical numbers with opposite jobs — the settings copy already says so, and any console must repeat it.) |
| `company_priority_rank` weight | **"Customer importance"** | — |
| `dispatch_urgency` weight | **"How overdue the device is"** | — |
| `distance` weight | **"Keep travel short"** | *"The only weight that changes which engineer is picked."* |
| `repeat_failure_penalty` | **do not expose until §29 P1 is settled** | Exposing a lever that changes nothing (§10.2) is worse than hiding it |
| `plant_cluster_multiplier` | **"Reward a second job at the same plant"** | — |
| `device_age` | **"Prefer longest-silent devices"** | *"Applies only in Steady mode."* |
| `special_ticket_attempt_threshold` | **"Flag a job after N failed visits"** | *"Changing this re-labels every open job immediately."* |
| DEFICIT / PREVENTIVE | **"Catch-up" / "Steady"** | **Mandatory** — `DEFICIT`/`PREVENTIVE` must never reach a user (`utils/operatingModeCopy.ts`) `[DOC — UI§34.1]` |
| `dispatch_cron` | **"Daily planning time"** | *"The next run is at HH:MM."* Show `nextFireAt`, never the cron string alone |
| `daily_capacity` | **"Jobs per day"** | — |
| DEDICATED / MULTI_PLANT / FLOATING | **"Primary" / "Shared" / "Roaming"** `[OPEN]` | These are already operator-facing on `/coverage`; renaming them is a bigger vocabulary decision than it looks |

### 15.4 Two things a configuration UI must not promise

- **"Try this setting and see what changes."** The preview (`GET /schedules/preview`) reads live
  configuration; it takes **no weight or threshold parameters**. A/B-ing a config change is
  `NOT AVAILABLE`. `[CODE — scheduler-preview.service.ts]`
- **"Revert this change."** Only `se_assignment_threshold_hours` has a revertible trail by design
  (#238's specialised writer); `dispatch_cron` records both values in one audit row (#213); the generic
  writer *"records only that the key changed, which does not answer 'what was it before?' three weeks
  later."* `[CODE — dispatch-schedule.service.ts:127-129]`

---

## 16. Manual Run / Scheduling Control

### 16.1 What exists

| Capability | Endpoint | Roles | Notes |
|---|---|---|---|
| **Run dispatch now** (optional `zoneId` + `reason`) | `POST /schedules/dispatch-run` | **CSM + OH** | Returns `409 DISPATCH_ALREADY_RUNNING` if in flight; `AllZonesHeldError` rolls back **the entire run row** — no partial ledger |
| **Is a run in flight?** | `GET /schedules/dispatch-run/in-flight` | **CSM + OH** | Exists precisely so the trigger can be disabled *before* the click. **Currently called by nothing in the admin app** |
| **When does it next fire?** | `GET /schedules/dispatch-schedule` → `{cron, timeZone, nextFireAt}` | **OH only** | |
| **Change the recurring time** | `PUT /schedules/dispatch-schedule` | **OH only** | Validate → persist (audited, both values) → re-register. **No restart** |
| **Why can't it start?** | ⚠ partial | | `409` names the conflict; `contendedWithRunId` names the holder. **There is no "the scheduler is switched off" state on any screen** (G-UI-15) |
| **What was the result?** | ✓ | | Run status + per-zone funnel + frozen config + build stamp |

`[CODE — schedules.controller.ts; dispatch-run.service.ts:365-425; dispatch-schedule.service.ts]`

**The defect the brief will trip over.** `/dispatch/today` Plan mode renders a **"Run dispatch"** button
that **navigates to `/bulk-unassign`** — an Operations-Head-only rebalance page. The only caller of
`POST /schedules/dispatch-run` in the whole admin app is `api/bulkUnassign.ts:136`. So the engine's own
trigger lives inside a page a CSM (who *has* the role) cannot open. `#282 R1` explicitly approved
relocating it; `#285` shipped without it. `[CODE — TodaysDispatchPage.tsx:424-426; grep]`

### 16.2 "Save the next run date and time so it runs later" — three readings, one answer

| Reading | Supported? | Detail |
|---|:--:|---|
| **(a) Change the recurring daily time** | **✓ fully** | `PUT /schedules/dispatch-schedule`. OH only. Immediate, restart-free, audited with both values, returns the new `nextFireAt` so *"an operator can confirm the change took, not just that it saved"* |
| **(b) Schedule a one-time run at a future date/time** | **✗ NOT AVAILABLE** | There is no `runAt` parameter, no queue, no scheduled-job table. `POST /schedules/dispatch-run` is immediate-only |
| **(c) Schedule a *recurring* run at a *specific date*** | ⚠ technically expressible, **do not** | A cron like `0 14 27 8 *` fires 27 Aug at 14:00 — and every 27 August after that. Using the recurring field for a one-off would be a trap the validator cannot catch |
| **(d) Skip / pause tomorrow's run** | **✗ NOT AVAILABLE** | No enable/disable flag on the dispatch job |

**Recommendation.** Read the requirement as **(a)**, and say so in the UI copy: the control is
*"Daily planning time"*, it shows *"Next run: tomorrow 05:00 IST"*, and it is Operations-Head-owned.
If **(b)** is genuinely wanted, it is a real backend slice (a one-shot schedule row + a claim + a
"scheduled runs" read), and it should be justified by a real scenario — the obvious ones ("run it after
the master sync finishes", "re-run after I fix coverage") are better served by **run now**, which
already exists and is one relocated button away. `[INFER]`

**Two things a run control must not render:** a **progress bar** (the engine has no stage concept and
no total-zone count while running; `heartbeat_at` is on neither run DTO — only "running · elapsed" is
honest) and a **cancel/pause** control (no API; `ABORTED` is reaper-only and means *"the process
stopped existing"*, not *"somebody cancelled it"*). `[DOC — UI§8.1/8.2; W-G9]`

---

## 17. Copilot Concept

**No LLM integration exists anywhere in this repository** — no AI SDK, no model client, no prompt
plumbing in `apps/backend` or `apps/admin`. `[CODE — verified]` Everything below is what a
**deterministic** intelligence layer can say from persisted data.

### Level 1 — Explain: **fully supported, and mostly already built**

`GET /dispatch-runs/:runId/tickets/:ticketId/trace` returns the winner with coverage type, precedence
rank, capacity at decision, planner bias, cluster seed, score and tier evaluated; up to five runners-up
with verdicts and scores; pool-wide drop counts; `scoreDegenerate`; `poolEmptyReason`;
`notEnforcedFilters`; **per-candidate `filterStates`**; **the full score breakdown**; plus every SE's
display name. `[CODE — recommender.service.ts:893-936]`

**Two of those are served and thrown away by the client's type definitions** — `breakdown` and
`filterStates`. Rendering them is a client-only change (§26 non-gaps). *"The engine's own arithmetic is
persisted, served, and discarded."*

### Level 2 — Recommend: supported per question, with hard bounds

| Question | Answerable | From | Bound |
|---|:--:|---|---|
| *Why is this ticket unassigned?* | ✓ | `poolEmptyReason` + `dropCounts` + per-candidate verdicts | **Only for tickets the engine decided on.** Withheld work has no recommendation, no row, no trace |
| *Why was this engineer selected?* | ✓ completely | tier → precedence rank → score breakdown → pin bias | — |
| *Why not that engineer?* | ✓ | `verdict` + `dropReason` + `filterStates` (5, tri-state) | **Top 5 runners-up only** — 7..N were never stored |
| *Which engineer should I consider?* | ✓ | `GET /candidates?plantIds=` — the engine's own ordered eligibility, dropped included | No scores, and no `TIER_NOT_REACHED`, deliberately |
| *What should I do about this repeated failure?* | ⚠ | Special attempts + failure cycles + root causes from submissions | **The system has no answer to give** until §29 P1 is decided — there is no priority mechanism to recommend |
| *Was a manager's pin ignored?* | **✗** | — | **Never recorded.** A pinned SE dropped by a filter is silently skipped (W-G6) |
| *Which of the two `SE_UNAVAILABLE` causes?* | **✗** | — | The trace collapses "on leave / off-window" and "deactivated". **Never label it "on leave"** |
| *Who removed this ticket?* | **✗** | — | `ticketsRemovedSince` is **deliberately unattributed** |
| *Did the engineer get told?* | **✗** | — | Outbox `attempts`/`lastError` exposed nowhere (G-UI-14) |

### Level 3 — Simulate: **3 of 6 override actions, and one whole-run projection**

`SWAP_SE` / `REASSIGN` / `SPLIT_BATCH` → two capacity lanes, rank context, route effect, conflicts.
`REMOVE_TICKET` / `DEFER_TICKET` / `REORDER` → **refused on purpose**. Distribute → three strategies
over an explicit selection. Whole next run → `GET /schedules/preview`. **What cannot be simulated: a
configuration change** (§15.4), and **anything at all with a staleness guarantee** except bulk-unassign,
which is the only preview in the product whose token is actually verified.
`[CODE — bulk-unassign.service.ts:137,187,208]`

### Level 4 — Act: every action already has an endpoint

The Copilot adds nothing here except *placement*. Which is the point: a "Copilot" that acts is just the
contextual action set (§4) with a better entry point.

### Level 5 — Natural language: **not needed for v1, and the more expensive build**

Every question in Level 2 has a **deterministic answer already in a payload**. Natural language would be
a different *input method* for answers the console can simply render. `[INFER]`

### The recommendation, and the one rule that binds it

**Copilot v1 = Contextual Inspector (Level 1, two missing components) + Operational Guide (a ranked
"what needs you" derived from fields that already ship). Both deterministic. Defer Levels 3 and 5.**

The Operational Guide is the strongest piece and is buildable today, because **the ownership routing is
already in the data model**: unassignable → Ops; component-blocked → Warehouse; bucketless →
Engineering; withheld-below-threshold → nobody. A guide that says *"3 things need Ops, 1 needs the
Warehouse, and 140 are policy working correctly"* needs no new endpoint. `[INFER, from CODE]`

**The honesty constraint.** The engine's first rule is *"never fabricate a default."* **A Copilot is
the easiest place in the whole product to break it, because summarising is exactly the act of filling
gaps.** The specific traps, each already documented and each a sentence a summariser would naturally
write:

- `SE_UNAVAILABLE` collapses two causes → **never say "on leave."**
- `plannerBias` compares against `passed[0]` (highest-precedence eligible), **not** the top scorer → it
  reads *"the pin differed from precedence"* and can over-report. **Never say "the pin beat the score."**
- `TIER_NOT_REACHED` candidates have **no score**. Rendering `0.00` re-tells the exact lie `#266` removed.
- `NOT_ENFORCED` is not a pass. **Two of five filters are permanently unenforced today.**
- `scoreDegenerate` means **precedence, not the score, decided** — and the cause is the score *spread*,
  not distance. Naming distance sends the operator to a setting that is not the reason.
- `null` `addSource` is **unknown provenance**, never a system decision.
- **And now, from this document:** never say *"this device is being prioritised because it keeps
  failing."* Until §29 P1 is decided, that sentence is false (§10.2).

---

## 18. Explainability / "Why?"

Four "why" questions, four different surfaces, and they must not be blended:

| Question | Surface | Trust | Addressability |
|---|---|---|---|
| *Why did the engine choose this SE, in that run?* | `trace` | Immutable evidence, frozen with the run's config | **Needs a `runId`** |
| *Who could take it right now?* | `GET /candidates` | Live, unbounded, no scores | `plantId` |
| *What would happen if I move it?* | override impact preview | Live, advisory, **no staleness signal** | `batchId` + command |
| *What happened to this ticket over time?* | ticket lifecycle + attempts + forms | Append-only fact | `ticketId` |

**The vocabulary problem the console creates.** `/candidates` says `PASSED` / `DROPPED`. The trace says
`PASSED` / `DROPPED` / `TIER_NOT_REACHED`. On separate pages that is defensible — `#272 R6` reasons that
a human may cross tiers, so a never-reached tier is not a rejection. **On one console they sit side by
side and appear to contradict each other.** `[DOC — UI Q6, still open]` → §29 P7.

**Three explainability wins available with no backend work at all**, all verified still missing on
2026-08-27:

| # | Missing | Effect today |
|---|---|---|
| F3-a | `ScoreBreakdownTable` — render `trace.chosen.breakdown` | The engine's own arithmetic is served and discarded by a client type |
| F3-b | `FilterStateStrip` — render per-candidate `filterStates[]` | Five tri-state dots per candidate; today only one drop reason shows |
| F3-c | `CandidateTierGroup` — group the candidate list by tier | **A flat list actively teaches a false model** (that a floating SE out-scored a dedicated one) |

`[CODE — verified absent]`

**How much should be open by default?** `#266` made scores decisive; `#270` made filters tri-state.
Collapsed is calmer; open is more explanatory on the screen whose whole purpose is explanation.
**Proposal for discussion:** collapsed by default; auto-open when the operator opened the panel
deliberately **and** `scoreDegenerate` is false; **always collapsed when degenerate** — the numbers are
true but did not decide, and showing arithmetic that did not decide is its own lie. `[INFER]`

---

## 19. Easy-to-Learn UX Principles

The brief's principle is right and the codebase already supplies the raw material. Five rules, each
derived from something the code enforces:

1. **Every count is a link, and every link lands on the rows behind it.** The failure mode this
   prevents is the one the brief names: a number you cannot interrogate. Already true on the Zone
   Dashboard; not true of any scheduler counter.
2. **Every sentinel gets its own visual language — four, not one em-dash.** `NOT_ENFORCED` (the check
   is switched off) · `NOT_AVAILABLE` (the input is missing) · `NOT_RECORDED` (nobody wrote it) · a
   real `0`. *"The single most dangerous conflation"* is collapsing these. `[DOC — UI§25]`
3. **Hide, don't disable.** *"Showing a permanently-disabled control teaches nothing."* `[DOC — UI§4.4]`
   Applies hardest to the ZM, who cannot trigger a run.
4. **Internal vocabulary never reaches a user.** `DEFICIT`/`PREVENTIVE` → "Catch-up"/"Steady" is the
   backend's own instruction and is enforced through `utils/operatingModeCopy.ts`. Never render
   `traceId`, `heartbeatAt`, advisory-lock keys, `previewToken`, `P2002`, `retryChain`, `RecPath`, or
   truncated UUIDs. `[DOC — UI§34]`
5. **A tooltip states the *rule*, not the *value*.** The brief's own examples are exactly right:
   *"Capacity 6/6 ⓘ At daily capacity"*, *"Dedicated ⓘ Primary coverage for this plant"*,
   *"Unassignable ⓘ No engineer passed the required readiness checks"*. Add one the brief did not
   think of, because it is the most-asked question in this product: **"Committed 5/6 ⓘ Counts work in
   every zone, not just this one"** — `committedDayLoad` is deliberately not zone-filtered, because
   *"a floating SE's work in a neighbouring zone is still work they have to do."* Without that line, a
   lane showing 5/6 with three visible stops looks like a bug. `[DOC — W§25.20]`

---

## 20. Control Accessibility Model

Every scheduler capability, classified as the brief asks. This is D§8 validated and extended with the
three new areas.

**Always visible (the console's frame):** zone (or the ZM's implicit zone) · the date **as a label, not
a picker** · run badge (status + trigger + elapsed) · the six funnel counters, **never summed** · the
health line (recovery · stale MV · stale build · `seSkips`) · refresh.

**Contextually visible — ticket selected:** assign · reassign · remove · defer · hold · release ·
open trace · see candidates for its plant · **open the ticket's journey** (new) · **see its attempt
history if Special** (new).

**Contextually visible — engineer selected:** swap a whole stop · reorder · split · open day plan ·
see load across all zones (with rule 5's tooltip).

**Selection-dependent (several tickets/engineers):** distribute (3 strategies — and the
`COVERAGE_TIER` strategy **must be labelled differently** from the other two, because one *is* the
engine's answer and two are allocation policy) · assign a multi-engineer plan · assign a plant's work.

**Exception-scoped:** resolve an escalation · reassign stranded work · re-run an EXHAUSTED zone.
**No "retry this zone", no "recover now" — do not draw them.**

**Advanced (Operations-Head-first, behind an expander):** `runId` / `batchId` / `scheduleId` ·
`weightSetRef` · raw `configSnapshot` · build fingerprint · `contendedWithRunId` · `seSkips[].constraint`
· `eligibilityMv.lastError` · `assignmentThresholdHours`.

**Historical / diagnostic (a destination, not a panel):** the run ledger → run → zone → batch chain ·
bulk-unassign history · the ticket's own journey tabs.

**Configuration (outside — §24):** cron · weights · thresholds · planner pins · coverage · capacity ·
tier overrides.

**Never rendered:** `traceId` · `heartbeatAt` · advisory-lock keys · `cron_tick_claims` ·
`previewToken` · `P2002` · `retryChain` · `RecPath` · raw `DEFICIT`/`PREVENTIVE`.

---

## 21. Current Assign Work Console as UX Precedent

`/assign` is 1,037 lines plus five supporting components, and its design is operator-approved
(`docs/ui/desktop/approved-designs/assign-work-console.html`, `#272`, approved 2026-08-20). It is the
closest thing in the product to the brief's target. `[CODE]`

**What is genuinely valuable and should be carried into any console:**

| Pattern | Why it works | Transferable? |
|---|---|---|
| **Three columns: pool → draft lanes → candidates** | The operator's real loop, left to right, without navigation | ✓ |
| **Candidates are the engine's own answer**, dropped ones included with reasons | It teaches the model instead of hiding it | ✓ |
| **Distribute as a projection over an explicit selection** | Proposes without committing | ✓ |
| **A review-and-commit screen with an itemised result** — not a bare count | Per-lane transactions, *"a lane that fails is legible and re-runnable while the rest stand"* | ✓ **and it is the only correct multi-item pattern in the product** |
| **Mandatory `reasonCode` on the commit** | Provenance is captured at the point of decision, not reconstructed | ✓ |
| **One shared visual grammar with the crew deck** — by ruling, *"the two boards read as one product"* | The merge is already half-done visually | ✓ |

**Where it conflicts with the broader scheduler workflow — four real conflicts, not stylistic ones:**

1. **Commitment semantics.** `/assign` chips are a **client-side draft that writes nothing until
   commit** (`#272 R2`). Cockpit chips are **committed rows whose every move writes immediately**.
   Putting both in one lane means **one visual object with two meanings** — precisely what the shared
   grammar's own first rule forbids ("never the same shape for two meanings"). `[CODE — #272:62-74]`
2. **Scope.** The pool is **pan-India** for CSM/OH; the crew deck **refuses** to be anything but one
   zone. Side by side, the counts will not reconcile. `[DOC — D§6 F5]`
3. **Selection unit.** The pool is **plant-shaped** (`companyId`, `plantId`); the deck is
   **ticket-shaped**. One selection model has to win, or the console has two.
4. **Draft lifetime.** *"Leaving the page loses it, and the page says so"* (`#272 Q2`). A console a
   manager keeps open all day makes that loss much more expensive — and a persistent draft *"needs its
   own table, an owner, and a reconciliation rule for when the underlying tickets move out from under
   it."* `[CODE — #272:130-136]`

**And the standing ruling.** `#280 R7`: *"`/assign` is a **write** surface for human decisions; the
dispatch timeline is largely a **read** surface for the engine's decisions. They are adjacent and must
not be merged."* Reaffirmed by `#282 R1` and again by the 2026-08-25 forensics report. Unlike `#280
R2`, **R7 carries no "revisit with evidence" escape clause** — overturning it is an explicit operator
act. `[CODE]`

---

## 22. Conceptual Unified Console Information Architecture

**The brief's sketch is close, and wrong in two specific ways.** It puts Copilot in a bottom-centre
panel beside Actions, and it puts "Changes / Result / Confirmation" in a bottom bar. Both encode
assumptions the backend contradicts: Copilot is not a peer of actions (it is the *explanation of the
selection*, which is the same object), and a bottom result bar implies an accumulated change-set
(there is none, and `#272 R8` rules that multi-item commits report **per item**).

**Proposed structure — a frame, a board, an inspector, and a ledger:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ FRAME    Zone ▾ · Wed 27 Aug (today) · Run #4182 completed 05:04 · [Run now]   │  always
│          Fleet: 1,204 devices · 87 silent · 12 critical      ← distinct band   │
├───────────────────────────────────────────────────────────────────────────────┤
│ HEALTH   ⚠ Recovery EXHAUSTED (3 attempts) · eligibility view 19h stale        │  conditional
├───────────────────────────────────────────────────────────────────────────────┤
│ SITUATION  six counters, never summed                                          │  always
│  placed 41 · unassignable 3 · held 7 · critical 1 · over-capacity 2 · changes 5 │
├──────────────────────────────────┬────────────────────────────────────────────┤
│                                  │                                            │
│  BOARD                           │  INSPECTOR   (what is selected)            │
│  ── crew lanes, ordered stops    │  ── identity + provenance                  │
│     provenance-marked chips      │  ── WHY: tier → precedence → score →        │
│  ── rails: unassignable · held   │        pin bias   (Level 1 Copilot)        │
│     policy-withheld · changes    │  ── ALTERNATIVES: candidates, by tier       │
│                                  │  ── HISTORY: attempts · lifecycle · Special │
│  [Assign mode: pool + draft      │  ── ACTIONS: the legal set for              │
│   lanes, visually distinct]      │        (object × state × role)              │
│                                  │  ── IMPACT: shown only where projectable    │
├──────────────────────────────────┴────────────────────────────────────────────┤
│ ATTENTION  ranked, each item naming its owner and its one action               │  always
│  3 need Ops · 1 needs Warehouse · 2 return dates awaiting you · 140 policy OK   │
└───────────────────────────────────────────────────────────────────────────────┘

REACHED FROM HERE, NOT INSIDE:  Projection (a chosen day) · Run ledger (a chosen run)
                                Planner (dates × plants)  · Config · Bulk unassign
```

**Five structural commitments in that sketch, each with its reason:**

1. **The frame carries two bands, not one.** Dispatch funnel and fleet health are different clocks and
   different populations (§13.3). Interleaving them is the easiest way to make the console *worse* than
   the fragmented screens.
2. **The inspector is one column, not four panels.** *Why*, *alternatives*, *history* and *actions* are
   all facets of **one selected object**. Splitting them across the screen is what forces navigation
   back today.
3. **Attention is a persistent band, not a modal or a tab.** It is the brief's strongest requirement and
   it is the thing that survives the operator looking away.
4. **The date is a label. Assign is a mode. The projection is a destination.** The first two are
   correctness (§11); the third is `#280 R2` (§29 P2).
5. **There is no "Commit all" bar.** §29 P8.

**Why not the brief's layout, specifically:** a bottom "Changes / Result / Confirmation" strip is the
right idea in the wrong place — the changes ledger (`GET /dispatch/changes-today`) is a **rail**, a peer
of unassignable and held, not a commit bar. Rendering it as a bar teaches an accumulate-then-commit
model the backend does not have.

---

## 23. What Should Be Inside the Console

| Capability | Why it belongs | Backend cost |
|---|---|---|
| The whole `GET /dispatch/today` payload (R1–R8) | It **is** the operating day | none |
| **All six overrides** (M6–M11) + impact preview | The operator's next act after reading a lane; **every id is already in the payload** | **none** |
| Assign one ticket · place/release a hold | The rails' only useful actions | none |
| Candidates for a selected plant | *"Why not them"* for a plant already on screen | none |
| Resolve an escalation + available-SEs | The interception strip's action | none |
| **Run dispatch + in-flight guard** (CSM/OH) | Already approved by `#282 R1`; currently on the wrong page | none |
| Decision stream + trace (Replay) | Already inline; extend to any chip | none for today's run |
| **Score breakdown + filter states** | Served and discarded — client types only | **none** |
| **Attention band** (§10) | The brief's strongest requirement | small: two `COUNT(*)`s to light existing cards |
| **Links out to the ticket journey and the plant's device table** | Closes the §0.2 disconnection | **none — one link each** |
| The work pool + distribute + assign-batch | **Contentious — §21, §29 P3** | none, but high design risk |

---

## 24. What Should Remain Supporting Surfaces

| Surface | Why it stays out | Confidence |
|---|---|---|
| **Dispatch Runs → Run → Zone → Batch** | Evidence is **immutable and separately addressable**; a run is its own object with its own lifetime; deep links must survive | high |
| **Scheduler Preview** | **Date-addressable for any IST day, all zones in scope**, and must never read as a commitment. The console is today-only and zone-only. Folding it in either loses the date range or makes "today" mean two things on one screen | high |
| **SE Planner** | A grid over **dates × plants**, affecting the **next** run. Not a today object | high |
| **Bulk Unassign** | OH-only, pan-India, its own verified-token flow. A genuinely different, rarer act | high |
| **Settings / weights / threshold / cron / coverage / capacity** | *Changing the engine's tuning is not operating it.* The console shows what **was** frozen (`configSnapshot`); settings changes what **will be**. Keeping them apart is what makes the frozen snapshot legible | high |
| **The `/tickets` queue and its drawer** | Owned by the ticket product; the scheduler contributes fields to it, not the reverse. **Link, don't absorb** | high |
| **The Zone Dashboard drill-down** | Same: a different clock and a different population (§13.3). **Link, don't absorb** | medium |
| **Readiness & Vehicle (return-date decisions)** | ⚠ **The weakest "stays out" on this list.** It is a queue of decisions a scheduler manager must make, and its outcome directly moves tickets in the plan. **Recommendation: the *count and the link* come into the console's attention band; the decision UI stays on its own page** | `[OPEN]` |
| **Cross-zone escalation · tier overrides · component requests · verification** | Adjacent modules the scheduler links to but does not own | high |
| **Build Health · Ops Explorer · Exports** | Platform diagnostics, not scheduler operation | high |

**The test that produced this list:** a capability belongs inside when **it is something an operator
does while looking at one operating day of one zone, and its identifiers are already in scope**. It
belongs outside when it is **a destination the operator navigates to deliberately, on its own object**
— a run, a date range, a config value, a different population.

**And the counter-test the brief rightly demands:** *does the user need to leave the console to
accomplish this?* For everything in the table above the answer is yes **and the leaving is the point** —
each one changes what object you are looking at. The three that failed the counter-test are already in
§23: the run trigger, the overrides, and the attention items.

---

## 25. Current Backend Constraints

The hard walls, restated compactly because every wireframe will hit them.

| # | Constraint | What it forbids |
|---|---|---|
| 1 | **No fleet-wide scheduler aggregate.** `GET /dispatch/today` is single-zone and *refuses to guess* | A pan-India cockpit |
| 2 | **`GET /dispatch/today` has no `date` parameter** | A date picker on live data; "yesterday's console" |
| 3 | **No websocket / SSE / event stream** | Live push. Polling only, stopped when the tab is hidden |
| 4 | **No run progress, no current zone, no heartbeat exposure** | A progress bar |
| 5 | **No cancel / pause / retry-zone API** | Any run-control affordance beyond "run now" |
| 6 | **No multi-action transaction.** Per-SE / per-lane by explicit ruling (`#262`, `#272 R8`) | An atomic "Commit all" |
| 7 | **`checkStaleness` has no route** | A staleness badge on the projection |
| 8 | **The override impact preview has no staleness signal at all** | A draft basket of previewed overrides that ages safely |
| 9 | **Acting-zone honoured on ~10 of 20 `/schedules` routes** | Two panes on one screen, silently scoped differently |
| 10 | **`componentBlockedWithheld` and `bucketlessDropped` are per-run only** | Showing all six funnel populations on the live surface |
| 11 | **The pool is pan-India for CSM/OH; the deck is one zone** | A merged board whose counts reconcile |
| 12 | **Cross-zone refusal styles are not uniform** — 403 on one route, 404 on another, silent omission on a third | One error-handling shape for a multi-pane screen |
| 13 | **`ESCALATED` has no exit and is excluded from every dispatch and recovery read** | Any promise that a chronic device will be revisited |
| 14 | **The scheduler has no per-ticket priority mechanism** | "Promote this ticket" |
| 15 | **The DEFICIT/PREVENTIVE threshold is a code constant** | Tuning the largest lever in the engine |
| 16 | **The admin app has no query cache** | Six panes over overlapping reads staying in sync after a mutation without a lifted fetch |

---

## 26. Backend Gaps Created by the Vision

### Blocking — the console would have to lie or omit

| # | Gap | Consequence | Fix shape |
|---|---|---|---|
| **B1** | `componentBlockedWithheld` + `bucketlessDropped` absent from `GET /dispatch/today` | Two of six funnel populations invisible; scraping the run detail mixes per-run with per-day figures | add both to `TodaySituation` |
| **B2** | A ZM cannot see `nextFireAt` or in-flight state | The ZM's own primary screen cannot explain an empty deck at 04:55 | read-only `GET /schedules/dispatch-schedule/next` for `MANAGER_ROLES`; widen in-flight, zone-clamped |
| **B3** | Acting-zone honoured on half the `/schedules` routes | Tolerable across pages; a **correctness bug** on one screen | finish the `#239` sweep |
| **B4** | Pool scope ≠ deck scope | A merged console shows a global pool beside a single-zone deck | decide the console's scope rule, then align one read |
| **B5 (new)** | **`ESCALATED` tickets are excluded from dispatch and auto-recovery with no exit path** | The console cannot honestly show a chronic device as "being worked on", and cannot show it at all | **This is a bug, not a feature request** — §29 P1 |
| **B6 (new)** | Special / ESCALATED / undecided-return-date counts are not on any zone-day read | The attention band has to make three extra round trips per zone, or the counts come from a different scope than the deck | one `GET /dispatch/today` extension, or a small `GET /attention?zoneId=` |

### Significant — the console works but is thinner

| # | Gap | Consequence |
|---|---|---|
| **S1** | `checkStaleness` implemented, no route | A preview cannot say it went stale. **The SDS says it can** |
| **S2** | `bucketsAsOf` returned only on a dry run | A real run cannot state its own data staleness while its preview can |
| **S3** | No `GET /tickets/:id/decision` | *"Why is this here?"* needs the run id first — the cause of steps 3–6 in §8 |
| **S4** | `heartbeat_at` on neither run DTO | Cannot distinguish "alive" from "about to be reaped" |
| **S5** | `changes-today.actorId` and `ticket_events.actor_id` are bare UUIDs with no name lookup | The operator-facing audit shows a UUID for the person who acted |
| **S6** | `assignment_threshold_hours` persisted on `dispatch_run_zones`, **absent from the DTO** | `recommended: 40` out of a 900 backlog is un-interpretable |
| **S7** | `filterStates` absent from `/candidates` | **Two vocabularies for one engine**, side by side on one console |
| **S8 (new)** | No ticket-level record that the scheduler *considered and withheld* a ticket | The journey has a hole exactly where a manager asks *"why has nobody been?"* (§12 hole 1) |
| **S9 (new)** | No history of previous ZM deferral dates — only the current `deferred_until` | *"This has been pushed four times"* is unanswerable for ZM deferrals (it **is** answerable for vehicle returns, via the supersession chain) |

### Needed only for the more ambitious console

| # | Gap | Needed for |
|---|---|---|
| **A1** | A fleet-wide scheduler aggregate | Any pan-India console view |
| **A2** | A change-set / multi-action commit construct | An honest "Commit all changes" |
| **A3** | A staleness verifier for the override impact preview | A draft basket of previewed overrides |
| **A4** | A `date` parameter on the cockpit read | "Yesterday's console" |
| **A5** | `plannerPinnedButDropped[]` on the trace | Copilot answering *"was my pin ignored?"* |
| **A6** | Outbox delivery state | Copilot answering *"did the engineer get told?"* |
| **A7** | An audit-browse endpoint | *"Every override in this zone this week"* |
| **A8 (new)** | A one-time scheduled run | §16.2 reading (b) |
| **A9 (new)** | A priority mechanism for chronic work — an ordering term, a manual promote, or a materialised Special counter | §10.2(6), and it is a **product** decision before it is a backend one |

### Non-gaps that look like gaps — do not "fix" these

`policyWithheld.itemised: false` is **a contract** (those tickets have no row to list) · `conflicts.onSite`
reading empty is **a seam** · `VEHICLE_ON_TRIP` / `COMPONENT_UNAVAILABLE` always `NOT_ENFORCED` is **two
unbuilt integrations honestly recorded** · `NOT_PROJECTABLE` on three overrides is **a deliberate
refusal** · candidates 7..N missing from a trace were **never stored** · `ticketsRemovedSince` is
**deliberately unattributed** · `GET /org/zones` **exists** and is roled for exactly CSM+OH (the UI spec
says otherwise and is wrong) · **Special not affecting sort is a ruling, not an oversight**.

---

## 27. UX Risks

Ranked by how expensive they are to discover late.

| # | Risk | Why it is real here | Mitigation |
|---|---|---|---|
| **R1** | **Mixed commitment** — a draft chip and a committed chip in one lane | The grammar's own first rule is *"never the same shape for two meanings"*; `/assign` writes nothing until commit, the deck writes on every move | Settle §29 P3 before any wireframe. If merged: a separate lane region, not a border colour |
| **R2** | **A projection read as a commitment** | `#280 R2` calls this *"a worse error than the present fragmentation"* | Conditional voice on projections; the projection stays a destination |
| **R3** | **One "not dispatched" number** | Six populations, four owners; collapsing them turns a supplier delay into an apparent outage | The counters are separate by contract, never summed |
| **R4** | **Two attention models that disagree** | `action-required` exists with 9 cards; a console-native list would be a tenth source | §29 P4 |
| **R5** | **Fleet counts read as dispatch counts** | UTC vs IST day; different populations; different thresholds (`inactivity_threshold_hours` vs `se_assignment_threshold_hours`) | Distinct band, distinct label, never adjacent to the funnel |
| **R6** | **Six panes drifting out of sync after a mutation** | No query cache; `useApiResource` is per-component | A lifted shared fetch, or make `UI§27`'s refetch contract mandatory rather than advisory |
| **R7** | **A control that 409s** | The legal action set is `(object × assignment state × role)`; getting it wrong is the "easy to learn" requirement failing on its own screen | Derive the action set from state, never from object type alone |
| **R8** | **A "Commit 7 changes" bar** | No backend construct; `#272 R8` rules per-item results and *"partial success is the normal case"* | Do not draw it until §29 P8 |
| **R9** | **Losing deep links and operator habit** | 18 surfaces, existing tests, `#281`'s cross-links, and `/verification` deep-links into a specific ticket tab | Redirects, and keep run/batch/zone URLs addressable |
| **R10** | **A console that promises chronic devices are prioritised** | §10.2 — the opposite is true today | Say nothing about priority until P1 |
| **R11** | **The CSM/OH landing state** | The backend refuses to guess a zone; their first moment is a picker | Remembered zone + an explicit "choose a zone" state; **do not fake a fleet view** |

---

## 28. Better Ideas / Alternatives Recommended

Six, each with the evidence that makes it better than the brief's version.

**1. Make the deck commandable *before* deciding whether to merge anything.**
`GET /dispatch/today` already returns every id the six overrides, the impact preview, assign, hold,
release, candidates and escalation-resolve need. Nothing in `#282 R5` forbids *calling* the owning
endpoint from the cockpit — it forbids *reimplementing* it. **This is the single largest reduction in
navigation cost available in the product and it needs zero backend change and overturns no ruling.**
`[CODE]` It also makes the merge question empirically answerable instead of architecturally
speculative: afterwards the cockpit *is* the console for everything except handing out work.

**2. Treat "Attention Required" as one model, owned by `GET /dashboard/action-required`, extended —
not replaced.** Two of its nine cards are wired; two more (vehicle unavailability, failed verification)
are a `COUNT(*)` each over data that is already served and already rendered. Adding Special and
ESCALATED as cards ten and eleven gives the console its attention band **and** fixes the dashboard,
from one source, with one definition. The alternative — a console-native attention list — creates the
second disagreeing queue described in R4.

**3. Connect the three orphaned surfaces with links, not absorption.** The ticket journey, the Special
attempt history and the plant device table are better than anything a console would build, and each is
one `<Link>` away from the ids already on screen (`ticketId`, `plantId`). **Three links buy most of the
brief's §9, §10 and half of §4.** Absorbing them buys the rest and costs a re-implementation of three
mature surfaces.

**4. Make the tense visible in the *voice*, not in a badge.** The brief asks for five states to stay
distinct (brief §18). Badges for five states is a legend nobody reads. The engine's own distinction is
mood: *"is assigned"* (committed) / *"was assigned by Priya at 09:14"* (human, past, attributed) /
*"would be assigned"* (projection) / *"will move to Ravi"* (proposed) / *"decided at 05:02"* (frozen).
Provenance already has a persisted, ruled grammar (`#282 R2`); **tense should be a second, orthogonal
axis carried by copy and one structural cue, not a sixth chip colour.** `[INFER]`

**5. Split the console by *question*, not by tense — and accept three surfaces, not one.**
The four dispatch nav rows exist because someone modelled four tenses. But operators do not ask about
tenses; they ask three questions: **"what is happening and what needs me"** (the console),
**"what would happen"** (the projection, date-addressable), **"what happened"** (the ledger, immutable
and separately addressable). Three surfaces map to three questions with no residue, and it is the
reduction the 2026-08-19 IA audit's F6 was actually asking for. **One surface is not the goal; the
right number is.**

**6. Fix the two role-blocking defects first, because they are hours and they gate everything.**
Two of three roles cannot open the primary screen (no zone picker; `GET /org/zones` already exists and
is roled for exactly them). The run trigger is on a page one of those roles cannot open, behind a button
that navigates to the wrong place. Both are known, both are approved, both were missed in `#285`.

---

## 29. Decisions We Need to Make

Ordered. **P1–P3 gate everything else; nothing below them can be settled first.**

**P1 — What should the system do with a chronically failing device?**
This is a **business** decision, not a UI one, and it is first because brief §4 assumes an answer the
code contradicts. Four sub-decisions:
 (a) Is `ESCALATED`-means-excluded-from-dispatch-with-no-exit a **bug** (fix it) or the intended
 behaviour (then the console must show that population honestly, and *"escalated"* is the wrong word)?
 (b) Should repeated failure **change dispatch order**? If yes, it is a term in `compareCandidates`,
 not a weight — and it is spec-pinned by ADR-0017.
 (c) Should a manager be able to **promote a specific ticket**? No such mechanism exists at any level.
 (d) `repeat_failure_penalty` is a live, editable, OH-facing weight that appears in every persisted
 breakdown and **changes no decision** (§10.2). Remove it, make it work, or document it as inert?

**P2 — Do we overturn `#280 R2` ("grouping and cross-linking, not merging")?**
R2 reserved this decision for the operator, *on evidence*, and warned that *"merging is irreversible in
the operator's mental model, while grouping is not."* The evidence now exists (three audits, one
forensic report, D, and this document). **Everything in §22 is downstream of this.**

**P3 — Do we overturn `#280 R7` (`/assign` stays separate)?**
Reaffirmed twice since it was made, and it carries **no** "revisit with evidence" clause. Merging
delivers the brief's stated goal and creates the mixed-commitment hazard (R1). If we merge: **how do we
make "not yet written" visually unmistakable in a lane that also holds committed work?** If we do not,
the console is idea 1 in §28 plus links.

**P4 — Is `GET /dashboard/action-required` the one attention model?**
Extend it (§28 idea 2), replace it, or run two? Two will disagree.

**P5 — What is the console's scope rule for CSM/OH?**
One zone always, a remembered zone, or a pan-India summary above a zone board? The backend refuses
"all zones" for the cockpit and happily serves a pan-India pool — that asymmetry has to be resolved by
a rule, not by a layout.

**P6 — Is the console exception-driven or plan-driven?**
Both readings are supported by the same payload. `#286` already ruled recovery sits **above** the deck,
which is a partial answer. The brief's emphasis on Attention Required implies exception-driven; the
current cockpit is plan-driven with rails aside.

**P7 — Do we unify the two candidate vocabularies?**
`/candidates` says `PASSED`/`DROPPED`; the trace says `PASSED`/`DROPPED`/`TIER_NOT_REACHED`. Defensible
on separate pages; **on one console they appear to contradict each other.**

**P8 — Should multiple changes accumulate before commit, and which ones?**
Assignments already do (per-lane transactions). Overrides do not, by ruling. A basket is buildable
**only** as "commits individually, reports individually" — and it widens the lost-race window.
`REORDER` is not composable at all.

**P9 — Does the deferral-approval queue come into the console?**
The count and the link, the whole decision UI, or neither? It is the strongest candidate on the
"stays out" list to move in (§24).

**P10 — "Save the next run date and time" — reading (a) or reading (b)?**
(a) is shipped and OH-only. (b) does not exist and is a real slice. §16.2 recommends (a) plus a
relocated "run now".

**P11 — What happens to `/schedules/:engineerId`, `/schedules`, `/intraday` and `/schedules/preview`
as routes?** Retire, redirect, or keep as deep-link targets? Each has tests, nav entries, cross-links
and operator habit behind it. `/intraday` is structurally dead and still occupies a nav row promising
the one thing it cannot show — but its escalation modal is live and must be relocated first.

**P12 — Do we fix B1–B4 before or alongside the console?**
B3 and B4 change from "confusing" to "**incorrect**" the moment two panes share a screen.

**P13 — Is Copilot v1 = Contextual Inspector + Operational Guide, both deterministic, no LLM?**
§17 argues yes, and that natural language is a different input method for answers the console can
simply render.

---

## 30. Proposed Next Design Discussion

**Recommended first topic: P1 — what the system should do with a chronically failing device.**

Not P2, and this is a deliberate departure from D§22, which recommended starting with the merge
question. The reasoning:

- **P1 is the only decision on the list where the current behaviour is plausibly wrong rather than
  merely fragmented.** Everything else is a question about *where* a working capability should live.
  P1 is a question about whether a population of tickets is being silently stranded.
- **It is the brief's own stated intent** (*"repeated failures can lead to priority treatment"*), and
  it is the one requirement where the answer is not "already built, wrong place."
- **It is cheap to inform and expensive to defer.** One query against each database answers *"how many
  tickets are sitting in `ESCALATED` right now, and for how long?"* If the answer is single digits, P1
  is a small fix and the discussion moves straight to P2. If it is hundreds, the console discussion
  should wait.
- **P2 and P3 need no more analysis to be decided** — they are operator judgement calls, and both D and
  this document have now supplied the evidence R2 asked for.

**Suggested agenda, in order:**

1. **Before the meeting (30 minutes of SQL, not a design task):** count `ESCALATED` tickets by age and
   zone; count Special tickets by zone; count undecided vehicle-return reports by age. All three are
   single queries against tables that exist. **These three numbers determine how much of brief §4 is a
   real operational problem versus a hypothesis.**
2. **P1** — decide (a)–(d). Expect (a) to be a bug fix.
3. **P4** — one attention model or two. Cheap to settle, and it unblocks the attention band.
4. **P2, then P3** — the two rulings, in that order. Nothing about layout is decidable before them.
5. **Agree to do §28 idea 1 and idea 6 regardless of the outcome** — commandable lanes, zone picker,
   relocated run trigger, rendered score breakdown and filter states, and three links to the orphaned
   surfaces. **All of it is required by every option, needs zero backend change, and overturns no
   ruling.** It is also the work that makes the merge question empirically answerable.
6. **Only then** discuss the information architecture in §22 — with the deck already commandable, the
   remaining question narrows to exactly one thing: *does the work pool come inside, and if so, how
   does a draft chip avoid looking like a committed one?*

**And one prerequisite outside the discussion entirely:** fix
`scheduler-preview.service.ts:221` (§0.1). Nothing can be built or verified against a tree that does not
compile.

---

*End of analysis. Nothing here was implemented; nothing here is final. This document exists to be
argued with.*
