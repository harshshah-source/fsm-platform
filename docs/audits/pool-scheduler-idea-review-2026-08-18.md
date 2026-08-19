# Pool-Based Scheduler — Architecture Review

**Investigation only. No code, schema, migration or data was modified.**

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Reviewing** | Proposed pool-of-tickets scheduler + pre-assignment staging area |
| **Method** | Traced actual implementation (`apps/backend/src`), FSM Postgres, AutoPlant production (read-only) |
| **Companion** | [`vehicle-presence-investigation-2026-08-18.md`](./vehicle-presence-investigation-2026-08-18.md) |

---

## 1. My Idea — Your Understanding

Restated plainly:

1. **Stop thinking in individual tickets.** An SE mapped to a plant owns a *pool* of that plant's
   device tickets, rather than a list of unrelated ticket rows.
2. **Insert a pre-assignment staging area with a UI.** When devices cross the inactivity threshold,
   the system produces a *proposed* assignment set. Admins can see it, override the recommended SE,
   change SE configuration, and change priority — **before** anything reaches an SE.
3. **Admin then chooses how it runs:** save it for the automatic 05:00 next-day run, or trigger a
   manual scheduler run.
4. **The run emits three ticket kinds:**
   - **General Pool ticket** — ordinary backlog work
   - **Priority ticket** — elevated
   - **Special ticket** — devices that keep reappearing in batches without ever being troubleshot,
     e.g. because the vehicle was never at the plant
5. **Batches go to the designated SE.** Resolved → reflected in the admin dashboard. Not resolved →
   also reflected, and the ticket is marked **Special**.
6. **Mobile:** the SE can enter the device's **return date and time**; the ticket is then dispatched
   according to that date.

### Where I may have misunderstood you — please correct

- **"Pool" is ambiguous.** I read it as *"the SE's work is organised as a per-plant collection"*. It
  could also mean *"tickets are unassigned and SEs pull from a shared queue"* — a genuinely different
  model (push vs pull). My analysis assumes **push with per-plant grouping**; if you meant pull, say
  so, because the answer changes materially (§5.7).
- **"Change SE configuration"** — I read this as *reassigning which SE gets this batch, and adjusting
  capacity/availability*, not editing the SE master record itself.
- **"Special ticket"** — I read the trigger as *"appeared in N batches without resolution"*. The
  codebase already uses "REPEAT" and "ESCALATED" for a **different** thing (device fixed, then failed
  again). These must not be conflated; see §5.4.
- **"Device return date"** — I read this as *the vehicle's* expected return to the plant, not the
  device hardware returning from a warehouse. The two exist separately in this system
  (`vehicle_unavailability_reports` vs `device_departures`).

---

## 2. Current System — What the Code Actually Does

Traced end to end. **Documentation disagrees with the implementation in three places; the code wins.**

### 2.1 The real pipeline

```text
AutoPlant ap_widgets.tb_vehiclemaster
    │  AutoPlantSourceReader — SELECTs 9 of 119 columns, keyset scan on device_id
    ▼
SnapshotIngestionService → raw_device_snapshots (partitioned by gps_datetime; lat/lon STORED)
    │  maintains device_states.latest_gps_datetime incrementally at ingest
    ▼
DeviceStateService.recompute() — set-based; derives inactivity_hours, is_inactive,
    │  sla_bucket, eligible_for_uptime, is_departed, and denormalised vehicle/plant/company
    ▼
TicketCreationService.createForInactiveEligible()
    │  6 predicates, none spatial → failure_cycle (OPEN) + ticket (TROUBLESHOOT/OPEN/UNASSIGNED)
    ▼
DispatchRunService.runForActiveZones()  ← cron `dispatch_cron` = "0 5 * * *" Asia/Kolkata
    │
    ├── RecommenderService.runForZone(zone)
    │      • select OPEN + UNASSIGNED + not-deferred + not-departed + past threshold
    │      • canonicalSort: Tier ↓ → Bucket ↓ → PriorityRank ↑ → Oldest ↑ → DeviceId ↑
    │      • per ticket: CandidateSelectionService → Dedicated → Multi-Plant → Floating
    │      • applyHardFilters (5 filters)
    │      • chosen = planner-bias ?? passed[0]        ← PRECEDENCE decides, not score
    │      • write recommendations row status=SUGGESTED + dispatch_decision_traces
    │
    └── BatchAssignmentService.dispatchForZone(zone)
           • per-zone pg_try_advisory_xact_lock
           • group SUGGESTED recs: se_id → plant_id → ticket_ids
           • work_schedules (1 per SE per day, ACTIVE)
           • plant_batch_assignments (1 per plant, with stop_sequence)  ← THE PLANT VISIT
           • batch_assignment_tickets (1 per ticket, sort_order)
           • ticket.assignmentState = FORMALLY_ASSIGNED, deferredUntil = null
           • recommendations SUGGESTED → DISPATCHED
```

### 2.2 Findings that matter for your idea

**A. Plant-visit batching already exists.** `plant_batch_assignments` is exactly *"SE → Plant A visit →
{vehicle 1..n}"*, with `stop_sequence` for route order and `sort_order` within the stop. Your "pool of
tickets per SE per plant" **is this table**. It is built, transactional, override-aware, and notified.

**B. A "shared pool" also already exists.** `SharedPoolService` (Issue 12) returns OPEN, unassigned
tickets at *all* the SE's covered plants as always-visible secondary work, deferral-aware and
coverage-scoped. It is read-only — there is no pick/claim mutation.

**C. `daily_capacity` means 25 TICKETS, not 25 visits.** `committedDayLoad()` counts
`batch_assignment_tickets` rows (non-removed) per SE across live schedules covering that date;
`overCapacity` compares that count to `engineer_master.daily_capacity`. One SE visiting one plant and
doing 10 vehicles consumes **10 capacity**, not 1. Travel is not modelled at all.

**D. The score does not choose the SE.** This surprised me. `recommender.service.ts`:

```ts
const chosen = (planned ? passed.find((c) => planned.has(c.seId)) : undefined) ?? passed[0] ?? null;
```

`scoreCandidate()` runs and is persisted into `score_breakdown` for explainability, but selection is
**strict coverage precedence** (Dedicated → Multi-Plant → Floating, `se_id` ascending within a tier),
with the SE Planner as a soft override. Consequences:
- The **Plant Cluster Multiplier is operationally inert** — it multiplies a score nothing reads.
- `distance` weight is inert; `distanceFromPrevStopKm` is always null (`scoreDegenerate === true`).

**E. Single-day only, and it is enforced by data, not just convention.** 709 `work_schedules` rows,
**zero** with `date_from <> date_to`. Unique index `work_schedules_one_active_per_se_zone_day`.
`se_planner` (multi-day ZM intent) holds **2 rows** and is soft bias only.

**F. Capacity — not coverage — is the binding constraint.** From `dispatch_run_zones`:

| Run | ALL_DROPPED | dropBucket | NO_COVERAGE | recommended |
|---|---:|---|---:|---:|
| worst | 5,621 | `OVER_CAPACITY: 5621` | 883 | 153 |
| typical | 5,263 | `OVER_CAPACITY: 5263` | 23 | 375 |
| typical | 5,168 | `OVER_CAPACITY: 5168` | 20 | 375 |

11,110 of 11,645 open Troubleshoot tickets sit at a plant that **does** have SE coverage. The system
is not failing to find an SE; it is running out of SE-days.

**G. Coverage is one SE per plant, essentially everywhere.**

| coverage_type | SEs | coverage rows | avg plants/SE | max |
|---|---:|---:|---:|---:|
| DEDICATED | 63 | 63 | 1.0 | 1 |
| MULTI_PLANT | 4 | 49 | 12.3 | 14 |
| FLOATING | 0 | — | — | — |

`engineer_territory_coverage` has **0 rows**, so the floating leg is entirely empty. Every one of the
top-12 backlog plants is covered by exactly **one** SE.

**H. `deferredUntil` is written in exactly one place.** `override.service.ts:203` (ZM
`DEFER_TICKET`), cleared at `batch-assignment.service.ts:182`. `notDeferredOn()` is the shared
predicate spread into the recommender, shared pool, intraday and cross-zone reads.

**I. The SE's "expected return date" is already captured — and then ignored.** The mobile app has
`tickets/vehicle-unavailability/VehicleUnavailabilityFormScreen.tsx`. `VehicleUnavailabilityService.fileReport()`
stores `expectedFrom` / `expectedTo`, pauses the SLA, and **does not touch `deferredUntil` or the
batch**. So the date the SE enters changes nothing about when the ticket comes back.

**J. A full override engine already exists — but post-dispatch.** `OverrideService` supports
`REMOVE_TICKET`, `DEFER_TICKET`, `REORDER`, `SWAP_SE`, `REASSIGN`, `SPLIT_BATCH`, plus `assignTicket`
and `assignPlants`. Its docstring states the architectural position explicitly:

> *"Dispatched directly — no approval gate (Decision §7, ADR-0007/0019 superseded); the ZM overrides
> post-hoc."*

**K. Vehicle presence is NOT implemented.** Confirmed: no presence column, no presence service,
`vehicleReadiness` hardcoded `'UNKNOWN'` at `recommender.service.ts:283`, `plants.location` NULL for
all 933 rows, `vehicle_unavailability_reports` has 0 rows.

### 2.3 Where the docs are wrong

| Claim | Reality |
|---|---|
| `CLAUDE.md`: mobile is "auth shell only so far" | Mobile has tickets, troubleshoot, verification, recovery, install, vehicle-unavailability, intraday, leave, availability, stock, vouchers, notifications, offline write queue |
| Threshold default 24 h | `se_assignment_threshold_hours = 48` in `system_settings` |
| Eligibility via PGI | `eligibility_mode = all-deployed` (PGI feed unbuilt) |

---

## 3. Can My Idea Work?

> ## YES, WITH CHANGES
>
> — but with a significant reframing, and one part I recommend you **reject**.

Breaking the idea into its five real parts:

| Part | Verdict | Why |
|---|---|---|
| Pool of tickets per SE per plant | **Already exists** — no work needed | `plant_batch_assignments` + `batch_assignment_tickets` is precisely this |
| Pre-assignment staging area with admin override | **Works, but reverses a documented decision and I recommend against a blocking gate** | See §5.1 — it makes a human the throughput ceiling of a system already 5,000 tickets/day over capacity |
| Three ticket types (General / Priority / Special) | **Partially — needs restructuring** | Conflates three orthogonal axes; "Special" collides with existing REPEAT/ESCALATED semantics |
| Manual run / autorun at 05:00 | **Already exists** | `dispatch_cron` setting + `POST /api/schedules/dispatch-run` manual trigger, both idempotent |
| Mobile device return date → dispatch accordingly | **YES — this is the best idea in the set** | Data already captured; needs one link to `deferredUntil` |

**The honest headline:** roughly 60% of your idea is already built. Of the genuinely new 40%, one part
(return-date-driven dispatch) is excellent and cheap, one part (Special tickets) is a good instinct
implemented at the wrong layer, and one part (blocking approval gate) I think will hurt you.

**And the thing that would actually solve your business problem is not in the idea at all:** vehicle
presence filtering. Your "Special ticket" mechanism *detects* the wasted-trip problem after several
wasted trips. AutoPlant can *predict* it before the first one.

---

## 4. What Is Good About My Idea

Genuinely valuable, in order of value:

1. **Return-date-driven re-dispatch is the standout.** You correctly spotted that the SE is the best
   sensor for "when is this truck back", and that the system currently wastes that information. The
   plumbing exists on both ends (`expectedFrom` is captured; `deferredUntil` + `notDeferredOn()` is a
   working deferral machine). Nobody connected them. This is a small change with a large effect.

2. **You have identified the right *symptom*.** "Devices that are repetitively in batch as they are
   not troubleshot" is exactly the signature of the vehicle-presence loophole — you inferred from
   operational reality what the AutoPlant investigation measured at 79.9%.

3. **Plant-centric thinking is operationally correct.** An SE travels to a plant, not to a ticket.
   Treating the plant visit as the unit of work is right, and the architecture already agrees with
   you — but capacity accounting does not (§5.3).

4. **Admin visibility before commitment has real value** — just not as a blocking gate. A *preview*
   of tomorrow's plan is genuinely useful and currently missing: today the only way to see what the
   engine will do is to let it do it.

5. **Distinguishing "stuck" work from "new" work is right.** A ticket that has been dispatched four
   times and never touched is a different management object from a fresh one, and today the system
   cannot tell them apart at all.

---

## 5. Problems / Weaknesses

I am going to be blunt, because you asked me to be.

### 5.1 The staging gate makes a human the bottleneck of an already-overloaded system

The numbers: ~375 recommendations produced per run, against 5,000+ `OVER_CAPACITY` drops and 11,956
open tickets. A daily human approval step on that volume will either (a) become a rubber stamp, which
is worse than no gate because it manufactures false assurance and an audit trail implying review that
did not happen, or (b) become a genuine bottleneck, and the backlog grows on days the admin is busy.

It also **reverses a decision the codebase made deliberately and recorded**: *"Dispatched directly —
no approval gate (Decision §7, ADR-0007/0019 superseded); the ZM overrides post-hoc."* Someone
already considered an approval gate, adopted it (ADR-0007/0019), and then **superseded** it. Before
rebuilding it, we should know why it was removed — that history is the single most relevant piece of
evidence and it is not in the code comments.

> **This is an architecture + business-rule decision and per `CLAUDE.md` Strategic HITL it is yours,
> not mine.** My recommendation: **non-blocking preview + post-hoc override** (§6.1). But if you
> want the blocking gate, it is buildable and I will build it.

### 5.2 "Pool of tickets" does not add a capability

If pool = per-plant grouping, `plant_batch_assignments` already is it. Renaming an existing table
does not change what an SE receives or how capacity is consumed. **The valuable part of "pool"
thinking is not the grouping — it is the capacity accounting** (§5.3), and that part your idea does
not address.

### 5.3 Capacity semantics are wrong for plant-visit work, and the idea does not fix it

Today: `daily_capacity = 25` = 25 tickets/day, regardless of geography.

That means an SE doing 25 devices at **one** plant and an SE doing 25 devices across **five** plants
consume identical capacity, which is operationally false — the second SE spends the day driving. And
conversely, an SE who arrives at a plant with 40 present vehicles is capped at 25 and must return
another day for a plant they are already standing in.

If you move to plant-pool thinking, this becomes the central question and it needs an explicit
answer. Candidate models in §6.4.

### 5.4 "Special ticket" collides with existing vocabulary and is a lagging indicator

Two problems.

**Vocabulary.** The system already has `failure_cycles.repeat_failure` / state `REPEAT` (device was
fixed, then failed again within 24 h — ADR-0021) and state `ESCALATED` (3 repeats in 7 days,
`RepeatEscalationService`). Your "Special" means something completely different: *never fixed,
because we could not reach the vehicle*. Reusing adjacent language for an opposite meaning will cause
real bugs — a REPEAT is a device the SE **did** touch; a Special is one they **could not**.

**Timing.** Detecting "stuck" by counting failed dispatches means the detection cost is paid in
wasted SE trips. At 79.9% of inactive vehicles being away, if a Special needs 3 undispatched cycles
to declare itself, that is up to 3 wasted visits per device across a population where ~1,750 of the
~2,190 genuinely-inactive devices would qualify.

AutoPlant can answer "is the truck there?" *before* the first dispatch, with `source_exit_time` and
open `YARD` detention — both of which keep working after the tracker dies.

**Special is worth keeping, but as a fallback for the cases presence cannot resolve** (the ~27% with
no plant coordinates, `LOCATION_UNKNOWN`), not as the primary mechanism.

### 5.5 Three "types" conflates three orthogonal axes

`General Pool / Priority / Special` mixes:

- **Priority** — already fully modelled: `company_tier` × `sla_bucket` × `company_priority_rank`, with
  zone-scoped tier overrides (Issue 157) and a canonical comparator. A "Priority ticket" type would be
  a *fourth* competing priority mechanism.
- **Assignment state** — already modelled: `UNASSIGNED` / `FORMALLY_ASSIGNED` + Shared Pool visibility.
- **Diagnosis** — "we keep failing to service this" — genuinely absent.

Only the third is a new concept. Modelling all three as one enum will make the priority logic
ambiguous and the canonical sort unexplainable.

### 5.6 The idea does not address starvation, and starvation is real for the multi-plant SEs

`canonicalSort` has **no plant-fairness term**: Tier → Bucket → Rank → Age → DeviceId. For the 63
DEDICATED SEs this does not matter (their capacity can only be consumed by their one plant). For the
**4 MULTI_PLANT SEs covering 49 plants** (avg 12.3, max 14), a single large or old plant will consume
the SE's 25 before smaller plants are reached, every day, indefinitely. Your Plant A(500) / B(20) /
C(5) example is exactly this case, and today Plant C is starved.

Pooling by plant **makes this worse, not better**, unless a fairness/rotation term is added: if the
unit of dispatch becomes "a plant visit", the SE goes to one plant per day and the other 13 wait.

### 5.7 Push vs pull is unresolved, and it changes the answer

If "pool" means SEs *pull* work, that is a different system: capacity becomes self-regulating, the
recommender's role shrinks to ranking, and the Shared Pool needs a claim mutation it deliberately
does not have (it is documented read-only, with a Business-409/Shadow-Use conflict model). I have not
evaluated pull in depth because I do not think that is what you meant — tell me if it is.

### 5.8 Presence must be re-evaluated at dispatch, and the idea evaluates it once

Your flow evaluates state at ticket creation / staging. But an admin saves a plan at 18:00 and it
runs at 05:00 — 11 hours in which trucks leave and arrive. Any presence-aware design needs the check
**immediately before dispatch**, not only at staging (§9).

---

## 6. Recommended Improvements

### 6.1 Replace the blocking gate with a non-blocking preview + a hold list

Keep everything you wanted to see; drop the requirement that a human acts before work flows.

- **Tomorrow's Plan (preview)** — a read-only projection of what the 05:00 run will produce, available
  any time. Cheap: run the recommender in dry-run mode against a target date, persist nothing.
- **Hold list** — an admin can *pre-empt* specific tickets/plants/SEs before the run (a pre-dated
  `deferredUntil`, or a new pre-assignment override row). Absence of admin action = the run proceeds.
- **Post-hoc override stays** — `OverrideService` already does this well.

You get admin control and visibility; the system keeps flowing when nobody is at a desk.

### 6.2 Wire the SE's return date into deferral — do this first

The single highest value-to-effort change in your whole idea.

```text
VehicleUnavailabilityService.fileReport()
    ├── (today) create report row
    ├── (today) pause primary SLA
    ├── (NEW)   ticket.deferredUntil = expectedFrom
    ├── (NEW)   ticket.assignmentState = UNASSIGNED
    └── (NEW)   remove from the live batch (reuse OverrideService.removeTicket semantics)
```

`notDeferredOn()` then does the rest for free — the recommender, Shared Pool, intraday and cross-zone
sweeps all already spread that predicate. The ticket automatically returns to the pool on the date the
SE said the truck would be back.

Guardrails: cap how far out a date may be set; require a reason code (already mandatory); keep the
secondary never-pausing SLA clock so a truck "expected back" repeatedly cannot hide forever.

### 6.3 Add vehicle presence as the primary filter, Special as the fallback

Per the companion investigation:

| Presence | Source | Dispatch policy |
|---|---|---|
| `AT_PLANT` | Open `YARD` detention at own plant · `vehicle_location_status=ATPLANT` · fresh fix ≤2 km with no later gate-out | Dispatch, ranked normally |
| `AWAY_ON_TRIP` | `source_exit_time > source_entry_time`, no return | Hold; auto-return on gate-in |
| `AWAY_NOT_ON_TRIP` | No trip, last fix >2 km, ≤30 d old | Hold; flag for ZM |
| `AT_OTHER_PLANT` | Open `YARD` detention at a different `plant_code` | Route to that plant if covered, else ZM |
| `LOCATION_UNKNOWN` | No plant coords / no fix / >30 d stale | Dispatch, ranked **below** `AT_PLANT` → **and this is where Special earns its keep** |

Special then means: *"`LOCATION_UNKNOWN` **and** N dispatch attempts with no resolution"* — a small,
well-defined residue rather than the main flow.

### 6.4 Decide capacity semantics explicitly

Three coherent options. My recommendation is **B**.

| Model | Rule | Pros | Cons |
|---|---|---|---|
| **A — Status quo** | 25 tickets/day | Simple, already built | Ignores travel; punishes single-plant density |
| **B — Ticket capacity + visit cost** *(recommended)* | Each ticket costs 1; **each additional plant stop costs `plant_stop_cost`** (e.g. 5) | Small change to one counter; expresses the real trade-off; makes clustering emerge naturally instead of via an inert multiplier | One new setting to tune |
| **C — Visit-based** | Capacity = N plant visits/day; vehicles per visit uncapped | Matches field reality closest | Loses per-device SLA accounting; a 500-vehicle plant becomes one "unit" |

Model B also **revives the Plant Cluster Multiplier's intent** by putting it somewhere that actually
binds (the capacity counter) rather than in a score nothing reads.

### 6.5 Add plant fairness to the canonical sort — only for shared SEs

Do **not** reorder the global comparator; it is spec-pinned (ADR-0017) and tested. Instead add a
bounded per-run guard for multi-plant/floating SEs: *no single plant may consume more than X% of a
shared SE's daily capacity while other covered plants have tickets past threshold.* This fixes Plant C
starvation without touching priority semantics.

### 6.6 Model the three "types" as three fields, not one enum

```text
ticket.company_tier          (exists)   priority
ticket.sla_bucket via device (exists)   urgency
ticket.assignment_state      (exists)   pooled vs assigned
ticket.service_blocked_reason (NEW)     why we cannot service it — the real gap
ticket.blocked_attempt_count  (NEW)     how many dispatches it has survived
```

"Special" becomes a *view* over `service_blocked_reason IS NOT NULL AND blocked_attempt_count >= N`,
not a ticket type.

---

## 7. Proposed Final Algorithm

Plain English, then pseudocode.

**Ingest** telemetry plus four new columns and a bounded trip/gate read. **Resolve presence** per
device into one of five states. **Create tickets exactly as today** — presence never suppresses
creation, because Fleet Uptime must keep counting a broken device. **At dispatch**, filter by presence,
rank `AT_PLANT` above `LOCATION_UNKNOWN`, never dispatch `AWAY_*`. **Re-check presence immediately
before commit**. **When an SE reports a truck absent**, defer the ticket to the date they give.
**When AutoPlant records a gate-in**, un-defer automatically.

```text
# ---------- 1. INGEST (every 30 min) ----------
snapshot_run:
    for chunk in keyset_scan(tb_vehiclemaster, order=device_id):
        upsert raw_device_snapshots
        upsert device_states.latest_gps_datetime, trip_creation_datetime
        # NEW — same query, no extra round trip:
        upsert device_states.latest_lat, latest_lon,
               active_trip_id, vehicle_location_status, detention_type, source_plant_code

    # NEW — one bounded extra read, scoped to FSM-tracked devices only
    for chunk in device_ids:
        read tb_tripmaster  where trip_id IN (active_trip_ids)
             -> trip_status, trip_substatus, source_entry_time, source_exit_time, destination
        read tb_trip_detention where device_id IN chunk AND detention_end_time IS NULL
             -> detention_type, plant_code, detention_start_time
    upsert device_vehicle_presence            # NEW table, one row per device

# ---------- 2. PRESENCE RESOLUTION (pure function) ----------
resolve_presence(device, plant, now) -> (state, reason, confidence, checked_at):

    if open_yard_detention(device) at plant.code:
        return AT_PLANT, "OPEN_YARD_DETENTION", HIGH

    if open_yard_detention(device) at other_plant:
        return AT_OTHER_PLANT, "YARD_DETENTION_ELSEWHERE:" + other_plant, MEDIUM

    if vehicle_location_status == "ATPLANT":
        return AT_PLANT, "SOURCE_ASSERTS_ATPLANT", HIGH

    if active_trip:
        # Trip alone is NOT departure — 641 vehicles are trip-assigned and standing at the plant.
        if trip.source_exit_time IS NULL or trip.source_exit_time <= trip.source_entry_time:
            return AT_PLANT, "TRIP_NOT_YET_DEPARTED", HIGH        # Example 4
        if trip.source_exit_time > last_gate_in_at_plant:
            return AWAY_ON_TRIP, "GATE_OUT@" + source_exit_time, HIGH

    if plant.location IS NULL:
        return LOCATION_UNKNOWN, "NO_PLANT_COORDS", HIGH

    if last_fix IS NULL or fix_age > 30d:
        return LOCATION_UNKNOWN, "STALE_FIX:" + fix_age, HIGH

    d = ST_Distance(last_fix, plant.location)
    if d <= presence_radius_m:                                    # default 2000
        return AT_PLANT, "GPS_WITHIN_RADIUS:" + d, (fix_age<=3d ? HIGH : MEDIUM)
    else:
        return AWAY_NOT_ON_TRIP, "GPS_OUTSIDE_RADIUS:" + d, MEDIUM

# ---------- 3. TICKET CREATION (unchanged gate) ----------
# Presence deliberately absent here. A silent device is broken wherever it is.
if inactivity_hours >= threshold and eligible and no_open_cycle and not departed:
    create failure_cycle + ticket(OPEN, UNASSIGNED)

# ---------- 4. PREVIEW (new, non-blocking) ----------
GET /api/schedules/preview?date=D
    -> run recommender in DRY_RUN (persist nothing), return the projected plan
    -> admin may place holds: ticket.deferred_until = D+1, or plant/SE hold rows

# ---------- 5. DISPATCH RUN (05:00 IST, or manual) ----------
for zone in active_zones:
    tickets = OPEN + UNASSIGNED + notDeferredOn(today) + not departed + past threshold
    tickets = canonical_sort(tickets)

    # NEW — presence gate, applied here not at creation
    dispatchable, held = [], []
    for t in tickets:
        p = presence_for(t.device)                  # read the precomputed row
        if p.state == AT_PLANT:            dispatchable.append((t, rank=0))
        elif p.state == LOCATION_UNKNOWN:  dispatchable.append((t, rank=1))   # below AT_PLANT
        elif p.state == AT_OTHER_PLANT:    reroute_or_flag(t, p); held.append(t)
        else:                              held.append(t)        # AWAY_ON_TRIP / AWAY_NOT_ON_TRIP
        record ticket.presence_state, presence_reason, presence_checked_at

    dispatchable.sort(by=(rank, canonical_order))

    for t in dispatchable:
        candidates = ordered_candidates_for_plant(t.plant)         # unchanged
        readiness  = hard_filters(candidates)                      # unchanged
        chosen     = planner_bias(readiness) ?? readiness[0]       # unchanged
        if chosen is None: record UNASSIGNABLE; continue

        # NEW — capacity model B
        cost = 1 + (plant_stop_cost if t.plant not in se_plants_today[chosen] else 0)
        if load[chosen] + cost > capacity[chosen]: record OVER_CAPACITY; continue

        # NEW — plant fairness, shared SEs only
        if chosen.coverage_type != DEDICATED
           and plant_share[chosen][t.plant] >= fairness_cap
           and other_covered_plants_have_work(chosen):
               record FAIRNESS_DEFERRED; continue

        write recommendation(SUGGESTED)
        load[chosen] += cost;  plant_share[chosen][t.plant] += 1

    # ---- batch assignment (inside per-zone advisory lock) ----
    for rec in SUGGESTED recs:
        # NEW — final presence re-check inside the tx, closes the staging→dispatch window
        if presence_for(rec.ticket.device).state in (AWAY_ON_TRIP, AWAY_NOT_ON_TRIP):
            mark rec CONSUMED_STALE_PRESENCE; continue
        ... existing work_schedule / plant_batch_assignment / batch_assignment_ticket writes

# ---------- 6. FIELD FEEDBACK ----------
on SE files vehicle_unavailability(expectedFrom):
    ticket.deferred_until   = expectedFrom
    ticket.assignment_state = UNASSIGNED
    remove from live batch
    pause primary SLA (existing); secondary SLA keeps running (existing)
    ticket.blocked_attempt_count += 1
    ticket.service_blocked_reason = reason_code

# ---------- 7. AUTO-RETURN ----------
on ingest, if device had AWAY_* and now has:
       open YARD detention at own plant, OR trip COMPLETED/ATSOURCE, OR fresh fix within radius:
    ticket.deferred_until = NULL          # returns to the pool on the next run
    record presence transition
```

---

## 8. Scheduling Example — 100 inactive vehicles, Plant A, 3 SEs

Assumptions: 3 SEs covering Plant A, `daily_capacity = 25`, `plant_stop_cost = 0` (single plant, so
models A and B agree here). Presence mix uses the measured production distribution (20% at plant, 61%
on trip, remainder away/unknown):

```text
AT_PLANT          20      AWAY_ON_TRIP        61
AWAY_NOT_ON_TRIP  12      LOCATION_UNKNOWN     7
```

Ticket ages spread across CRITICAL (40), SEVERE (35), VERY_SEVERE (25).

### Current system (no presence)

| Day | Dispatched | Actually serviced | Wasted trips | Backlog left |
|---:|---:|---:|---:|---:|
| 1 | 75 (25 × 3) | ~15 | **~60** | 25 |
| 2 | 25 + re-dispatched 60 → capacity-capped at 75 | ~5 new + repeats | ~55 | ~25 |
| 3 | 75 | ~4 | ~56 | ~25 |
| … | churns indefinitely | | | |

The 60 wasted tickets return to `UNASSIGNED` only if an SE files a VU report (0 filed to date) —
otherwise they sit `FORMALLY_ASSIGNED` in a stale batch. **Three SEs are consumed for ~15 real jobs.**

### Proposed system (presence-gated, capacity model B)

| Day | Dispatchable | Assigned | Serviced | Notes |
|---:|---:|---:|---:|---|
| 1 | 20 `AT_PLANT` + 7 `UNKNOWN` = 27 | SE-1: 25 (20 AT_PLANT first, then 5 UNKNOWN) | ~22 | **SE-2 and SE-3 freed for other plants** — 50 capacity recovered |
| 2 | 2 carried + returns | SE-1: ~8 | ~7 | 5 vehicles gate-in overnight → auto-undeferred |
| 3 | returns only | SE-1: ~6 | ~6 | steady trickle as trucks come back |
| 4–10 | returns | ~5–8/day | | 61 `AWAY_ON_TRIP` return over ~2 weeks |
| ~14 | — | — | 100 devices addressed | with ~8 wasted trips instead of ~170 |

**The headline difference is not speed — it is that 50 SE-days over two weeks are returned to other
plants**, which is exactly the capacity the `OVER_CAPACITY` drops are starving.

### Reality check against production

The measured configuration is worse than this example. **KESORAM WORKS: 1,443 open tickets, exactly
one covering SE, capacity 25/day = 58 days of backlog.** Presence-filtered at 20%, that becomes ~289
real jobs ≈ **12 days** — and KESORAM is also the plant with *no* recoverable coordinates from
`tb_legmaster`, so it would run on the fallback centroid (17.1598, 77.2889) or sit in
`LOCATION_UNKNOWN`. It is simultaneously the biggest prize and the hardest case.

---

## 9. Vehicle Availability Interaction

**When presence is evaluated — three points, deliberately:**

| Point | Purpose | Cost |
|---|---|---|
| **At ingest** (every 30 min) | Maintain `device_vehicle_presence` | Amortised; no per-ticket queries |
| **At dispatch selection** | Filter + rank the run list | Local Postgres read |
| **Inside the batch transaction** | Final re-check before commit | Local Postgres read |

Presence is **never** evaluated at ticket creation — a silent device is a fault wherever it stands,
and gating creation would corrupt Fleet Uptime.

| State | Ticket | Dispatch | SLA | Auto-return trigger |
|---|---|---|---|---|
| `AT_PLANT` | Open | **Yes**, ranked first | Running | — |
| `AWAY_ON_TRIP` | Open | **Held** | Primary pauses, secondary runs | Gate-in at own plant, or trip → `COMPLETED/ATSOURCE` |
| `AWAY_NOT_ON_TRIP` | Open | **Held**, ZM-visible | Primary pauses, secondary runs | Fresh fix within radius |
| `AT_OTHER_PLANT` | Open | **Rerouted** if an SE covers that plant, else ZM decision | Running | Gate-in at own plant |
| `LOCATION_UNKNOWN` | Open | **Yes**, ranked below `AT_PLANT` | Running | n/a — this is the Special candidate pool |

**If the vehicle moves between evaluation points:** the in-transaction re-check catches departures
(rec marked `CONSUMED_STALE_PRESENCE`, ticket stays `UNASSIGNED`). Arrivals between points are simply
picked up next run — failing toward *not dispatching* is the safe direction, since a wasted trip costs
a day and a one-run delay costs 24 h on a device already silent 48 h+.

**Worked examples from your brief:**

- **Ex. 1 (one vehicle, present):** `AT_PLANT` via detention or GPS → dispatched day 1. Unchanged
  from today except it is now *known* to be present rather than assumed.
- **Ex. 3 (on trip, `source_exit_time` populated):** `AWAY_ON_TRIP` → held, SLA primary paused,
  secondary running, ZM sees expected return from `onward_updated_eta`. **No SE dispatched.**
- **Ex. 4 (trip `INITIATED/ATSOURCE`, `source_exit_time` NULL):** the algorithm returns
  `AT_PLANT, "TRIP_NOT_YET_DEPARTED"` — **explicitly handled**, and this is why trip status alone is
  never treated as departure. 641 vehicles fleet-wide are in this state.
- **Ex. 5 (returns, GPS still dead):** AutoPlant records the gate-in via `tb_trip_detention` (open
  `YARD` row) or a trip closing `COMPLETED/ATSOURCE`. Both are order-driven and survive tracker
  death, so **yes — auto-re-eligible without any GPS recovery.** This is the strongest argument for
  the whole design.
- **Ex. 6 (at another plant):** `AT_OTHER_PLANT`. Reroute if covered — but note only 4 MULTI_PLANT
  SEs exist, so in practice most cases become a ZM decision, not an automatic reroute.
- **Ex. 7 (500/20/5 backlog):** presence cuts each by ~80%; the fairness cap (§6.5) stops Plant A's
  remainder from consuming a shared SE's whole day. With today's 1-SE-per-plant reality, Plant C's
  dedicated SE is unaffected either way — starvation only bites the 4 shared SEs.

---

## 10. SE Planner Interaction

**Recommendation: keep it a soft preference for now; promote it only if you commit to multi-day
planning as a separate decision.**

Reasoning from the data: `se_planner` holds **2 rows**. It is not in use, so there is no operational
evidence that a stronger planner is wanted. Promoting an unused mechanism to authoritative would make
it a required input nobody currently fills in — every unplanned plant would then need a fallback path,
which is just today's recommender with extra steps.

What *would* justify promotion: if you adopt plant-visit capacity (model C) or multi-day planning,
the planner becomes the natural place to express *"Mahesh: Plant A Mon/Tue, Plant B Wed"*. The table
already supports arbitrary dates. Until then, soft bias is correct.

One concrete improvement regardless: the planner is currently consulted only for *today*
(`plannerForDate(zoneId, now)`). If preview (§6.1) lands, it should read the planner for the
**preview date**, so an admin planning ahead sees the effect.

---

## 11. Required Code Changes

**Listed, not modified.**

### Must change

| File | Change |
|---|---|
| `ingestion/autoplant/autoplant-source-reader.ts` | Extend `SELECT_COLS` by `active_trip_id`, `vehicle_location_status`, `detention_type`, `plant_code` |
| `ingestion/autoplant/mapping.ts` | Map the four new columns; keep the skew guard untouched |
| `ingestion/snapshot-ingestion.service.ts` | Persist lat/lon + new columns onto `device_states` |
| `ingestion/autoplant/` **(new)** `trip-gate-reader.ts` | Bounded read of `tb_tripmaster` + `tb_trip_detention`, scoped to tracked devices |
| `device-state/` **(new)** `vehicle-presence.service.ts` + `presence-rules.ts` | Pure resolver + persistence; `presence-rules.ts` must be a pure function for testability |
| `ingestion/autoplant/master-sync.service.ts` | Resolve and write `plants.location` from `tb_legmaster`, with provenance |
| `recommender/recommender.service.ts` | Presence filter + rank; capacity cost model B; fairness cap |
| `scheduling/batch-assignment.service.ts` | In-transaction presence re-check before commit |
| `ticketing/vehicle-unavailability.service.ts` | Set `deferredUntil` = `expectedFrom`; unassign; remove from batch; increment blocked counters |

### Should change

| File | Change |
|---|---|
| `scheduling/dispatch-run.service.ts` | `DRY_RUN` mode for preview; hold-list support |
| `scheduling/schedules.controller.ts` | `GET /api/schedules/preview?date=` |
| `recommender/hard-filters.ts` | Either wire `vehicleReadiness` properly or **delete it** — a permanently-`UNKNOWN` filter is misleading dead code |
| `ticketing/ticket-creation.service.ts` | No logic change; stamp initial presence for visibility |
| `apps/admin/src/pages/…` | Preview screen; presence column on ticket/queue views; Special/blocked view |
| `apps/mobile/src/tickets/vehicle-unavailability/VehicleUnavailabilityFormScreen.tsx` | Surface "ticket will return on {date}" so the SE sees their input has an effect |
| `reports/` | Presence-aware Fleet Uptime denominators must **not** change; add a separate serviceability metric |

### Do not change

- `canonical-sort.ts` — spec-pinned (ADR-0017), tested; add fairness *around* it, not inside it
- `deferral.ts` / `notDeferredOn()` — the correct shared predicate; reuse, don't fork (see the #153 six-copies incident)
- `device_departures` semantics — fleet departure, distinct from plant absence; conflating them will resurrect the run-65 incident class
- Per-zone advisory lock + partial-unique indexes in `batch-assignment.service.ts`
- `eligibility.ts` / Fleet Uptime denominator
- The AutoPlant read-only seam guard in `autoplant-mysql.client.ts`

---

## 12. Required DB Changes

**Listed, not executed.** Derived from the algorithm, not assumed.

```sql
-- plants: the prerequisite for every geofence rule
plants.location              geometry(Point,4326)   -- EXISTS, 0/933 populated
plants.location_source       text                   -- NEW: 'LEGMASTER' | 'DETENTION_CENTROID' | 'MANUAL'
plants.location_confidence   text                   -- NEW: HIGH | MEDIUM | LOW
plants.location_sample_size  int                    -- NEW: legs/vehicles behind the centroid
plants.location_updated_at   timestamptz            -- NEW
CREATE INDEX ON plants USING GIST (location);        -- NEW

-- device_states: carried-through source columns
device_states.latest_lat                double precision   -- NEW
device_states.latest_lon                double precision   -- NEW
device_states.active_trip_id            text               -- NEW
device_states.vehicle_location_status   text               -- NEW
device_states.detention_type            text               -- NEW

-- device_vehicle_presence: NEW table, one row per device
  device_id            text PRIMARY KEY REFERENCES devices
  presence_state       enum(AT_PLANT, AWAY_ON_TRIP, AWAY_NOT_ON_TRIP, AT_OTHER_PLANT, LOCATION_UNKNOWN)
  presence_reason      text          -- human-readable, e.g. 'GATE_OUT@2026-08-16 01:53:18'
  confidence           enum(HIGH, MEDIUM, LOW)
  distance_m           double precision
  evidence_source      enum(YARD_DETENTION, SOURCE_STATUS, TRIP_GATE, GPS_RADIUS, NONE)
  observed_plant_code  text          -- for AT_OTHER_PLANT
  checked_at           timestamptz
  INDEX (presence_state), INDEX (checked_at)

-- tickets: dispatch-side state
tickets.presence_state         text        -- NEW: snapshot at last dispatch decision
tickets.presence_reason        text        -- NEW
tickets.presence_checked_at    timestamptz -- NEW
tickets.service_blocked_reason text        -- NEW: replaces the "Special" type
tickets.blocked_attempt_count  int NOT NULL DEFAULT 0  -- NEW
tickets.deferred_until         date        -- EXISTS, reuse unchanged
INDEX ON tickets (presence_state) WHERE status='OPEN' AND assignment_state='UNASSIGNED';

-- engineer_master: capacity model B
engineer_master.daily_capacity  int         -- EXISTS, semantics documented as TICKETS
system_settings 'plant_stop_cost'           -- NEW: additional-stop cost, default 5
system_settings 'presence_radius_m'         -- NEW: default 2000
system_settings 'presence_stale_hours'      -- NEW: default 720 (30 d)
system_settings 'plant_fairness_cap_pct'    -- NEW: default 60
```

**Not needed:** no new ticket-type enum (rejected in §6.6), no new assignment state (deferral already
returns tickets to `UNASSIGNED`), no schedule-model change unless multi-day is adopted separately.

---

## 13. Required AutoPlant Changes

**No writes. No schema changes. Read-only throughout.** Two additional reads beyond today's nine
columns:

| Read | Table | Scope | Bounding |
|---|---|---|---|
| 4 extra columns | `ap_widgets.tb_vehiclemaster` | Same keyset scan | **Zero extra queries** — same rows |
| Trip + gate state | `ap_widgets.tb_tripmaster` | `trip_id IN (active_trip_ids)` | Chunk ≤800 ids; only devices with a trip |
| Live dwell | `ap_widgets.tb_trip_detention` | `device_id IN (...) AND detention_end_time IS NULL` | Chunk ≤800 ids |
| Plant coordinates | `ap_widgets.tb_legmaster` | `GROUP BY plant_code`, rolling window | **Daily**, on the master sync — not the 30-min tick |

**Caution — measured.** `tb_legmaster` is 2.97 M rows / 5 GB and a `plant_code IN (500 values)`
predicate **exceeded a 120 s budget** during this investigation. The aggregate-then-compare-in-app
form completed. `tb_csr_history` (18.3 M rows) is indexed on `latest_gps_datetime` and
`(plant_id, transporter_id, vehicle_no)` but **not** `device_id` or `INSERTION_TIME` — do not put it
on any hot path.

Nothing needs to be added to AutoPlant. Everything required already exists and is live.

---

## 14. Risks

### Technical

| Risk | Severity | Mitigation |
|---|---|---|
| N+1 AutoPlant queries if presence is resolved per ticket | **High** | Resolve at ingest into `device_vehicle_presence`; dispatch reads Postgres only |
| `tb_legmaster` scan timeout during master sync | **High** | Aggregate query, daily cadence, generous timeout, degrade to yesterday's coordinates on failure |
| Presence re-check inside the batch transaction lengthens the lock | Medium | Local indexed read only; never call MySQL inside the tx |
| Stale `plants.location` silently wrong | Medium | `location_source` + `location_confidence` + `sample_size`; never write a low-confidence centroid |
| PostGIS distance cost at dispatch | Low | Precompute `distance_m` at ingest; GIST index; ~2,200 rows/run |
| New columns break the skew guard / #222 offset handling | Medium | New columns are independent of `latest_gps_datetime`; do not touch `AUTOPLANT_UTC_OFFSET_MIN` |

### Operational

| Risk | Severity | Mitigation |
|---|---|---|
| **Held tickets become invisible work** — 80% deferred looks like the system stopped | **High** | Count held separately on the run ledger (the `withheldBelowThreshold` precedent); a dedicated "Held — vehicle away" dashboard; secondary SLA never pauses |
| Presence wrong → a truck that *was* there is never visited | **High** | `LOCATION_UNKNOWN` always dispatches; ZM override; measure every VU report filed against an `AT_PLANT` verdict as a labelled false positive |
| Approval gate becomes a rubber stamp | **High** | §6.1 — non-blocking preview instead |
| Fleet Uptime appears to improve because tickets are held | **High** | Presence must **not** touch the uptime denominator; add a separate serviceability KPI |
| SEs lose trust if the app says "present" and the yard is empty | Medium | Show the *reason* on the ticket ("gate-in 14 Aug 03:59, still inside") so the SE can judge |
| KESORAM (12% of backlog) has no coordinates | Medium | Fallback centroid with stddev gate; else `LOCATION_UNKNOWN` → still dispatched |

### Idempotency & concurrency — current guarantees and whether they survive

| Scenario | Today | Under the proposal |
|---|---|---|
| Scheduler runs twice | Safe — `SUGGESTED → DISPATCHED` consumption + per-zone advisory lock + partial uniques | **Preserved** — presence is a read-only filter |
| Crash halfway | Safe — zone tx rolls back; `clearRunZoneOrphans(runId, zone)` cleans SUGGESTED | **Preserved** |
| Runs during ingestion | Presence could be mid-update | Presence rows are per-device upserts; a run reads a consistent snapshot per row. Acceptable — worst case a device is one tick stale |
| Vehicle moves during assignment | **Not detected today** | In-tx re-check catches it (`CONSUMED_STALE_PRESENCE`) |
| Two schedulers concurrently | Safe — advisory lock; loser records `LOCK_CONTENDED` | **Preserved** |
| Capacity changes mid-run | Read once at run start | Unchanged; model B changes the counter, not the read |
| Ticket closed mid-run | `alreadyAssigned` guard + partial unique | **Preserved** |
| Two SEs get the same plant | Possible today via append-to-existing-schedule | Unchanged — not made worse; worth a separate look |

---

## 15. Migration Strategy

Six slices. Each independently valuable and independently revertible. **Nothing before slice 5
changes a single dispatch decision.**

| # | Slice | Risk | Reversible by |
|---|---|---|---|
| **1** | Populate `plants.location` + provenance columns. Read-only reporting on coverage. | **None** — nothing consumes it | Ignoring the column |
| **2** | Carry 4 columns + lat/lon through ingestion onto `device_states`. | **None** — written, not read | Ignoring the columns |
| **3** | Trip/gate reader + `device_vehicle_presence`. **Shadow mode**: compute and store, change nothing. | **None** | Disabling the reader |
| **4** | **Measure the shadow.** Publish "what the presence filter *would* have held" per run for ≥2 weeks. Compare against VU reports and SE feedback. | **None** | — |
| **5** | Wire VU `expectedFrom` → `deferredUntil`. **Independent of 1–4 — could ship first.** | Low | Feature flag |
| **6** | Enable the presence filter, behind a setting, **one zone at a time**. Capacity model B and fairness cap follow separately. | Medium | Setting flip |

**Slice 4 is the one I would not skip.** It converts this from an argument into a measurement, and it
costs nothing to run. If the shadow shows the filter would have held tickets the field says were
serviceable, we learn that before any SE is affected.

**Slice 5 can go first.** It has no dependency on presence, is a small change to one service, and
delivers your best idea immediately.

---

## 16. Final Verdict

> ### Should we implement your idea?
>
> **Partly — and not in the order you proposed.**
>
> Your instincts about the *problem* are right, and one of your five parts is the best cheap win
> available. But the centrepiece — a staging area with admin approval — treats a symptom of a system
> that is 5,000 tickets/day over capacity, and adds a human to the critical path of the very thing
> that is already too slow. The mechanism that actually fixes your problem is vehicle presence, which
> is not in your idea.

### Keep

- **Return-date-driven dispatch.** Your best idea. Ship it first — slice 5, independent of everything else.
- **Plant-centric work packages.** Correct, and already built (`plant_batch_assignments`).
- **The instinct behind "Special".** Real gap; needs re-siting (§6.3, §6.6).
- **Manual + scheduled runs.** Already built, already idempotent.

### Change

- **Staging gate → non-blocking preview + hold list.** Same visibility, no bottleneck.
- **"Special ticket" → `service_blocked_reason` + `blocked_attempt_count`,** scoped to `LOCATION_UNKNOWN`.
- **Three types → three existing orthogonal fields + one new one.**
- **Capacity → model B** (ticket cost + additional-plant-stop cost), which also revives the inert cluster multiplier.
- **Add a plant fairness cap** for the 4 shared SEs.

### Reject

- **A blocking approval gate before dispatch** — unless you can tell me why ADR-0007/0019 was
  superseded and what has changed since. *(Your call, not mine — see below.)*
- **"Pool" as a new data structure.** It exists. Renaming it adds risk and no capability.
- **A fourth priority mechanism** ("Priority ticket") alongside tier × bucket × rank.
- **Route optimisation.** You warned me off recommending it for its own sake and you were right:
  `orderPlantStops()` is a documented seam, distance weight is 0, and with 63 SEs on 1 plant each
  there is no route to optimise. Revisit only if floating coverage is ever populated (currently 0 rows).

### Investigate further

1. **Why was the approval gate removed?** ADR-0007/0019 were superseded by Decision §7. That history
   decides §5.1 and I could not find it in the code.
2. **Is "pool" push or pull?** (§5.7) Changes the design materially.
3. **Run slice 4** — the shadow measurement — before committing to the filter.
4. **Real SE roster.** Every capacity conclusion here rests on seeded data: 75 SEs, uniform capacity
   25, 0 floating, 0 territory rows. The *shape* (capacity-bound, 1 SE per plant) is almost certainly
   real; the magnitudes are not.
5. **Is 25/day right?** Nobody has validated it against actual field throughput.

---

### Two decisions that are yours, not mine

Per `CLAUDE.md` Strategic HITL — architecture and business-rule conflicts stop for you:

1. **Blocking approval gate vs non-blocking preview.** This reverses a recorded architectural
   decision. I recommend non-blocking; you may have operational reasons I cannot see from the code.
2. **Holding ~80% of tickets from dispatch.** This is a business-rule change with a visible
   consequence — the open-ticket count will stop falling while held work accumulates. Fleet Uptime is
   unaffected by design, but the operational picture changes, and Ops leadership should agree to it
   before slice 6, not after.

---

*Investigation only — no application code, database schema, migration, or production data was
modified. AutoPlant was accessed read-only throughout.*
