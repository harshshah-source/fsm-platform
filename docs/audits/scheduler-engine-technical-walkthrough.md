# Scheduler Engine — Technical Walkthrough

> **Purpose.** Authoritative technical input for designing and implementing the Scheduler Engine
> frontend UI. Every claim below is traced to a file, a function and (where useful) a line. Where a
> thing could not be found, it says `NOT FOUND IN CODEBASE`. Where the implementation and the SDS
> could not be compared, it says so rather than guessing.
>
> **Investigation date:** 2026-08-26
> **Branch:** `feat/autoplant-integration`
> **Backend root:** `apps/backend/src`
> **Schema:** `apps/backend/prisma/schema.prisma` (2,909 lines)
> **Global HTTP prefix:** `api` — `apps/backend/src/app.config.ts:18` (`app.setGlobalPrefix('api')`).
> Every route in §24/§25 is therefore `/api/<controller>/<path>`.

---

## 0. Two notes before the investigation

These are stated first because they change how the rest of this document must be read.

### 0.1 How the SDS was obtained, and what it turns out to be

**The supplied `docs/audits/sds.pdf` is destroyed and was never read.** Forensics:

| Check | Result |
|---|---|
| File size | 11,835,075 bytes |
| Header | `%PDF-1.7` (valid) |
| `/Type /Page` markers | 29 (a 29-page document) |
| Streams found | 530 |
| Streams that inflate (zlib `wbits` 15, −15, 47, offsets 0–3) | **0** |
| `EF BF BD` (U+FFFD replacement char) sequences | **2,700,933** |
| Implied pre-corruption size (`len − 2×FFFD`) | 6,433,209 |
| File's own `startxref` offset | 6,525,722 |

The file was passed through a **UTF-8 decode/re-encode round trip**: every byte sequence that was not
valid UTF-8 was replaced with U+FFFD, a lossy one-way substitution. 2.7 million bytes were destroyed,
not reordered. `pdftotext` extracts 0 lines. No repair is possible.

**The SDS text was instead supplied directly, pasted from the source document.** That text is the
baseline used in §2 and §40. Two caveats attach to it and are carried into every comparison below:

1. **It is OCR output and is visibly garbled in places.** The hard-filter table lost its first column
   value (row 1's filter name) and shifted the remaining names up one row; the sort-key table is
   numbered `1 2 5 4 5 6`; several verdict and status strings are truncated (`NOT ENFOI`,
   `UNASSIGNABLE` rendered as a blank). Where the surrounding prose makes the intent unambiguous, it
   was reconstructed and the reconstruction is stated explicitly. Where it did not, the row is marked
   `OCR-AMBIGUOUS` rather than guessed.
2. **It is not an independent specification.** Its own closing line reads: *"Written from the source
   in `apps/backend/src/scheduling`, `apps/backend/src/recommender` and `apps/backend/src/planner` —
   roughly 12,700 lines across 60 files."*

**That provenance claim was verified and is exact:**

```
$ find scheduling recommender planner -name "*.ts" | wc -l      → 59
$ find scheduling recommender planner -name "*.ts" -exec cat {} + | wc -l → 12,729
```

**This is the single most important framing fact for §40.** The SDS is a current, faithful, layman
rendering *of this same code*, not a design document written before it. Three consequences:

- **Agreement is not corroboration.** Where the SDS and the code match — and they match on
  essentially every algorithmic claim — that confirms the SDS is accurate. It is *not* independent
  evidence that the implementation matches an intended design, because there is no independent
  design here to check against.
- **A discrepancy is therefore significant.** It means either the SDS describes a capability the code
  does not actually expose, or the code moved after the SDS was written. Four such discrepancies were
  found (§40.2); one of them — D1 — is a user-facing capability that does not exist.
- **The SDS's scope is narrower than the engine's.** It excludes `intraday/`, `cross-zone/`,
  `shared-pool/` and `soft-state/` — a further **2,033 lines across 18 files** — which is exactly why
  the omissions in §40.3 exist. They are scope, not error.

### 0.2 The working tree does not compile — one uncommitted stray edit

`apps/backend/src/scheduling/scheduler-preview.service.ts:221`

```
  /** Release a hold — the ticket re-enters the very  ZOPerational HEAD scope is not defined. next run* . */'
```

`tsc --noEmit` reports:

```
src/scheduling/scheduler-preview.service.ts(221,110): error TS1002: Unterminated string literal.
```

The `*/` closes the comment and the trailing `'` opens a string literal that is never closed. This
is an **uncommitted working-tree edit** (`git diff` shows it against a clean HEAD, whose text was
`/** Release a hold — the ticket re-enters the very next run. */`). HEAD builds; the working tree
does not.

Per the investigation-only instruction (§28) this was **not fixed**. It is flagged here because any
frontend developer who checks out this tree will hit it immediately, and because it makes the
`SchedulerPreviewService` (the `/api/schedules/preview` and holds surface, §31/§33) unbuildable
until reverted.

---

## 1. Executive Summary

### 1.1 What the Scheduler Engine actually is

It is **not one service**. It is a five-layer pipeline plus five satellite subsystems, spread across
seven Nest modules:

```
recommender/     the decision engine     (who gets which ticket, and why)
scheduling/      the run orchestrator +  (when it runs, zone claims, commit, overrides,
                 the commit layer +       previews, transparency reads, closure, recovery)
                 the read surfaces
intraday/        the CRITICAL fast path  (2-min direct-assign sweep + escalations)
planner/         the SE Planner pin      (soft bias into the morning batch)
cross-zone/      the Platinum overflow   (escalation to CSM, not a scheduling path)
shared-pool/     the SE's secondary work (read-only, not dispatch)
soft-state/      the ON_SITE conflict gate
```

Core code volume: **14,762 lines** across those modules; **~150 test files** name it.

### 1.2 The single most important structural fact

**Coverage tier is inviolable; the score only ever decides *within* one tier.**

`recommender/tier-score-chooser.ts:55-72` — `chooseWithinTier` picks the *first non-empty tier* in
precedence order (`DEDICATED → MULTI_PLANT → FLOATING`), scores **only** that tier's members, and
returns the top score with `se_id` ascending as the deterministic tie-break. A FLOATING engineer can
never out-score an eligible DEDICATED one. A lower tier is reached only when every higher-tier
candidate was dropped by a hard filter.

The **one** thing that crosses tiers is a human's SE-Planner pin
(`tier-score-chooser.ts:63` — `passed.find(...)` searches all passing candidates, not
`tierCandidates`). This is a deliberate operator ruling, documented at `tier-score-chooser.ts:26-30`
and `recommender.service.ts:655-661`.

### 1.3 The second most important structural fact

**There are three funnel populations the engine deliberately does NOT decide on**, and the UI must
keep them apart or it will misreport a healthy system as an outage:

| Population | Column | Means | Who acts |
|---|---|---|---|
| `unassignable` | `dispatch_run_zones.unassignable` | engine looked, found nobody | **Ops** (coverage/capacity gap) |
| `withheldBelowThreshold` | `.withheld_below_threshold` | engine deliberately did not look yet | **nobody** — policy working |
| `componentBlockedWithheld` | `.component_blocked_withheld` | part on order, SLA paused | **Warehouse** |
| `bucketlessDropped` | `.bucketless_dropped` | could not rank — no `sla_bucket` | **Data/engineering** |

`recommended + unassignable` is **not** the whole funnel. `ticketsConsidered` counts only what
entered the loop. Source: `recommender/recommender.service.ts:70-121`,
`scheduling/dispatch-transparency-query.service.ts:57-71`.

### 1.4 The complete top-level execution path

```
05:00 IST cron (settings-backed, restart-free)
  → DispatchSchedulerService.dispatchTick                    dispatch-scheduler.service.ts:85
  → CronTickClaimService.claimTickOrLog  (cross-instance)    cron-tick-claim.service.ts:75
  → DispatchRunService.runForActiveZones                     dispatch-run.service.ts:231
      ├─ future-day refusal                                  :242
      ├─ reapStaleDispatchRuns  (free crashed holders)       :257 → :506
      ├─ admit  (open run row + INSERT..ON CONFLICT claims)  :266 → :343
      │    └─ captureConfigSnapshot  (frozen config)         :365 → :1183
      ├─ patience loop (CRON only, 15 min / 60 s)            :271
      └─ execute                                             :292 → :842
           ├─ audit DISPATCH_RUN_STARTED                     :861
           ├─ warnIfEligibilityStale (MV freshness)          :874 → :1270
           ├─ per admitted zone → processZone                :895 → :1075
           │    ├─ RecommenderService.runForZone  ◄── THE ENGINE
           │    ├─ BatchAssignmentService.dispatchForZone ◄── THE COMMIT
           │    ├─ finalizeZoneClaim (zone card totals)      :1098 → :1123
           │    └─ touchHeartbeat                            :1102 → :756
           ├─ waitOutContention (retry refused zones)        :904 → :992
           ├─ finalize run SUCCESS|PARTIAL|FAILED            :932
           └─ audit DISPATCH_RUN_FINISHED                    :951
  finally → releaseStrandedClaims                            :307 → :770
```

### 1.5 What a frontend developer most needs to know up front

1. **Every scheduler read is server-side zone-scoped.** A `ZONAL_MANAGER` is clamped to their own
   zone at every level; `CENTRAL_SERVICE_MANAGER` / `OPERATIONS_HEAD` are global. The UI never
   filters by zone for security. Some routes **403** a cross-zone request, some **404**, and one
   silently omits — §38.4 lists which is which, because they are not uniform.
2. **Previews are the real engine with writes suppressed** — not a re-implementation. This is
   count-pinned by tests. §12.
3. **Overload is always *visible*, never *blocked*, on manual paths** — and always *blocking* on
   automatic ones. §17.4.
4. **`null` never means zero.** `bucketlessDropped: null` means "not measured", `distanceKm:
   "NOT_AVAILABLE"` means "cannot be computed", `addSource: null` means "pre-provenance history,
   unknown". Rendering any of these as 0/false/system is explicitly forbidden by the code's own
   contract (`add-source.ts:108-114`, `distance.ts:12`, `hard-filters.ts:45`).
5. **There is no Scheduler Dashboard endpoint.** §21.1 — the closest is
   `GET /api/dispatch/today`, which is single-zone and requires `zoneId` for multi-zone roles.

---

## 2. SDS Baseline

Source: the pasted text of *"FSM Dispatch Engine — The dispatch engine, explained"*, 29 pages,
`apps/backend/src`, FSM GPS Platform, Scheduling & Recommender. Provenance and OCR caveats: §0.1.

### 2.1 The document's own framing

> *"Every morning at 05:00 India time, a program decides which field engineer drives to which plant,
> in what order, and why. This is how it makes that decision — and what a manager can do about it
> afterwards."*

Headline figures, all of which the code confirms exactly:

| SDS states | Code |
|---|---|
| **05:00 IST** daily run | `DEFAULT_DISPATCH_CRON = '0 5 * * *'`, `timeZone: 'Asia/Kolkata'` ✓ (but see D3) |
| **3** coverage tiers | `DEDICATED` / `MULTI_PLANT` / `FLOATING` ✓ |
| **5** hard filters | `HARD_FILTER_ORDER.length === 5` ✓ |
| **6** scoring weights | `SCORING_COMPONENTS.length === 6` ✓ |
| **6** override actions | `OverrideCommand` union has 6 members ✓ |
| **3** preview surfaces | scheduler / override-impact / distribute ✓ |

Purpose, as stated: *"Thousands of GPS devices sit on customer vehicles… When a device goes quiet for
long enough, the system opens a ticket. Tickets pile up. Meanwhile there is a limited pool of Service
Engineers, each with a van, a toolkit, a home base, and a cap on how many stops they [can make]."*

### 2.2 §3 — The Recommender: "How one ticket finds one engineer"

The SDS splits the engine into two halves. **This matches the code's own structure exactly.**

**Half one — gathering and ranking.** Six gates, each said to hold work back for a different reason,
with an explicit "whose problem is it?" column:

| SDS gate | SDS: held back because | SDS: whose problem |
|---|---|---|
| Deferred | a manager or a vehicle-return date parked it until a future day | nobody's — a decision already taken |
| Plant deactivated | the site is shut; nobody is sent to a closed plant | nobody's |
| Device departed | the device left the fleet entirely | nobody's |
| Below age threshold | the device hasn't been silent long enough to be worth a visit yet | nobody's — policy working as intended |
| Waiting on a component | the spare part is on order and the SLA clock is paused | the warehouse's |
| No computed SLA bucket | the device has no ranking data, so it can't be sorted at all | a data fault |

The SDS's stated rationale, quoted in full because it is the design principle the UI most depends on:

> *"Folding them into one 'couldn't dispatch' number would make a supplier delay look identical to a
> fleet-wide dispatch outage. A ticket the engine deliberately didn't look at (policy) is a completely
> different signal from one it looked at and found nobody for (a coverage gap somebody must fix),
> which is different again from one it could not look at (broken data). Three different people need to
> act on those three numbers."*

**Sort order**, six keys (SDS numbering is OCR-garbled as `1 2 5 4 5 6`; the content order is
unambiguous):

| # | SDS key | SDS direction | SDS meaning |
|---|---|---|---|
| 1 | Company tier | Platinum → Gold → Silver | contract value: your best customers are served first |
| 2 | Device SLA bucket | worst first | Warning → Early Risk → Risk → Critical → High Critical → Severe → Very Severe → Long Pending |
| 3 | Vehicle due back today | true first | *"Only for tickets below critical. A vehicle that was away and has just returned jumps the ordinary backlog but never jumps a genuine emergency"* |
| 4 | Company priority rank | — | a finer ranking within a tier |
| 5 | Oldest inactive | oldest first | the device that's been silent longest |
| 6 | Device ID | ascending | *"absolute tie-break, so two runs on identical data always agree"* |

Plus: *"In one mode… the pending-install backlog is appended after all troubleshoot work, ordered
oldest-first, to soak up leftover capacity."*

**Half two — choosing the engineer.** The SDS states the priority-queue property explicitly:

> *"Order matters enormously: an engineer filled up by ticket #3 is unavailable for ticket #40, so
> the sort above is effectively a priority queue for scarce human capacity."*

Three tiers in fixed precedence, and on the floating leg:

> *"The floating list is re-checked live against the engineer master record rather than trusted from
> the cached geometry map — that map refreshes only on territory edits, so on its own it can still
> name someone who was made dedicated or deactivated yesterday."*

**Five hard filters.** *"They are not scored, weighted, or traded off — a candidate that fails one is
out. They evaluate in a fixed order, and the first failure is the recorded reason."*

The OCR lost row 1's filter name and shifted the remaining names up one row. Reconstructed from the
"drops an engineer when…" column, which is intact and maps one-to-one onto the code:

| Order | Filter (reconstructed) | SDS: drops when | SDS status |
|---|---|---|---|
| 1 | `VEHICLE_ON_TRIP` | their van is mid-trip | NOT ENFORCED |
| 2 | `SE_UNAVAILABLE` | on leave, deactivated, or inside a non-available window | LIVE |
| 3 | `OVER_CAPACITY` | their day is already at or past their cap | LIVE |
| 4 | `COMMON_KIT_INCOMPLETE` | their van is missing standard toolkit items | LIVE |
| 5 | `COMPONENT_UNAVAILABLE` | they lack the specific spare this job needs | NOT ENFORCED |

**The three-state honesty rule**, verbatim:

> *"A filter isn't pass or fail — it's passed, failed, or not enforced. Two of the five have no real
> data feed yet: vehicle telemetry and per-job spare-part expectations are separate unbuilt
> integrations. Rather than quietly defaulting those to 'pass', the engine records not enforced."*

**On the planner pin**, the SDS gives the operator's reasoning: overriding *"a manager's pin because
the algorithm preferred somebody else, with no signal that it happened, was judged the worse
failure."*

**Writing the decision down.** A winner produces a `SUGGESTED` recommendation with the full score
breakdown; no winner produces an `UNASSIGNABLE` row *"tagged with which kind of nothing it was: no
coverage (nobody covers this plant at all — an operations gap) or all dropped (people exist, but
every one failed a filter — a capacity or readiness problem)."* And: *"the winner's running day total
and their set of plants-for-today are both incremented immediately, so the very next ticket in the
list sees an accurate picture."*

### 2.3 §4 — The maths

The SDS prints the formula. OCR mangled the signs but the mode annotations disambiguate them:

```
base score =  w_rank     × rankScore
            + w_urgency  × urgency
            − w_repeat   × repeatFailure      (deficit mode)
            + w_bonus    × repeatFailure      (preventive mode)
            + w_age      × ageScore
            + w_distance × distanceScore

            max(base, 0) × clusterMultiplier
```

> *"Every weight is stored in the database and editable by an operator — the formula's shape is code,
> its tuning is configuration. The set of valid weight names is closed, so a typo in the admin form
> can't create a lever that silently does nothing."*

| SDS component | SDS definition | SDS "reads as" |
|---|---|---|
| `rankScore` | A=1.0, B=0.9, … | how important the customer is |
| `urgency` | bucket position | how badly broken the device is, 0–1 |
| `repeatFailure` | — | has this device failed repeatedly? |
| `ageScore` | `min(1, hours ÷ 168)` | how long it's been silent, capped at 7 days |
| `distanceScore` | `1 ÷ (1 + km)` | nearer is better, with diminishing returns |
| `clusterMultiplier` | ×1.25 (default) | this engineer is already going to this plant today |

And: *"Distance is measured from where they'll be, not where they started. Each engineer carries a
moving position through the run."*

### 2.4 §6 (implied) — The trace and its three verdicts

| SDS verdict | SDS meaning |
|---|---|
| `PASSED` | eligible, scored, and lost on merit |
| `DROPPED` | a hard filter rejected them — the reason is recorded |
| *(name lost to OCR — `TIER_NOT_REACHED`)* | eligible, but in a tier below the winning one — never scored at all |

> *"Calling that third case 'passed with a score' would claim they were weighed and lost; calling it
> 'dropped' would claim a filter rejected them. Neither happened, so it gets the verdict describing
> what did."*

Plus the degeneracy flag: *"set when every candidate in the winning tier scored identically — meaning
tier precedence, not the score, actually decided. Without it, an operator reads a score and assumes
it was decisive."*

**Retire, don't delete**, verbatim:

> *"When a run cleans up leftover suggestions from a crashed earlier run, it marks them RETIRED rather
> than deleting them. Deletion used to cascade to the decision traces — so the next run's first act
> was destroying the crashed run's reasoning, making 'what was the dead run about to do?' permanently
> unanswerable at exactly the moment somebody would ask."*

### 2.5 §7 — Resilience

Three layered mechanisms:

- **Heartbeat** — *"stamps a timestamp at admission and after every zone. A run that is merely slow is
  therefore never silent for longer than its slowest single zone takes."*
- **Reaper — every 3 minutes, 10-minute threshold** — and the invariant, stated explicitly:
  *"That threshold sits deliberately below the 15-minute patience deadline — if a dead holder could
  outlive the retry window, the morning run would spend that whole window being refused by a zombie
  and then give up, which is the exact starvation the reaper exists to prevent."*
- **Wake-up refusal** — *"If the 'dead' run later wakes up, it finds its status has been taken and
  declines to overwrite it. A ledger asserting that two runs dispatched the same zone is worse than
  either state alone."*

### 2.6 §8 — The three previews

**Preview A — scheduler preview.** *"Every preview comes back with a signed token capturing the
numbers you were shown. Re-submit the token and the system answers [FRESH] or [STALE] — and if stale,
hands back the current picture. This guards a display, not a mutation: its whole job is to stop a
manager acting on a plan that changed while they were reading it."* ⚠ **See D1.**

*"Approval is never required — inaction means the 05:00 run proceeds exactly as if nobody looked. The
single change an admin can make in advance is to hold a ticket until a chosen date."* And the
rationale: a pre-run move *"would require inventing pre-run assignment state that the run then has to
honour — a second scheduling authority competing with the first. The whole design refuses that."*
Plus the guard: *"a hold refuses to silently overwrite a vehicle return date… Overwriting the second
loses information nobody can recover, so it stops and shows the return context instead."*

**Preview B — override impact.** Flow: *inspect → understand → override → preview impact → confirm*.
*"The system had every step except the second-to-last."* The preview *"accepts the identical request
body the confirm takes, so the two cannot drift into two vocabularies"*, and answers four things:

| SDS: what it shows | SDS: read from | SDS example |
|---|---|---|
| two capacity lanes — both engineers' load now and after | the same committed-load function the engine enforces against | `Ravi 5/6 → 4/6`, `Sneha 5/6 → 6/6 FULL` |
| rank context — where the run ranked your target | the run's own stored decision | *"Sneha ranked #2 for this ticket in the 05:00 run"* |
| route effect — where the work lands on their day | mirrors exactly what the write actually does | *"joins her existing stop 3"*, or *"appended as stop 5; existing stops not reordered"* |
| conflicts — what the confirm will ask you about | the same predicates the write gates on | on-site work, or tickets held to a future return date |

Three deliberate refusals: it **reports** conflicts rather than enforcing them; over-capacity is
**stated, never a block** (*"at exactly 6 of 6 you are full, not 'one more fits'"*); single-lane
actions are **refused, not zeroed** (*"answering with zeros would read as 'this move costs
nothing'"*). And: *"an unknown rank is reported as unknown, never as 'unranked' — a fabricated rank
would be read as the engine's opinion."*

**Preview C — distribute.**

| SDS strategy | SDS: allocates by |
|---|---|
| `COVERAGE_TIER` | *"calls the real engine's dry run over just your selection — reports exactly what the engine itself would choose"* |
| `CAPACITY_HEADROOM` | *"levels the load: whoever has the most room left gets the next ticket"* |
| `PLANT_WHOLE` | *"keeps each plant intact on one engineer — no site is split across two vans"* |

*"Eligibility and readiness are never re-derived here… What this service owns is purely the allocation
policy: given several equally eligible engineers, who gets what. That is a genuine choice, not a
second copy of the selection rule."*

### 2.7 §9 — Human control

*"Overrides commit immediately — there is no approval queue. Every one demands a reason code, flips
the affected batch and schedule to `OVERRIDDEN`, records who did it inside the same transaction as the
change itself, and pushes the updated plan to the engineer."*

| SDS action | SDS: what it does | Two-lane? |
|---|---|:--:|
| `REMOVE_TICKET` | pulls a ticket off a day plan; it returns to the unassigned pool | No |
| `DEFER_TICKET` | pulls it off and parks it until a chosen date | No |
| `REORDER` | moves a stop's position in the engineer's route | No |
| `SWAP_SE` | hands an entire plant stop to a different engineer | **Yes** |
| `REASSIGN` | hands one ticket to a different engineer | **Yes** |
| `SPLIT_BATCH` | hands some tickets from a stop to a different engineer | **Yes** |

Two confirm gates, *"neither a refusal"*: **on-site** (*"moving it blind is how two vans end up at one
gate"*) and **deferred** — the latter applying *"only to the three actions that hand work to another
engineer — remove, defer and reorder sit deliberately outside the gate, because refusing to let a
manager withdraw a held ticket would obstruct the very action that respects the hold."*

Two safety properties: *"Nobody's decision gets overwritten"* (the write is conditional on the row
still being live; losing the race aborts and *"the audit entry rolls back with it. Nothing may record
a withdrawal that didn't happen"*), and *"Existing stops are never renumbered"* ⚠ **see D4.**

### 2.8 §10 — The engine's four standing rules

1. **Never fabricate a default.** *"A filter with no feed is not enforced, not passed. An unknown
   distance is not available, not zero. An unknown rank is unknown, not unranked. Every one of those
   would otherwise be read as a positive finding."*
2. **One rule, one implementation.** *"Two callers reading the same facts differently while agreeing
   perfectly on the rule is the quiet failure this guards against — a screen that looks right and
   disagrees with dispatch under load."*
3. **Contain the blast radius.** *"A zone fails, not a run. An engineer fails, not a zone. A
   notification fails, not a dispatch. Each of those boundaries was moved inward after the wider one
   caused real damage."*
4. **Degrade loudly, not silently.** *"A stale eligibility map doesn't block the day's dispatch — it's
   logged and frozen into the run's own snapshot… The bound exists so somebody gets told, not so the
   system goes quiet."*

### 2.9 The SDS file reference table

19 paths, **all 19 verified to exist at the stated location**: `scheduling/dispatch-cron.ts`,
`scheduling/dispatch-run.service.ts`, `recommender/recommender.service.ts`,
`recommender/canonical-sort.ts`, `recommender/hard-filters.ts`, `recommender/candidate-readiness.ts`,
`recommender/candidate-selection.service.ts`, `recommender/tier-score-chooser.ts`,
`recommender/scoring.ts`, `recommender/plant-geometry.ts`,
`scheduling/batch-assignment.service.ts`, `scheduling/override.service.ts`,
`scheduling/override-projection.service.ts`, `scheduling/scheduler-preview.service.ts`,
`scheduling/distribute-projection.service.ts`,
`scheduling/dispatch-transparency-query.service.ts`,
`scheduling/day-plan-notification-outbox.ts`,
`scheduling/schedule-closure-scheduler.service.ts`,
`scheduling/business-sweep-scheduler.service.ts`.

---

## 3. Actual Scheduler Architecture

### 3.1 Module map

| Module | Path | Registers | Owns |
|---|---|---|---|
| `SchedulingModule` | `scheduling/scheduling.module.ts` | 20 providers | run orchestration, commit, overrides, previews, transparency reads, closure, recovery |
| `RecommenderModule` | `recommender/recommender.module.ts` | `RecommenderService`, `CandidateSelectionService` | the decision algorithm |
| `IntradayModule` | `intraday/intraday.module.ts` | `IntradayInsertionService`, `StrandedWorkEscalationService` | CRITICAL direct-assign, escalations |
| `PlannerModule` | `planner/planner.module.ts` | `SePlannerService` | the SE-Planner pin |
| `CrossZoneModule` | `cross-zone/cross-zone.module.ts` | `CrossZoneEscalationService` | Platinum overflow to CSM |
| `SharedPoolModule` | `shared-pool/shared-pool.module.ts` | `SharedPoolService`, `SeCoverageService` | SE secondary-work read |
| `SoftStateModule` | `soft-state/soft-state.module.ts` | `PrismaSoftStateConflictPort` | ON_SITE override gate |
| `CronTickClaimModule` | `scheduling/cron-tick-claim.module.ts` | `CronTickClaimService` | cross-instance tick arbitration |

### 3.2 The layers, and what each is allowed to decide

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ L0  TRIGGER          DispatchSchedulerService (@Cron) │ SchedulesController   │
│                      decides: nothing. Claims a window, calls L1.            │
├──────────────────────────────────────────────────────────────────────────────┤
│ L1  ORCHESTRATION    DispatchRunService                                       │
│                      decides: which zones, who holds them, when to give up,   │
│                      what the run's status is. NEVER which SE gets a ticket.  │
├──────────────────────────────────────────────────────────────────────────────┤
│ L2  DECISION         RecommenderService  ◄── the only place selection happens │
│                      decides: ticket order, candidate pool, filters, tier,    │
│                      score, winner, and the recorded explanation.             │
│                      Writes: recommendations, dispatch_decision_traces.       │
├──────────────────────────────────────────────────────────────────────────────┤
│ L3  COMMIT           BatchAssignmentService                                   │
│                      decides: nothing about WHO. Only how the chosen set      │
│                      becomes rows: schedules, stops, sort order.              │
│                      Writes: work_schedules, plant_batch_assignments,         │
│                              batch_assignment_tickets, tickets.assignment_state│
├──────────────────────────────────────────────────────────────────────────────┤
│ L4  READ / MUTATE    DispatchTransparencyQueryService, DispatchTodayQuery…,   │
│     (the UI's world) ZmScheduleQueryService, DayPlanQueryService,             │
│                      CandidateQueryService, AssignableWorkQueryService,       │
│                      OverrideService, OverrideProjectionService,              │
│                      DistributeProjectionService, SchedulerPreviewService     │
└──────────────────────────────────────────────────────────────────────────────┘
```

The layering is enforced by an explicit convention the code states repeatedly: **the transparency
ledger is observe-only** (`dispatch-run.service.ts:210` — "records the dispatch, never alters
selection/scoring/ordering"), and **read surfaces re-derive nothing** (`dispatch-today-query.service.ts:156`
— "This service decides nothing").

### 3.3 The shared-definition seams (why the UI can trust the numbers)

The codebase has a stated anti-drift discipline: any predicate two callers must agree on is
extracted to one module. These are the seams a frontend developer should know about, because they
are the guarantee that a number on screen is the number the engine will enforce:

| Seam | File | Shared by | Guarantee |
|---|---|---|---|
| "is this engineer committed, and how much" | `scheduling/committed-day-load.ts` | recommender, candidate column, ZM pickers, cockpit, override preview, distribute | one definition of `committed` |
| "can this engineer take work" | `recommender/candidate-readiness.ts` | recommender, `CandidateQueryService` | the console's answer **is** the engine's answer |
| tier + score + pin | `recommender/tier-score-chooser.ts` | morning batch, intraday CRITICAL sweep | one selection discipline |
| "is this schedule live today" | `scheduling/schedule-status.ts` | ~10 readers | `OVERRIDDEN` is still today's work |
| "is this ticket held" | `ticketing/deferral.ts` | recommender, shared pool, intraday, cross-zone, overrides | one deferral boundary |
| "is this work assignable" | `ticketing/assignable-work.ts` | work pool, `assignPlants`, ticket-id resolution | the read predicts the write |
| "is a part on order" | `ticketing/component-blocked.ts` | morning pool, intraday sweep | one exclusion |
| scoring config reads | `recommender/scoring-config.ts` | morning batch, intraday sweep | one weight set |
| CRITICAL+ band | `device-state/sla-bucket.ts` | cross-zone, dashboard, canonical sort | one severity boundary |
| the operating day | `common/ist-day.ts` | everything | IST, and `@db.Date` vs `@db.Timestamptz` kept apart |

**Frontend consequence:** you do not need to reimplement any of these client-side, and you must not.
Each has at least one e2e test asserting the two callers agree (e.g.
`test/capacity-overload-visibility.e2e-spec.ts` for `committedDayLoad`).

---

## 4. Complete End-to-End Execution Flow

The task's proposed lifecycle was checked against code. **The real sequence differs in six places.**
Corrections are marked ⚠.

```
 1  CRON TICK (05:00 IST, settings-backed) ─── or MANUAL API ─── or RECOVERY COLLECTOR
 2  TICK CLAIM              ⚠ NOT IN PROPOSED LIST. Cross-instance, DB-backed, per (job, minute).
 3  FUTURE-DAY VALIDATION   ⚠ Only validation on the real path. No DTO validation exists.
 4  REAPER PASS             ⚠ Runs BEFORE admission, not "if required" at the end.
 5  ZONE DISCOVERY          activeZoneIds() — zones with ≥1 plant.
 6  ZONE CLAIM + RUN CREATION  ⚠ SAME TRANSACTION. Run row cannot exist without claims and vice
                               versa; all-held ⇒ nothing written at all.
 7  SNAPSHOT CONFIGURATION  ⚠ Captured BEFORE the run row, inside admit(), not after.
 8  PATIENCE LOOP           ⚠ NOT IN PROPOSED LIST. CRON only, 15-min deadline, 60-s interval.
 9  ── per zone ──
10  FETCH TICKETS           OPEN + UNASSIGNED + TROUBLESHOOT, 6 exclusions
11  RANKABILITY FILTER      ⚠ NOT IN PROPOSED LIST. Drops null-sla_bucket → bucketlessDropped
12  TICKET SORT             canonicalSort (6 keys) [+ installSort in PREVENTIVE mode]
13  RUN-LEVEL READS         weights, cluster multiplier, capacity, committed day plan,
                            planner pins, plant coords, home bases
14  ── per ticket ──
15  FETCH ENGINEERS         orderedCandidatesForPlant (coverage + floating MV)
16  READINESS BUILD         availability, capacity, kit — memoised
17  HARD FILTERS            5 filters, tri-state, first-FAILED wins
18  TIER SELECTION          first non-empty tier in passed[]
19  SCORING                 only within the winning tier
20  WINNER SELECTION        pin ▸ top score ▸ se_id asc
21  PERSIST RECOMMENDATION  SUGGESTED | UNASSIGNABLE
22  UPDATE IN-RUN STATE     capacity++, plants+=, route position advances
23  BUILD TRACE ROW         (in memory)
24  ── end per ticket ──
25  BULK INSERT TRACES      one createMany
26  ── back in the run ──
27  DAY-PLAN COMMIT         per SE: advisory lock → claim recs (SKIP LOCKED) → schedule →
                            stops → tickets → outbox row → consume recs
28  OUTBOX DRAIN            ⚠ POST-COMMIT, outside the transaction
29  ZONE CLAIM FINALIZE     DONE | ERROR + all zone-card totals
30  HEARTBEAT
31  ── end per zone ──
32  RETRY CONTENDED ZONES   ⚠ NOT IN PROPOSED LIST
33  RUN FINALIZE            SUCCESS | PARTIAL | FAILED  (never ABORTED — reaper-only)
34  AUDIT + RELEASE STRANDED CLAIMS
35  ── asynchronously ──
36  REAPER (every 3 min)    → marks dispatch_zone_recoveries PENDING
37  RECOVERY COLLECTOR (every 5 min) → re-enters at step 1, bounded 3 attempts / 18:00 IST cutoff
```

### 4.1 Corrections to the proposed lifecycle, in detail

| # | Proposed | Actual | Evidence |
|---|---|---|---|
| 1 | `VALIDATION` after entrypoint | There is **no request-body validation** on the dispatch trigger. `dispatchRunNow` reads `body.zoneId`/`body.reason` untyped and coerces. The only validation is the *future-day* refusal, inside the service. | `schedules.controller.ts:193-206`; `dispatch-run.service.ts:242-247` |
| 2 | `RUN CREATION` → `ZONE CLAIM` (sequential) | Both inside **one** `$transaction`, and rolled back whole when every zone is held (`AllZonesHeldError`). "A run which never happened leaves no history." | `dispatch-run.service.ts:367-424` |
| 3 | `SNAPSHOT CONFIGURATION` after zone claim | Captured **before** the run row, after the cheap pre-read. | `dispatch-run.service.ts:365` |
| 4 | `RECOVERY / REAPER IF REQUIRED` at the end | Reaper runs **first** (`:257`), again inside every patience iteration (`:276`, `:1004`), and on its own 3-min cron. Recovery is a **separate 5-min cron**, not a run stage. | `dispatch-run.service.ts:257,276,1004`; `dispatch-scheduler.service.ts:131,158` |
| 5 | `PLANNER / MANAGER PIN` after `WINNER SELECTION` | The pin is **an input to** winner selection, evaluated inside `chooseWithinTier`, and it *overrides* the score. | `tier-score-chooser.ts:63-70` |
| 6 | `CAPACITY / CONFLICT CHECKS` after `DAY-PLAN GENERATION` | Capacity is a **hard filter before scoring** (`OVER_CAPACITY`), enforced per ticket during selection. There is no post-generation capacity check on the automatic path. | `hard-filters.ts:48-54`; `candidate-readiness.ts:59` |

### 4.2 Transaction boundaries in the flow

| Stage | Boundary | Isolation |
|---|---|---|
| Admission (run row + claims + CONTENDED rows) | one interactive `$transaction` | default (READ COMMITTED) |
| Recommender per-ticket writes | **no transaction** — individual `create` calls | each autocommits |
| Trace insert | single `createMany` | autocommit |
| Commit, per SE | one interactive `$transaction` + `pg_advisory_xact_lock` + `SET LOCAL lock_timeout` | READ COMMITTED + `FOR UPDATE … SKIP LOCKED` |
| Outbox drain | **outside** any transaction | per-row guarded claim |
| Zone finalize / run finalize | individual `updateMany` with status predicates | autocommit, compare-and-set |
| Closure, per zone | one `$transaction` + `pg_try_advisory_xact_lock` | READ COMMITTED |
| Bulk unassign, per zone | one `$transaction` + `pg_try_advisory_xact_lock` | READ COMMITTED |
| `assignLane` (manual batch) | one `$transaction` **per engineer lane** + `FOR UPDATE … SKIP LOCKED` per ticket | READ COMMITTED |

**Notable:** the recommender is **not transactional**. Its per-ticket `recommendation.create` calls
autocommit individually. Consistency comes from the partial unique
`recommendations_one_suggested_per_ticket` plus the in-transaction re-read at commit
(`batch-assignment.service.ts:168-175`), not from a transaction. Stated explicitly at
`recommendation-status.ts:14-15`.
---

## 5. Scheduler Entry Points

Every way the engine can be invoked. **11 entry points found.** Grouped by whether they mutate.

### 5.1 EP-1 — Daily dispatch cron `IMPLEMENTED` `BACKEND_ONLY`

```
ENTRYPOINT       @Cron, job name "business-dispatch"
Schedule         system_settings.dispatch_cron  (default '0 5 * * *', Asia/Kolkata)
                 The @Cron decorator argument is only a compile-time default; the live job is
                 re-pointed at boot and on every write. dispatch-scheduler.service.ts:84
Handler          DispatchSchedulerService.dispatchTick        dispatch-scheduler.service.ts:85
Service          DispatchRunService.runForActiveZones         dispatch-run.service.ts:231
Input DTO        none — `now: Date = new Date()`
Validation       master switch BUSINESS_SWEEPS_ENABLED === 'true' (re-read every tick, :86)
                 tick claim (cross-instance) :93
Authorization    n/a (system actor)
Immediate resp.  SchedulerTickOutcome — { ran: true } | { ran: false, reason }
                 reason ∈ DISABLED | TICK_CLAIMED | RUN_IN_PROGRESS | ERROR
Async behaviour  fully synchronous within the tick; patient up to 15 min on contended zones
Downstream       RecommenderService, BatchAssignmentService, AuditService, notification outbox
DB effects       dispatch_runs, dispatch_run_zones, recommendations, dispatch_decision_traces,
                 work_schedules, plant_batch_assignments, batch_assignment_tickets, tickets,
                 day_plan_notification_outbox, audit_logs, cron_tick_claims, component_blocked_queue
```

**Frontend-relevant:** `GET /api/schedules/dispatch-schedule` exposes the cron + `nextFireAt`.

### 5.2 EP-2 — Manual dispatch run `IMPLEMENTED` `FRONTEND_RELEVANT`

```
ENTRYPOINT       POST /api/schedules/dispatch-run          schedules.controller.ts:190
HTTP             POST, @HttpCode(200)
Roles            OPERATIONS_HEAD, CENTRAL_SERVICE_MANAGER
Body             { zoneId?: number, reason?: string }   — untyped, no DTO class, no pipe
Validation       none at the controller. `zoneId` → BigInt() (throws on garbage → 500).
                 `reason` kept only if typeof === 'string'; blank-trimmed to null at :376.
Service          runForActiveZones(new Date(), { trigger:'MANUAL', actorUserId, actorRole,
                                                 zoneId?, reason })
Patience         NONE — retryPolicyFor returns null for any non-CRON trigger (:322).
                 Deliberate ruling: "an operator pressing a button wants an answer, not a queue."
Response 200     DispatchRunSummary  (§25.2)
Response 409     { code:'DISPATCH_ALREADY_RUNNING', message, inFlight: DispatchInFlight[] }
                 message is IST-rendered: "dispatch already running for this zone (zone 3,
                 started 05:00 IST by SYSTEM)"   schedules.controller.ts:117-129
Mutates          yes — everything EP-1 does
```

### 5.3 EP-3 — Scheduler Preview `IMPLEMENTED` `FRONTEND_RELEVANT` — read-only

```
ENTRYPOINT       GET /api/schedules/preview?date=YYYY-MM-DD    schedules.controller.ts:281
Roles            ZONAL_MANAGER, CENTRAL_SERVICE_MANAGER, OPERATIONS_HEAD
Query            date (optional; defaults to now). Parsed by istWindowStart — an invalid
                 calendar date returns Invalid Date rather than rolling over.
Validation       400 { code:'INVALID_DATE', message:'date must be YYYY-MM-DD.' }
Service          SchedulerPreviewService.preview → DispatchRunService.previewActiveZones
                 → RecommenderService.runForZone({ dryRun:true, targetDate })
Scope            ZM → own zone only; CSM/OH → every active zone (server-side, :105)
Writes           ZERO. Count-pinned by test/recommender-dry-run.e2e-spec.ts:130-135 and
                 test/dispatch-preview.e2e-spec.ts:142-147 (whole-table count equality).
Locks            none. Holds no in-flight slot; opens no dispatch_runs row.
                 Pinned: test/dispatch-preview.e2e-spec.ts:162-167.
Response         SchedulerPreviewResult (§25.5)
```

### 5.4 EP-4 — Override Impact Preview `IMPLEMENTED` `FRONTEND_RELEVANT` — read-only

```
ENTRYPOINT       POST /api/batches/:id/override/preview      batches.controller.ts:70
HTTP             POST @HttpCode(200) — POST because the body is a COMMAND, not because it writes
Roles            ZM, CSM, OH
Body             OverrideCommand — the IDENTICAL body the confirm takes (deliberate, :60)
Validation       BigInt(id) → 404 BATCH_NOT_FOUND on garbage
                 non-two-lane action → 400 NOT_PROJECTABLE
Service          OverrideProjectionService.projectOverride
Writes           ZERO — "no create, no update, no $transaction, no $executeRaw in this file"
                 (override-projection.service.ts:100). Pinned across every table a real move
                 touches: test/override-impact-preview.e2e-spec.ts:237-259.
Response 200     OverrideImpact (§25.7)
Response 400     { code:'NOT_PROJECTABLE', message:'<ACTION> moves no work between engineers…' }
Response 404     { code:'BATCH_NOT_FOUND' }
```

**Only 3 of 6 override actions are projectable:** `REASSIGN`, `SWAP_SE`, `SPLIT_BATCH`
(`override-projection.service.ts:88`). `REMOVE_TICKET`, `DEFER_TICKET`, `REORDER` are **refused,
not answered with zeros** — "zeros would read as 'this move costs nothing'"
(`batches.controller.ts:66-68`).

### 5.5 EP-5 — Distribute Preview `IMPLEMENTED` `FRONTEND_RELEVANT` — read-only

```
ENTRYPOINT       POST /api/schedules/distribute-preview      schedules.controller.ts:545
Roles            ZM, CSM, OH  (ruled 2026-08-24; deliberately NOT the narrower dispatch-run ladder)
Body             { ticketIds: string[], engineerIds: string[], strategy: DistributeStrategy }
Validation       400 TICKET_IDS_REQUIRED    — missing/empty array
                 400 ENGINEER_IDS_REQUIRED  — missing/empty array
                 400 STRATEGY_REQUIRED      — not one of COVERAGE_TIER | CAPACITY_HEADROOM |
                                              PLANT_WHOLE
Service          DistributeProjectionService.project
Writes           ZERO
Response         DistributeResult (§25.8)
```

### 5.6 EP-6 — Direct assignment (single ticket) `IMPLEMENTED` `FRONTEND_RELEVANT` — mutates

```
ENTRYPOINT       POST /api/schedules/assign                 schedules.controller.ts:363
Roles            ZM, CSM, OH  (acting-zone aware via scopeFor)
Body             { ticketId, seId, confirm?, reasonCode? }
Service          OverrideService.assignTicket(..., 'CRITICAL_ASSIGN', insertAtTop=false, {confirm,reasonCode})
Gates            404 TICKET_OR_SE_NOT_FOUND | out of zone
                 409 TICKET_ALREADY_ASSIGNED
                 409 CONFLICT_DEFERRED { ticketId, deferredUntil, vuReport }
                 400 DEFERRAL_OVERRIDE_REASON_REQUIRED  (confirmed but no reason)
Writes           work_schedules (ensure), plant_batch_assignments, batch_assignment_tickets,
                 tickets (FORMALLY_ASSIGNED, deferredUntil←null), audit_logs,
                 day_plan_notification_outbox
```

### 5.7 EP-7 — Multi-plant assign / lane batch assign `IMPLEMENTED` `FRONTEND_RELEVANT` — mutates

```
POST /api/schedules/assign-plants   schedules.controller.ts:404  { seId, plantIds[] }
POST /api/schedules/assign-batch    schedules.controller.ts:430  { reasonCode, lanes[] }
```

`assign-plants` is a **shorthand over `assign-batch`** since #275 — it expands plants to ticket ids
and delegates to `assignLane` (`override.service.ts:646`). Response shape is preserved byte-for-byte
for legacy callers, with a documented arithmetic difference: a lost race is folded into
`alreadyAssigned` for `assign-plants` but **itemised in `skipped`** for `assign-batch`
(`override.service.ts:595-603`).

`assign-batch` validation: `400 REASON_REQUIRED`, `400 LANES_REQUIRED`,
`400 LANE_SE_AND_TICKETS_REQUIRED`.

### 5.8 EP-8 — Batch override `IMPLEMENTED` `FRONTEND_RELEVANT` — mutates

```
ENTRYPOINT       POST /api/batches/:id/override             batches.controller.ts:98
Roles            ZM, CSM, OH
Body             OverrideCommand (6 actions — §13)
Gates            404 BATCH_NOT_FOUND
                 409 OVERRIDE_ON_SITE_CONFLICT { ticketIds }
                 409 CONFLICT_DEFERRED { ticketIds }
Note             `actedAsRole` is hardcoded null here (batches.controller.ts:110) — this
                 controller does NOT use CurrentActor/acting-zone, unlike SchedulesController.
                 AMBIGUOUS: an acting CSM's override audits without the acting role.
```

### 5.9 EP-9 — Intraday CRITICAL sweep `IMPLEMENTED` — mutates

```
CRON             @Cron, job "business-critical-assign", default '*/2 * * * *'  (NO timeZone pin)
Handler          BusinessSweepSchedulerService.criticalAssignTick   business-sweep-scheduler.service.ts:229
Service          IntradayInsertionService.assignCriticalForActiveZones :350
MANUAL           POST /api/intraday-insertions/fire  { zoneId? }    intraday-insertion.controller.ts:53
                 ZM's zoneId is forced from claims; a broader role must supply it (400 ZONE_REQUIRED)
Decides          hard filters → tier → score, via the SAME chooseWithinTier the morning batch uses
                 (intraday-insertion.service.ts:281). No planner pin (deliberate, :279).
                 Base/DEFICIT weights only — never PREVENTIVE (:195-199).
Writes           via assignTicket (insertAtTop=true), plus intraday_insertions
                 (ASSIGNED_DIRECT | ESCALATION_REQUIRED), notifications
Returns          { assigned: number, escalated: number }
```

### 5.10 EP-10 — Same-day intraday updates `IMPLEMENTED` `FRONTEND_RELEVANT` — mutates

```
POST /api/intraday-updates/add      { ticketId, seId, confirm?, reasonCode? }
POST /api/intraday-updates/remove   { batchId, ticketId, reasonCode, confirm? }
POST /api/intraday-updates/reorder  { batchId, stopSequence, reasonCode }
GET  /api/intraday-updates          → IntradayUpdateRow[]
```

`SameDayUpdateService` **re-tags the audit action only** — the mutations are `OverrideService`'s
(`same-day-update.service.ts:13-15`).

⚠ **`DEAD/UNUSED` in practice.** `dispatch-changes-today.service.ts:34-39` states plainly: *"rows
written only by `POST /intraday-updates/*`, which no admin code calls"*. The Intra-day Queue read
(`listIntradayUpdates`) selects `audit_logs WHERE action = 'MANUAL_ZM_UPDATE'`, and the overrides an
operator actually performs go through `POST /batches/:id/override` and audit as `BATCH_OVERRIDE_*`.
**The Intra-day Queue is structurally unable to see the changes the product makes.** `#284`'s
`GET /api/dispatch/changes-today` is the replacement.

### 5.11 EP-11 — Recovery collector `IMPLEMENTED` — mutates, re-enters EP-1

```
CRON             @Cron, job "business-dispatch-recovery", '*/5 * * * *', timeZone Asia/Kolkata
Handler          DispatchSchedulerService.dispatchRecoveryTick     dispatch-scheduler.service.ts:159
Service          DispatchRunService.recoverMarkedZones             dispatch-run.service.ts:624
Behaviour        reads dispatch_zone_recoveries WHERE state=PENDING AND business_date=today,
                 re-enters runForActiveZones per zone with retry {0,0} (never patient)
Bounds           maxAttempts 3 (DISPATCH_RECOVERY_MAX_ATTEMPTS; 0 disables)
                 cutoffHourIst 18 (DISPATCH_RECOVERY_CUTOFF_HOUR_IST)
Returns          { attempted, recovered, exhausted, expired, deferred }
NO HTTP TRIGGER  `NOT FOUND IN CODEBASE` — there is no manual "recover now" endpoint.
```

### 5.12 Reaper (not an engine entry point, but a state mutator)

```
CRON             @Cron, job "business-dispatch-reaper", '*/3 * * * *', timeZone Asia/Kolkata
Service          DispatchRunService.reapStaleDispatchRuns          dispatch-run.service.ts:506
Deliberately     does NOT dispatch (dispatch-scheduler.service.ts:125-129). It records that a
                 zone is owed a day (dispatch_zone_recoveries) and frees the claim.
NO HTTP TRIGGER  `NOT FOUND IN CODEBASE`
```

### 5.13 Entry-point classification matrix

| EP | Mutates state | Read/preview only | Writes audit | Creates holds | Changes assignments | Creates notifications |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| EP-1 cron dispatch | ✓ | | ✓ ×2 | | ✓ | ✓ (outbox) |
| EP-2 manual dispatch | ✓ | | ✓ ×2 | | ✓ | ✓ (outbox) |
| EP-3 scheduler preview | | ✓ | | | | |
| EP-4 override preview | | ✓ | | | | |
| EP-5 distribute preview | | ✓ | | | | |
| EP-6 assign | ✓ | | ✓ | clears | ✓ | ✓ (outbox) |
| EP-7 assign-plants/batch | ✓ | | ✓ (per ticket + per lane) | clears | ✓ | ✓ (outbox) |
| EP-8 batch override | ✓ | | ✓ | ✓ (DEFER_TICKET) | ✓ | ✓ (outbox) |
| EP-9 intraday CRITICAL | ✓ | | ✓ | | ✓ | ✓ (direct) |
| EP-10 intraday updates | ✓ | | ✓ | | ✓ | ✓ (outbox) |
| EP-11 recovery collector | ✓ | | ✓ (via EP-1) | | ✓ | ✓ |
| holds (`/schedules/holds`) | ✓ | | ✓ | ✓ | | |
| bulk-unassign EXECUTE | ✓ | | ✓ | | ✓ (removes) | ✓ |
| bulk-unassign PREVIEW | | ✓ | | | | |

---

## 6. Cron and Background Jobs

**19 registered cron jobs exist app-wide** (`cron-tick-claim.ts:492` names the count). The
scheduler-relevant ones:

| Job name | Default cron | TZ pinned | Entry function | Purpose | Reads | Writes | Failure | Frontend consequence |
|---|---|:--:|---|---|---|---|---|---|
| `business-dispatch` | `0 5 * * *` **from `system_settings.dispatch_cron`** | ✓ IST | `DispatchSchedulerService.dispatchTick` `:85` | the daily run | everything | everything | caught → `{ran:false,reason:'ERROR'}`, logged | run appears in `/api/dispatch-runs`; nothing appears if disabled |
| `business-dispatch-reaper` | `*/3 * * * *` | ✓ IST | `.dispatchReaperTick` `:132` | free crashed claims, mark zones owed | `dispatch_runs`, `dispatch_run_zones` | run→ABORTED, claim→ERROR, `dispatch_zone_recoveries` PENDING | caught, logged | zone card shows `ABANDONED — the run holding this zone stopped reporting`; `recovery` rail appears |
| `business-dispatch-recovery` | `*/5 * * * *` | ✓ IST | `.dispatchRecoveryTick` `:159` | give a crashed zone its day back | `dispatch_zone_recoveries` | re-runs dispatch; state→RECOVERED/EXHAUSTED/EXPIRED | contained per zone | `TodayRecovery` rail state changes |
| `schedule-closure` | `0 4 * * *` (`SCHEDULE_CLOSURE_CRON`) | ✓ IST | `ScheduleClosureScheduler.closeTick` `:116` | close yesterday's plans, recycle unworked tickets | `work_schedules`, batches | schedule→COMPLETED/PARTIAL; `batch_assignment_tickets.removed_at` (`PLAN_EXPIRED`/`RESOLVED_AT_CLOSURE`); ticket→UNASSIGNED | per-zone lock skip → next tick | yesterday's plans leave the live list; recycled tickets reappear in the pool |
| `plant-eligibility-refresh` | `30 4 * * *` (`PLANT_ELIGIBILITY_REFRESH_CRON`) | ✓ IST | `PlantEligibilityRefreshScheduler` | rebuild `plant_eligible_floating_se` MV | plants × territory | the MV + `mv_refresh_state` | throws propagate after recording | stale MV ⇒ the run logs a warning and freezes `configSnapshot.eligibilityMv.stale = true` |
| `business-critical-assign` | `*/2 * * * *` | ✗ **not pinned** | `BusinessSweepSchedulerService.criticalAssignTick` `:229` | direct-assign CRITICAL/HIGH_CRITICAL | tickets + candidates | assignments + `intraday_insertions` | caught → ERROR | escalations rail / intraday queue |
| `business-cross-zone` | `*/15 * * * *` | ✗ | `.crossZoneTick` `:236` | Platinum auto-escalation | tickets | `cross_zone_escalations` | caught | cross-zone queue |
| `business-notification-outbox` | `*/2 * * * *` | ✗ | `.notificationOutboxTick` `:280` | re-drain unsent day-plan notifications | outbox | `sent_at`, `attempts`, `last_error` | caught | none directly |
| `business-soft-inactive` | `0 6,18 * * *` | ✗ | `.softInactiveTick` `:251` | snapshot Soft Inactive Count | `device_states` | `soft_inactive_count_history` | caught | the **history**; the live mode read is separate |
| `business-tier-override-expiry` | `0 * * * *` | ✗ | `.tierOverrideExpiryTick` `:246` | expire company tier overrides | overrides | status→EXPIRED | caught | status truthfulness only — the resolver predicates on `expires_at`, not `status`, so **nothing dispatch-relevant depends on this cadence** (`business-sweep-scheduler.service.ts:27-29`) |
| `business-system-efficiency` | `30 1 * * *` | ✗ | `.systemEfficiencyTick` `:256` | daily cube incl. `auto_escalations` | many | `system_efficiency_summary_daily` | caught | System Efficiency report |
| `partition-maintenance` | `10 0 * * *` | ✗ | `PartitionMaintenanceService` | hosts `pruneExpiredClaims` + `pruneSentDayPlanOutbox` | — | deletes | caught | none |

### 6.1 The timezone finding ⚠

**Only 5 of the 12 jobs above pin `timeZone: BUSINESS_TIMEZONE`.** The four dispatch-family jobs and
the closure job do; the eight `BusinessSweepSchedulerService` jobs (`@Cron(expr, { name })` —
`business-sweep-scheduler.service.ts:218-289`) **do not**.

The code documents exactly why this matters at `dispatch-cron.ts:11-15`: *"an unpinned `@Cron` fires
in the host process timezone, and no `TZ` is set in any compose/Dockerfile/env in this repo, so
'05:00' landed at 10:30 IST on a UTC host."*

For the unpinned jobs, most are minute-cadence (`*/2`, `*/15`) where a timezone is meaningless. But
three are wall-clock-meaningful and are **unpinned**:

- `business-soft-inactive` `0 6,18 * * *` — the MORNING/AFTERNOON discriminator is
  `now.getUTCHours() < 12` (`soft-inactive-count.service.ts` `recompute`), so it is UTC-consistent
  with itself but **not** an IST morning/afternoon.
- `business-system-efficiency` `30 1 * * *` and the three month-start report cubes — these finalise
  "the previous UTC day/month" (`previousUtcDayStart`/`previousUtcMonthStart`,
  `business-sweep-scheduler.service.ts:124-130`), so they are internally UTC-consistent.

`IMPLEMENTED_DIFFERENTLY` / `AMBIGUOUS` — the report cubes are deliberately UTC-bucketed while the
scheduling side is deliberately IST-bucketed. **Frontend consequence:** a report figure and a
dispatch figure for "the same day" may cover different 24-hour windows. This is not a defect the UI
can fix, but a dashboard that puts them side by side should not imply they are the same day.

### 6.2 Cross-instance safety `IMPLEMENTED`

Every scheduler-relevant tick claims its window in `cron_tick_claims` before doing work:

```sql
WITH ins AS (
  INSERT INTO "cron_tick_claims" ("job_name","window_start","claimed_by")
  VALUES ($1, $2, $3) ON CONFLICT ("job_name","window_start") DO NOTHING
  RETURNING "claimed_by")
SELECT TRUE AS inserted, ins."claimed_by" FROM ins
UNION ALL
SELECT FALSE, c."claimed_by" FROM "cron_tick_claims" c
 WHERE c."job_name"=$1 AND c."window_start"=$2 AND NOT EXISTS (SELECT 1 FROM ins)
```
`cron-tick-claim.service.ts:57-72`. Window = the **UTC minute**, truncated
(`cron-tick-claim.ts:511`). Retention 7 days.

A documented caveat is preserved rather than hidden (`cron-tick-claim.service.ts:48-54`): in READ
COMMITTED, a conflicting insert committing *after* this statement begins makes the trailing SELECT
return nothing — that is still an unambiguous refusal (our insert did not land) and is reported as
one with `heldBy: 'another instance'`.

`TICK_CLAIMED` is a **no-op, not a failure** — the UI must never render it as an error
(`business-sweep-scheduler.service.ts:112-118`).

---

## 7. Run Orchestration

`DispatchRunService` — `apps/backend/src/scheduling/dispatch-run.service.ts` (1,324 lines).

### 7.1 `runForActiveZones` — the front door

```
File       scheduling/dispatch-run.service.ts
Function   runForActiveZones(now: Date = new Date(), opts: DispatchRunOptions = {})   :231
Called by  DispatchSchedulerService.dispatchTick :101
           SchedulesController.dispatchRunNow :200
           DispatchRunService.recoverMarkedZones :672  (self-recursion, one level)
Calls      istDate, reapStaleDispatchRuns, retryPolicyFor, admit, execute, releaseStrandedClaims
Reads      plants (distinct zoneId), dispatch_runs, dispatch_run_zones, priority_rule_config,
           system_settings, engineer_master, company_tier_overrides, mv_refresh_state
Writes     dispatch_runs, dispatch_run_zones (+ everything execute() writes)
Returns    DispatchRunOutcome = { result:'RAN', summary } | { result:'CONFLICT', inFlight }
```

**Ordering is load-bearing and documented:**

1. `istDate(now)` → the operating day (`:235`).
2. **Future-day refusal** (`:241-247`) — 15-minute clock-skew allowance (`FUTURE_DAY_SKEW_MS`,
   `:33`). Throws a plain `Error`, so the controller surfaces it as a **500**, not a 400.
   ⚠ `IMPLEMENTED_DIFFERENTLY`: unreachable through the HTTP path today (both live callers hardcode
   `new Date()`), so the guard protects against a future caller, not a current one. Pinned by
   `test/dispatch-preview.e2e-spec.ts:175-180`.
3. **Zone list** — `opts.zoneId ?? activeZoneIds()`, always **ascending** (`:251`), so two concurrent
   admissions take claims in the same order and cannot deadlock.
4. **Reap before asking** (`:257`) — placed here, not inside `admit`, because "a reap that ran after
   [the pre-read] would answer with a refusal it had itself just made obsolete."
5. **Patience policy** (`:262-263`) — real-clock, not `now`: "waiting is wall-clock behaviour, and a
   test that fast-forwards the business date must not thereby fast-forward a deadline."
6. **Admission loop** (`:266-287`) — re-asks while everything is held, reaping each iteration.
7. `execute` in a `try`, `releaseStrandedClaims` in the `finally` (`:289-308`).

### 7.2 `admit` — the atomic run+claim `IMPLEMENTED`

`:343-425`. Two answers and no third:

```
pre-read holdersFor(zoneIds)   ← cheap, outside any transaction (:360)
  if every requested zone held → CONFLICT, NOTHING WRITTEN, no transaction opened
captureConfigSnapshot(now)                                         (:365)
$transaction:
  dispatchRun.create { trigger, actorUserId, actorRole, reason, startedAt,
                       heartbeatAt: now, configSnapshot, ...buildStampFields() }   (:369)
  for each zoneId ascending:
    INSERT INTO dispatch_run_zones (run_id, zone_id, status, started_at)
    VALUES (…, 'RUNNING', now) ON CONFLICT DO NOTHING                (:389)
    claimed === 1 ? admitted.push : refused.push
  claimantsOf(refused, run.runId, tx)                               (:398)
  if admitted.length === 0 → throw AllZonesHeldError(holders)  ⇒ full rollback
  for each refused: dispatchRunZone.create { status:'CONTENDED',
                    contendedWithRunId, startedAt: now, finishedAt: now }   (:404)
```

**Why `ON CONFLICT DO NOTHING` and not insert-and-catch** (`:337-341`): a P2002 aborts its Postgres
transaction, so catching one would leave nothing to continue with. `DO NOTHING` answers with a row
count, which lets run row + claims + refusals live in one rollback-able transaction.

**Why a CONTENDED row gets `finishedAt: now`** (`:411-413`): "leaving `finishedAt` null would make a
CONTENDED row look like a live claim to every reader that checks for one."

**Why `claimantsOf` ≠ `holdersFor`** (`:446-455`): the winner of a tight race can finalize to DONE
before the loser looks, so a live-only read answers "nobody" and the loser gets a bare 409 naming no
one. `claimantsOf` uses `DISTINCT ON (zone_id) … ORDER BY started_at DESC, id DESC`, which is stable
under that race.

The concurrency contract is enforced by the DB index **`ux_dispatch_run_zones_one_running_per_zone`**
(raw SQL; referenced at `schema.prisma:795-797`).

### 7.3 `execute` — the run body

`:842-978`.

```
audit DISPATCH_RUN_STARTED  { trigger, zonesClaimed, zonesContended }        (:861)
warnIfEligibilityStale(runId, day)                                          (:874)
for zoneId of admitted → processZone(...)                                   (:895)
stillContended = retry ? waitOutContention(...) : contended                 (:901)
push CONTENDED zoneOutcomes                                                 (:906)
status = …                                                                   (:922)
dispatchRun.updateMany WHERE runId AND status='RUNNING'  ← compare-and-set   (:932)
audit DISPATCH_RUN_FINISHED { …every total…, errorCount }                   (:951)
```

**Run status derivation** (`:921-927`) — exact:

```ts
const processed = summary.zoneOutcomes.length - stillContended.length;
const status =
  stillContended.length === 0 && totals.zonesWithIssue === 0        ? 'SUCCESS'
: stillContended.length === 0 && processed > 0
    && summary.errors.length >= processed                           ? 'FAILED'
:                                                                     'PARTIAL';
```

Notes the UI needs:
- `ABORTED` is **never** written here — reaper-only (`schema.prisma:786-789`).
- A zone recovered by the patience loop is a plain success; PARTIAL is measured against zones *still*
  held when the run finished, not zones held at admission (`:918-920`).
- `errors` counts **thrown** zones; `zonesWithIssue` also counts a benign `skipReason`
  (`LOCK_CONTENDED`), so a run can be PARTIAL with an empty `errors` array.
- The finalize is `updateMany … status:'RUNNING'`, so a run the reaper already ABORTED does **not**
  overwrite that; it logs `dispatch run N finished after being reaped — <status> not recorded`
  (`:948-950`).

### 7.4 `processZone` — one zone `IMPLEMENTED`

`:1075-1113`. The whole per-zone body, with containment:

```ts
try {
  rec = await this.recommender.runForZone(zoneId, { now, runId });
  out = await this.dispatch.dispatchForZone(zoneId, { dateFrom: day, dateTo: day, now, runId });
  summary.zones++;
  error = out.skipReason ?? null;          // a benign skip still stamps `error`
} catch (e) { error = …; summary.errors.push({ zoneId, message: error }); }
await this.finalizeZoneClaim(runId, zoneId, rec, out, error);
await this.touchHeartbeat(runId);          // AFTER finalize — attests to work completed
summary.zoneOutcomes.push({ zoneId, outcome: error === null ? 'DONE' : 'ERROR' });
totals += …                                 // (:1104-1112)
```

**Totals are accumulated from exactly what the zone row records**, so a run's columns equal the sum
of its zone cards *by construction* (`:1072-1073`). `bucketlessDropped` and
`componentBlockedWithheld` accumulate as `null → number` only when a zone actually reported
(`:1110-1111`), preserving "not measured" ≠ "none".

### 7.5 `waitOutContention` — bounded patience `IMPLEMENTED`

`:992-1026`. CRON only.

```
while (pending.length && Date.now() + intervalMs <= patientUntil) {
  sleep(intervalMs)                 // real timers — it is waiting on another process
  reapStaleDispatchRuns(new Date()) // a crashed holder is freed by the reaper, not by waiting
  touchHeartbeat(runId)             // "a patient run that stopped beating would reap itself"
  for c of pending:
     promoteContendedClaim(runId, c.zoneId) ? processZone(...) : stillHeld.push(c)
}
```

`promoteContendedClaim` (`:1043-1062`) is an **UPDATE, not an insert** — `@@unique([runId, zoneId])`
means a run gets exactly one row per zone, so a late admission promotes the refusal in place. Guarded
by `NOT EXISTS (… RUNNING …)`, with the partial unique as backstop; a P2002 here is safe to catch
because it is a single statement with no interactive transaction to abort.

`contended_with_run_id` is deliberately **not cleared** on promotion — "who refused this run is the
only surviving trace of the collision" (`:1036-1038`). So a **DONE zone card can still carry
`contendedWithRunId`**. The UI must discriminate on `outcome`, not on the presence of that field.

The invariant `reap (10 min) ≤ retry deadline (15 min)` is stated and justified at
`dispatch-cron.ts:166-179`.

### 7.6 Heartbeat, reaping, stranded claims

| Mechanism | Function | When | Guard |
|---|---|---|---|
| heartbeat | `touchHeartbeat` `:756` | at admission (`heartbeatAt: now` on create) and after **every zone** | `status:'RUNNING'` — a terminal run cannot beat its way back to looking alive |
| reap | `reapStaleDispatchRuns` `:506` | before admission, per patience iteration, every 3 min | `staleDispatchRunFilter` — `heartbeatAt < cutoff` OR (`heartbeatAt` null AND `startedAt < cutoff`) |
| stranded claims | `releaseStrandedClaims` `:770` | `finally` of every run | `status:'RUNNING'` — matches nothing on a clean run |

**Reaper write order is deliberate** (`:495-499`): run first (→`ABORTED`), then its claims
(→`ERROR`, `error = ABANDONED_CLAIM_ERROR`). If the reaper itself dies between them, claims are
still RUNNING under an ABORTED run — which the **next** pass finds, because the orphan read is by
*predicate* (`status:'RUNNING', run: { status: { not: 'RUNNING' } }`, `:527-530`), not by the run-id
list.

`markZonesForRecovery` (`:566-599`) runs **before** the claims are freed (`:536-540`): "if this
process dies in the gap the claim is still RUNNING under a terminal run, so the next pass finds it
here again and re-marks; marking afterwards would lose the zone's day to the very crash the reaper
exists to survive."

### 7.7 Config snapshot — what is frozen `FRONTEND_RELEVANT`

`captureConfigSnapshot` `:1183-1261`. Written to `dispatch_runs.config_snapshot` (JSONB). This is
what the run-detail "Config in effect" panel renders.

```jsonc
{
  "priorityRules": [ { "weightSetRef": "v1", "component": "company_priority_rank", "weight": 0.4 } ],
  "settings": {
    "plant_cluster_multiplier": 1.25,
    "eligibility_mode": "pgi",
    "se_assignment_threshold_hours": 24,
    "inactivity_threshold_hours": 24,
    "dispatch_cron": "0 5 * * *"
  },
  "capacity": { "<engineerId>": { "dailyCapacity": 6, "isActive": true } },
  "scheduler": { "businessSweepsEnabled": true, "dispatchCron": "0 5 * * *" },
  "tierOverrides": [ { "id":"1","companyId":"7","zoneId":"3","tier":"PLATINUM","expiresAt":"…Z" } ],
  "eligibilityMv": {
    "viewName": "plant_eligible_floating_se",
    "lastSuccessAt": "…Z" | null,
    "lastAttemptAt": "…Z" | null,
    "lastError": null | "…",
    "stale": false
  }
}
```

`capacity` is the **historical denominator** — a later capacity edit must not rewrite past runs
(`:1179-1180`). `DispatchTransparencyQueryService.capacityFromSnapshot` (`:935-944`) reads it back
for the zone-detail `capacityUsed.cap`. `eligibilityMv.stale` is computed **at admission**, not left
to the reader, "because staleness is relative to the operating day this run belongs to."
---

## 8. Zone Processing

### 8.1 Zone discovery

```
File     scheduling/dispatch-run.service.ts
Function activeZoneIds()                                                       :1318
SQL      prisma.plant.findMany({ distinct:['zoneId'], select:{zoneId:true},
                                  orderBy:{zoneId:'asc'} })
Rule     "Active zones = zones with at least one plant (the only zones that can carry
          dispatchable work)."                                                  :1317
```

The same universe is used by `BulkUnassignService.resolveZoneIds` (`bulk-unassign.service.ts:392`)
and `IntradayInsertionService.assignCriticalForActiveZones` (`intraday-insertion.service.ts:353`),
each with a comment naming `activeZoneIds` as the definition being mirrored.

⚠ `AMBIGUOUS`: a zone whose only plants are all **deactivated** is still an "active zone" here — the
deactivation filter lives in the recommender's ticket query (`plant.deactivations: { none: {…} }`,
`recommender.service.ts:356`), not in zone discovery. Such a zone gets a claim, a zone card and zero
totals. The UI cannot distinguish it from a zone with no work.

### 8.2 Zone lifecycle states — the vocabulary the UI renders

`dispatch_run_zones.status` — enum `DispatchZoneClaimStatus` (`schema.prisma:799-806`):

| Value | Meaning | Written by | `finishedAt` |
|---|---|---|---|
| `RUNNING` | live claim; **at most one per zone globally** | `admit` `:389` / `promoteContendedClaim` `:1045` | null |
| `DONE` | this run held and completed the zone | `finalizeZoneClaim` `:1141` (error === null) | set |
| `ERROR` | this run held it and something went wrong — a throw **or** a benign whole-zone skip | `finalizeZoneClaim` `:1141` / `releaseStrandedClaims` `:774` / reaper `:544` | set |
| `CONTENDED` | this run asked and was refused; `contendedWithRunId` names the holder | `admit` `:404` | set (= `startedAt`) |

**A CONTENDED zone is neither a success nor a failure of this run** (`:914-916`) — it cannot be
SUCCESS (the request was not fully served) and cannot be FAILED (nothing failed), which is exactly
what PARTIAL means.

Three distinct `error` strings a zone card can carry:
- `ABANDONED — the run holding this zone stopped reporting` (`ABANDONED_CLAIM_ERROR`, `:167`)
- `dispatch run ended without finalizing this zone` (`releaseStrandedClaims`, `:774`)
- `LOCK_CONTENDED` (from `DispatchSummary.skipReason`, `batch-assignment.service.ts:36-39`)
- or the raw thrown message.

### 8.3 Two locks, deliberately different scopes `IMPLEMENTED`

| | Zone **claim** (#259) | Zone **advisory lock** (#100/#262) |
|---|---|---|
| Mechanism | `dispatch_run_zones` row + `ux_dispatch_run_zones_one_running_per_zone` | `pg_advisory_xact_lock(hashtext('dispatch_zone_<id>'))` |
| Lifetime | admission → zone finalize (**spans the whole zone**) | one transaction (now **per SE**) |
| Excludes | run vs run | dispatch vs **closure** and **bulk-unassign** |
| Survives restart | ✓ (durable row) | ✗ |
| Key definition | — | `scheduling/dispatch-zone-lock.ts:424` |
| Timeout | n/a | `ZONE_LOCK_TIMEOUT_MS = 3_000` (`dispatch-zone-lock.ts:439`) |
| Acquisition | `INSERT … ON CONFLICT DO NOTHING` | **blocking** in dispatch (`:161-162`), `pg_try_…` in closure (`schedule-closure-scheduler.service.ts:170`) and bulk-unassign (`bulk-unassign.service.ts:248`) |

`zone-claim.ts:446-467` explains why both are needed: the advisory lock is transaction-scoped, and
since #262 split dispatch into one transaction per SE, **the lock is released between engineers**. A
bulk-unassign landing in one of those gaps would half-rebalance the zone. The claim spans the gaps;
the lock is the in-transaction backstop.

`BulkUnassignService.executeZone` therefore reads the claim **first** (`liveZoneClaimRunId`,
`bulk-unassign.service.ts:238`) and skips with `DISPATCH_IN_PROGRESS` before even trying the lock —
a distinct skip reason from `LOCK_CONTENDED`, kept apart because they call for different operator
responses (`bulk-unassign.service.ts:349-352`).

### 8.4 Zone contention — the full matrix `FRONTEND_RELEVANT`

| Actor A holds | Actor B arrives | B's outcome | Where |
|---|---|---|---|
| dispatch run | another dispatch run (CRON) | CONTENDED row → patience loop → promoted or left CONTENDED | `admit` / `waitOutContention` |
| dispatch run | another dispatch run (MANUAL) | **409** `DISPATCH_ALREADY_RUNNING` with holder details | `schedules.controller.ts:209-215` |
| dispatch run | bulk-unassign | zone skipped, `skipReason: 'DISPATCH_IN_PROGRESS'`, audit row written | `bulk-unassign.service.ts:238-243` |
| dispatch run | schedule closure | zone skipped (try-lock fails), logged, retried next tick | `schedule-closure-scheduler.service.ts:171-173` |
| closure / bulk-unassign | dispatch (per SE) | blocks up to 3 s, then that **SE** is skipped with `ZONE_LOCK_TIMEOUT` in `seSkips` | `batch-assignment.service.ts:161`, `se-skip.ts:311-313` |
| dispatch preview | anything | **never contends** — no claim, no lock, no run row | `dispatch-run.service.ts:788-796` |

### 8.5 Zone recovery marks

`dispatch_zone_recoveries`, unique on `(zone_id, business_date)` — **one attempt budget per zone per
day**, not per crash (`schema.prisma:955-956`).

State machine (`DispatchRecoveryState`, `schema.prisma:940-947`):

```
                    reaper finds an orphan claim
                              │
                              ▼
   (none) ────────────────► PENDING ──── collector run DONE ────► RECOVERED
                              │  ▲                                    │
        attempts >= max       │  └──── crashes again (re-armed) ──────┘
              ▼               │
          EXHAUSTED           │  istHour >= cutoff (18:00)
                              └────────────────────────► EXPIRED
```

`markZonesForRecovery` (`:566-599`) re-arms **only** `PENDING` and `RECOVERED`
(`state: { in: ['PENDING','RECOVERED'] }`, `:588`). `EXHAUSTED` and `EXPIRED` are deliberately left
alone — re-arming on a fresh crash "would make 'bounded' a property of each incident instead of the
day, and a zone that crashes every run would loop forever."

The upsert + guarded `updateMany` are **two statements on purpose**: `update: {}` cannot express
"only if still re-armable", and a blanket update would resurrect an EXHAUSTED zone (`:585-587`).

Failure to write a mark is caught and logged, never fatal: "a wedged zone is strictly worse than an
unrecovered one" (`:591-597`).

**Attempt accounting** — a **refusal does not spend an attempt** (`recoverMarkedZones:677-686`):
being busy is not being broken. A `CONFLICT` result or a `CONTENDED` zone outcome increments
`deferred` and `continue`s without touching `attempts`. The operating-day cutoff is what stops the
refusal case looping forever.

`retireMark` (`:730-747`) is a **compare-and-set**: `where: { id, state:'PENDING', attempts: seenAttempts }`
— "a write by primary key silently overwrites a decision somebody else already made — here, a second
collector that got the zone first."

---

## 9. Ticket Data Lineage

### 9.1 The selection query — every clause

`recommender/recommender.service.ts:345-397`.

```ts
prisma.ticket.findMany({
  where: {
    workType: 'TROUBLESHOOT',
    status: 'OPEN',
    assignmentState: 'UNASSIGNED',
    AND: [ notComponentBlocked() ],                                    // #177
    ...(opts.ticketIds ? { ticketId: { in: opts.ticketIds } } : {}),   // #276 Distribute scope
    ...notDeferredOn(targetDay),                                       // #146 holds
    plant: { zoneId, deactivations: { none: { reactivatedAt: null } } },  // #119
    device: {
      departures: { none: { restoredAt: null } },                      // #128
      OR: [                                                            // #238 threshold gate
        { state: { inactivityHours: { gte: assignmentThresholdHours } } },
        { state: { inactivityHours: null } },
        { state: { is: null } },
      ],
    },
  },
  include: {
    company: { select: { companyTier: true, companyPriorityRank: true } },
    device: { select: { state: { select: { slaBucket: true, latestGpsDatetime: true,
                                           computedAt: true } } } },
  },
})
```

**No `orderBy`.** `canonical-sort.ts:6-13` states this explicitly and corrects a stale docstring:
*"This comparator is the only thing that orders the dispatch path — there is no SQL mirror."* The
sort is applied once, in process. The rank expressions in `device.service.ts` /
`ticket-query.service.ts` are unrelated display sorts.

**Two measured Prisma traps documented in-line, worth knowing before writing any similar query:**

1. `recommender.service.ts:377-383` — `NOT: { state: { is: { inactivityHours: { lt: n } } } }` is
   **wrong**: Prisma renders a negated to-one relation filter such that a state row with a NULL
   `inactivity_hours` matches *neither* the filter nor its negation, so every NULL-houred device is
   silently dropped. The explicit three-branch `OR` is the fix, "verified against the database
   rather than reasoned about."
2. `recommender.service.ts:337-341` and `component-blocked.ts` — `notComponentBlocked()` and
   `notDeferredOn()` **both** express themselves as a top-level `OR`. Spreading both flat into one
   object silently keeps only the last. Hence `AND: [notComponentBlocked()]`. "Measured, not feared.
   It cost one confusing red run where the exclusion appeared to do nothing at all."

### 9.2 The rankability filter — `bucketlessDropped`

```ts
const rankable = tickets.filter((t) => t.device.state?.slaBucket != null);   :434
const bucketlessDropped = tickets.length - rankable.length;                  :439
```

These tickets get **no recommendation, no UNASSIGNABLE row and no trace** — "on the run report they
did not exist" (`:96-97`). On the dev mirror at filing, **5,127 of 6,464** open unassigned
Troubleshoot tickets carried no computed SLA bucket
(`dispatch-transparency-query.service.ts:60-62`).

**Frontend consequence:** this is the single largest hidden population. It is exposed as a *count*
on the zone card (`bucketlessDropped`), nullable, and **is not itemisable** — there is no list.

### 9.3 Per-field lineage

Legend for **Scheduler usage**: **[SORT]** canonical order · **[SCORE]** scoring feature ·
**[GATE]** selection predicate · **[TRACE]** persisted explanation only · **[DISPLAY]** read surface.

| Field | Origin (table.column) | DTO / service field | Transformation | Scheduler usage | Output/API field |
|---|---|---|---|---|---|
| ticket ID | `tickets.ticket_id` (uuid) | `CandidateTicket.ticketId` | — | identity | `ticketId` everywhere |
| ticket no. | `tickets.ticket_no` (bigint autoinc) | — | display label `TCK-` + zero-pad 5 | **none** | `NOT SURFACED` in any scheduler API |
| device ID | `tickets.device_id` | `CandidateTicket.deviceId` | — | **[SORT]** key 5, absolute tie-break | `deviceId` |
| vehicle ID | `tickets.vehicle_id` (nullable) | — | — | **none** in selection | `vehicleNo` via `vehicle.vehicleNo` in batch detail / trace identity |
| plant | `tickets.plant_id` | `RunCandidate.plantId` | `String()` | **[GATE]** zone + deactivation; **[SCORE]** cluster + distance destination; grouping key for stops | `plantId`, `plantName` |
| zone | `plants.zone_id` (**not** `tickets`) | — | — | **[GATE]** the run's zone scope; the ZM clamp key | `zoneId` |
| customer/company | `tickets.company_id` | — | — | grouping in work pool | `companyName` |
| company tier | `company_master.company_tier`, **overridden** by `company_tier_overrides` | `CandidateTicket.companyTier` | `resolveActiveOverrides` newest-wins per (company, zone) | **[SORT]** key 1 | `companyTier` on recommendation + decision row |
| tier override id | `company_tier_overrides.id` | `RunCandidate.tierOverrideId` | — | **[TRACE]** only | `scoreBreakdown.tierOverrideId`; `PreviewDecision.tierOverrideId` |
| company priority rank | `company_master.company_priority_rank` (**free `String`**, not enum) | `companyPriorityRank` | `rankScore()` A=1.0, −0.1/letter, clamped ≥0 | **[SORT]** key 3; **[SCORE]** `company_priority_rank` | `scoreBreakdown.companyPriorityRank`, `.rankScore` |
| ticket type | `tickets.work_type` | — | — | **[GATE]** `TROUBLESHOOT` (main) / `INSTALL` (PREVENTIVE backlog) | `workType` (shared pool only) |
| severity / SLA bucket | `device_states.sla_bucket` | `CandidateTicket.deviceBucket` | `classifySlaBucket(inactivityHours)`, computed upstream | **[GATE]** null ⇒ dropped; **[SORT]** key 2; **[SCORE]** via `urgencyFromBucket` | `deviceBucket`, `slaBucket` |
| dispatch urgency | derived | `ScoringFeatures.dispatchUrgency` | `bucketRank(b) / 7` → 0…1 | **[SCORE]** `dispatch_urgency` | `scoreBreakdown.urgency` |
| SLA windows | `sla_rule_config` | — | — | **NOT READ BY THE SCHEDULER** — `NOT FOUND IN CODEBASE` as a dispatch input | — |
| age / inactivity | `device_states.latest_gps_datetime` | `RunCandidate.ageAnchor` | `(now − anchor)/3.6e6`, floored 0 | **[SORT]** key 4 (oldest first, null last); **[SCORE]** `device_age` (PREVENTIVE only) | `latestGpsDatetime`; `scoreBreakdown.ageScore` |
| inactivity hours (stored) | `device_states.inactivity_hours` (`Decimal(12,4)`) | — | `Number()` — Prisma returns a Decimal object, and `Math.max` would coerce it to NaN (`assignable-work-query.service.ts:99-103`) | **[GATE]** threshold; **[DISPLAY]** `oldestInactivityHours` | `oldestInactivityHours` |
| repeat failure | `tickets.repeat_failure` (bool) | `RunCandidate.repeatFailure` | 1/0 | **[SCORE]** penalty (DEFICIT) **or** bonus (PREVENTIVE) | `scoreBreakdown.repeatPenalty` |
| due date / vehicle-return | `vehicle_unavailability_reports.expected_from` WHERE `status='OPEN'` | `CandidateTicket.returnDueToday` | `expectedFrom < returnDateArrivedBefore(asOf)` | **[SORT]** key 2b — **only below CRITICAL+** | `returnDueToday` (cockpit `RET` chip) |
| status | `tickets.status` | — | — | **[GATE]** `OPEN` (`REQUESTED` for installs) | `ticketStatus` |
| assignment state | `tickets.assignment_state` | — | — | **[GATE]** `UNASSIGNED`; written `FORMALLY_ASSIGNED` on commit | — |
| component availability | `failure_cycles.state = 'WAITING_COMPONENT'` | — | `notComponentBlocked()` | **[GATE]** excluded; counted as `componentBlockedWithheld` | zone-card count |
| travel / location | `plants.location` — PostGIS `geometry(Point,4326)`, `Unsupported` in Prisma | `LatLng` | raw SQL `ST_Y/ST_X`; absent when NULL | **[SCORE]** `distance` destination | `scoreBreakdown.distanceKm` |
| existing assignment | `batch_assignment_tickets WHERE removed_at IS NULL` | — | — | idempotency guard at commit | `assignedSeId`/`assignedSeName` on escalation rows |
| hold / defer state | `tickets.deferred_until` (`@db.Date`) | — | `notDeferredOn(day)` — **inclusive** | **[GATE]** excluded before the day; also `heldTickets` count | `heldUntil` |
| special-ticket flag | `system_settings.special_attempt_threshold` + attempt windows | — | — | **NOT A SCHEDULER INPUT** — reporting only | — |
| device departed | `device_departures WHERE restored_at IS NULL`; mirrored on `device_states.is_departed` | — | — | **[GATE]** excluded (TROUBLESHOOT only; **not** for INSTALL, `:1065-1068`) | — |
| plant deactivated | `plant_deactivations WHERE reactivated_at IS NULL` | — | — | **[GATE]** excluded | — |
| `computedAt` | `device_states.computed_at` | — | `max()` over ranked rows | **[TRACE]** the preview's staleness watermark | `bucketsAsOf` |

### 9.4 `returnDueToday` — derived, never stored `IMPLEMENTED`

`recommender.service.ts:1041-1049`:

```ts
prisma.vehicleUnavailabilityReport.findMany({
  where: { ticketId: { in: ticketIds }, status: 'OPEN',
           expectedFrom: { lt: returnDateArrivedBefore(asOf) } },
  select: { ticketId: true }, distinct: ['ticketId'],
})
```

One query per run, not per ticket. `distinct` because a supersession chain can hold more than one
row and only OPEN membership matters.

**Why it is not a column** (`:446-451`): "a stored flag would need writing on filing, rewriting on a
manager's date change, and clearing on dispatch or supersession — four writers for one derived fact,
any of which going missing leaves a ticket jumping the queue for good."

`returnDateArrivedBefore(now)` = `istDayStartInstant(now) + 24h` (`ticketing/deferral.ts`) — the
exclusive upper bound, written as one end-exclusive instant so `@@index([status, expectedFrom])` is
usable, rather than wrapping the column in a day-truncating expression.

⚠ **The cockpit uses a different bound.** `DispatchTodayQueryService.returnDueToday` (`:344-355`)
uses `expectedFrom: { lt: new Date(day.getTime() + 86_400_000) }` where `day = istDate(now)` (UTC
midnight of the IST date). The recommender uses `istDayStartInstant(now) + 24h` (the real instant).
These differ by 5h30m. `IMPLEMENTED_DIFFERENTLY` — the two answers to "is the vehicle due back
today" can disagree for a report whose `expected_from` falls in that window. The cockpit's own
docstring explains its intent ("overdue is exactly when the operator most needs to see it") but the
boundary is not the shared `deferral.ts` one.

### 9.5 Install backlog lineage (PREVENTIVE mode only)

`recommender.service.ts:1051-1102`.

```
where  workType: 'INSTALL', status: 'REQUESTED', assignmentState: 'UNASSIGNED',
       notDeferredOn(day), plant: { zoneId, deactivations: none }
       ── NO device-departure filter, deliberately (:1065-1068): "An Install exists to bring a
          device INTO the fleet, so 'not currently deployed at source' is its normal starting state."
order  installSort: tier desc → priorityRank asc → oldest backlogAnchor → ticketId asc
anchor installTargetDate ?? createdAt
shape  deviceBucket: null  →  dispatchUrgency 0  →  "backlog, not an active outage"
       repeatFailure: false (hardcoded)
```

---

## 10. Engineer Data Lineage

### 10.1 Candidate discovery

`recommender/candidate-selection.service.ts:23-54`. **Two queries per (plant, ticket).**

```ts
// leg 1+2 — se_coverage
const coverage = await prisma.seCoverage.findMany({ where:{ plantId }, orderBy:{ seId:'asc' } });
dedicated = coverage.filter(c => c.coverageType === 'DEDICATED')
multi     = coverage.filter(c => c.coverageType === 'MULTI_PLANT')

// leg 3 — the floating MV, RE-VALIDATED against engineer_master LIVE
SELECT pefs.se_id FROM plant_eligible_floating_se pefs
  JOIN engineer_master em ON em.engineer_id = pefs.se_id
 WHERE pefs.plant_id = $1 AND em.coverage_type = 'FLOATING' AND em.is_active = true
 ORDER BY pefs.se_id ASC

return [...dedicated, ...multi, ...floating]      // strict precedence order
```

**Why the live re-validation** (`:35-40`): the MV "is a territory-geometry index only — its
definition joins plants × engineer_territory_coverage and cannot express `coverage_type` /
`is_active`, and it is refreshed only on territory edits (never on an SE coverage-type flip or
deactivate via `/engineers/manage`). Trusting it alone would resurrect a now-DEDICATED or inactive SE
as a floating candidate."

⚠ **Cost note.** `orderedCandidatesForPlant` is called **once per ticket** inside the run loop
(`recommender.service.ts:593`), not once per plant. Two queries × N tickets. `CandidateQueryService`
calls it once per plant and explicitly flags the fan-out risk for Distribute
(`candidate-query.service.ts:65-72`).

### 10.2 Per-field lineage

| Field | Origin | Persisted / calculated / cached | Service field | Scheduler usage |
|---|---|---|---|---|
| engineer ID | `engineer_master.engineer_id` (= `users.user_id`, uuid) | persisted | `seId` | identity |
| name | `users.name` via `engineer_master.user` | persisted | `seName`, `name` | display only — the engine never reads it |
| role | `users.role` | persisted | — | not read by the engine |
| **global** coverage type | `engineer_master.coverage_type` | persisted | `ZoneEngineerRow.coverageType`, `TodayEngineer.coverageType` | **only** gates the FLOATING MV leg |
| **per-plant** coverage type | `se_coverage.coverage_type` ∪ floating MV | persisted (hard-deleted on removal) | `CandidateSe.coverageType` | **[TIER]** — the precedence that decides the winner |
| tier rank | derived | calculated | `CandidateRow.tierRank` (1/2/3) | display grouping in the candidate column |
| coverage at assign | resolved at write time | **persisted** on `batch_assignment_tickets.coverage_type_at_assign` | `coverageTypeAtAssign` | the "human crossed a tier" signal |
| availability | `se_availability` window covering `now` | persisted; **memoised per run** | `availabilityStatus` | **[FILTER]** `SE_UNAVAILABLE` |
| leave | `leave_requests` → materialises an `se_availability` window | persisted | — | indirect, via availability |
| unavailable windows | `se_availability.window_start/window_end` (`Timestamptz`, **end-exclusive**) | persisted | `AvailabilityRow` | as above |
| home / base location | `engineer_master.home_lat`, `.home_lng` (plain `Float?`, **not** PostGIS) | persisted | `LatLng` | **[SCORE]** distance seed |
| current location | — | **`NOT FOUND IN CODEBASE`** | — | **no live GPS for engineers**, stated at `schema.prisma:253-256` ("Q6: existing plant coordinates, NO live GPS in Phase 1") |
| route position | derived in-run | **calculated, in-memory only** | `currentPos: Map<seId, LatLng\|null>` | **[SCORE]** distance origin; advances on each win |
| plant coverage | `se_coverage` | persisted | — | tier |
| multi-plant coverage | `se_coverage` rows with `MULTI_PLANT` | persisted | — | tier 2 |
| floating coverage | `plant_eligible_floating_se` MV | **materialized view**, rebuilt 04:30 IST | — | tier 3 |
| territory | `engineer_territory_coverage` (state / region / district / polygon) | persisted | — | feeds the MV only |
| capacity | `engineer_master.daily_capacity` (`Int`) | persisted; read once per run | `capacity: Map` | **[FILTER]** `OVER_CAPACITY` |
| used capacity | `batch_assignment_tickets` live rows on live schedules covering the day | **calculated** — `committedDayPlan` | `committed` | seeds the counter; rendered everywhere |
| remaining capacity | `dailyCapacity − committed` | calculated | `headroom` (Distribute only) | `CAPACITY_HEADROOM` allocation |
| assigned tickets | `batch_assignment_tickets` | persisted | `TodayStop.tickets` | display |
| planned stops / route | `plant_batch_assignments.stop_sequence` | persisted | `TodayStop.stopSequence` | display + append point |
| planner pin | `se_planner (se_id, plant_id, planned_date)` | persisted | `plannerByPlant: Map<plantId, Set<seId>>` | **[WINNER]** overrides the score, crosses tiers |
| skills / components | `se_van_stock` × `common_kit_definitions` | persisted | `CommonKitStatus` | **[FILTER]** `COMMON_KIT_INCOMPLETE` |
| readiness (vehicle) | — | **`EXPECTED_BUT_NOT_FOUND`** (Issue 28 unbuilt) | `vehicleReadiness: 'UNKNOWN'`, `enforced: false` | reported `NOT_ENFORCED`, never drops |
| expected components | — | **`EXPECTED_BUT_NOT_FOUND`** (Issue 22 unbuilt) | `expectedComponentsAvailable: true`, `enforced: false` | reported `NOT_ENFORCED`, never drops |
| workload | = `committed` | calculated | | |
| current/next stop | `stop_sequence` max on live rows | calculated in `committedDayPlan` | `lastStopPlantId` | **[SCORE]** distance seed |
| activity ping | `engineer_master.last_activity_at` | persisted | — | **NEVER a filter** — see §12.3 below |
| `isActive` | `engineer_master.is_active` | persisted | | folded into `available` |
| shift window | `engineer_master.shift_start/.shift_end` (`@db.Time`) | persisted | — | **`DEAD/UNUSED`** — no scheduler read found |
| preferred channel | `engineer_master.preferred_notification_channel` | persisted | — | notifications only |

### 10.3 `committedDayPlan` — the one definition of "committed" `IMPLEMENTED`

`scheduling/committed-day-load.ts:80-110`.

```ts
prisma.batchAssignmentTicket.findMany({
  where: {
    removedAt: null,
    batch: {
      ...(opts.seIds ? { seId: { in: opts.seIds } } : {}),
      schedule: { ...liveScheduleFilter(), dateFrom: { lte: target }, dateTo: { gte: target } },
    },
  },
  select: { batch: { select: { seId:true, plantId:true, stopSequence:true } } },
})
→ Map<seId, { count, plants: Set<plantId>, lastStopPlantId }>
```

The unit is **a live day-plan stop**: a `batch_assignment_tickets` row still `removed_at IS NULL`, on
a **live** schedule (`ACTIVE` ∪ `OVERRIDDEN`) whose `[dateFrom, dateTo]` covers the day. Counted
across **every zone and every run**, because `daily_capacity` caps the engineer's whole day.

**Three properties the UI depends on:**
- **No batch-status filter, deliberately** (`:31`) — "the recommender has never applied one, and a
  PARTIAL batch's unfinished tickets are exactly the work that still burns the engineer's day."
- **`OVERRIDDEN` counts** (`:14`) — a ZM adjusting a plan does not un-commit the work on it.
  Counting only `ACTIVE` zeroed the SE's load and let the next run hand them a whole second day.
- **Absent ≠ zero** (`:37-38`) — SEs with nothing committed are *absent* from the map; read it as
  `load.get(seId) ?? 0`.

**Why it is a module, not a private method** (`:16-25`): it was three methods giving three different
answers — the recommender's, `EngineersQueryService.activeTicketCountBySe` (no date filter, plus a
batch-status filter), and `ZmScheduleRow.ticketCount` (one schedule, not one day). Nothing rendered
any of them beside `daily_capacity`, so the disagreement was invisible. #269 renders it, so display
and enforcement now share this function. `test/capacity-overload-visibility.e2e-spec.ts` asserts the
agreement through both public seams rather than trusting the shared import.

**Consumers:** `RecommenderService` (`:504`), `CandidateQueryService` (`:121`),
`ZmScheduleQueryService.listZoneEngineers` (`:218`), `DispatchTodayQueryService` (`:225`),
`OverrideProjectionService` (`:144`), `DistributeProjectionService` (`:226`),
`IntradayInsertionService` (`:208`).

---

## 11. Coverage / Eligibility

### 11.1 The three tiers, exactly

| Tier | Source | Precedence | Freshness | Fallback |
|---|---|:--:|---|---|
| `DEDICATED` | `se_coverage.coverage_type = 'DEDICATED'` | 1 | live | — |
| `MULTI_PLANT` | `se_coverage.coverage_type = 'MULTI_PLANT'` | 2 | live | — |
| `FLOATING` | MV `plant_eligible_floating_se` ⋈ `engineer_master` (live) | 3 | MV rebuilt **04:30 IST daily**; join is live | MV stale ⇒ **proceed with a warning**, never refuse |

There is no fourth tier. `NONE` exists only as a `coverage_type_at_assign` value recording that a
**human** assigned outside all three (`add-source.ts:128-141`) — the engine can never produce it.

### 11.2 MV composition

The MV precomputes plant → eligible-FLOATING-SE as the **union** of hierarchical membership
(district / region / state) and `ST_Contains(polygon, plant.location)`
(`org/plant-eligible-floating-se.service.ts` docstring). It is defined in raw SQL, invisible to
Prisma. `refresh()` tries `REFRESH MATERIALIZED VIEW CONCURRENTLY` and falls back to a plain refresh
for the first-ever run (created `WITH NO DATA`).

### 11.3 Freshness — `IMPLEMENTED`, non-blocking by design

`isMvStale(freshness, dayStart)` (`plant-eligible-floating-se.service.ts`):

```ts
if (freshness.lastSuccessAt == null) return true;          // never-refreshed IS stale
return new Date(freshness.lastSuccessAt).getTime() < dayStart.getTime();
```

Consumed twice per run:
- `warnIfEligibilityStale` (`dispatch-run.service.ts:1270`) — logs a warning, **never throws**;
- `captureConfigSnapshot` (`:1245-1259`) — freezes `eligibilityMv.stale` onto the run row.

Degradation is deliberately toward "stale": an absent row, an unavailable delegate, or a failed read
all become `stale: true` (`:1213-1216`). `mvFreshnessRow` guards on the *delegate existing* because
several unit specs build a partial Prisma stub and a missing delegate is a `TypeError`, not a
rejected promise (`:1294-1302`).

**Frontend-relevant:** `config_snapshot.eligibilityMv` is the only place a UI can say "this run's
floating pool may have been out of date." There is **no live freshness endpoint** for the scheduler
UI — `PlantEligibleFloatingSeService.freshness()` exists but `NOT FOUND IN CODEBASE` as an exposed
route on any scheduler controller.

### 11.4 The coverage floor for SEs (not dispatch)

`shared-pool/se-coverage.service.ts` — `coveredPlantIds(seId)` = `se_coverage` ∪ floating MV. Used by
the Shared Pool read, the troubleshoot-submit row-scoping floor (#162), and the merged SE ticket read
(#161). **Not** used by dispatch — the engine asks the inverse question (plant → engineers).

---

## 12. Hard Filters

`recommender/hard-filters.ts` — pure, 118 lines. **Five filters, tri-state, first-FAILED wins.**

### 12.1 The order — evaluation order IS drop precedence

```ts
export const HARD_FILTER_ORDER: readonly HardFilterReason[] = [
  'VEHICLE_ON_TRIP',
  'SE_UNAVAILABLE',
  'OVER_CAPACITY',
  'COMMON_KIT_INCOMPLETE',
  'COMPONENT_UNAVAILABLE',
];                                                                  hard-filters.ts:48-54
```

`firstFailure` (`:100-105`) returns the first `FAILED` and skips `NOT_ENFORCED` exactly like a
`PASSED`. `applyHardFilters` (`:107-118`) partitions into `passed` / `dropped[{candidate, reason}]`,
**preserving input order in both halves** — which is what makes tier precedence a scan rather than a
sort downstream.

### 12.2 Each filter, in full

#### F1 `VEHICLE_ON_TRIP` — `PARTIALLY_IMPLEMENTED` (logic real, feed absent)

```
Source fn      evaluateFilter case 'VEHICLE_ON_TRIP'          hard-filters.ts:66-68
Inputs         c.vehicleReadinessEnforced, c.vehicleReadiness
Condition      !enforced           → NOT_ENFORCED
               readiness==='ON_TRIP' → FAILED
               otherwise           → PASSED
Rejection      candidate excluded from `passed`; dropCounts.VEHICLE_ON_TRIP++
Verdict written 'DROPPED' on the runner-up trace entry, dropReason 'VEHICLE_ON_TRIP'
NOT_ENFORCED?  YES — today, always. buildCandidateReadiness hardcodes
               vehicleReadiness:'UNKNOWN', vehicleReadinessEnforced:false
                                                              candidate-readiness.ts:54-55
Frontend sees  the filter listed in `notEnforcedFilters` and as state NOT_ENFORCED in
               every `filterStates` array. It MUST NOT be rendered as a pass.
Note           STALE / UNKNOWN are deliberately NOT drops — "a ZM conflict signal surfaced
               elsewhere" (hard-filters.ts:6-7). Pinned: test/hard-filters.spec.ts:52-54.
Blocked on     Issue 28 (vehicle-readiness feed). Flipping `false`→`true` at
               candidate-readiness.ts:55 is the entire seam — hard-filters.ts already
               evaluates real data correctly (test/hard-filters.spec.ts:85-93).
```

#### F2 `SE_UNAVAILABLE` — `IMPLEMENTED`

```
Source fn      evaluateFilter case 'SE_UNAVAILABLE'           hard-filters.ts:69-70
Input          c.available
Built as       (capacity?.isActive ?? true) && availabilityStatus === 'AVAILABLE'
                                                              candidate-readiness.ts:56
Feed           SeAvailabilityService.currentStatusMany(seIds, asOf) — one batched query,
               memoised per run (recommender.service.ts:1013-1018).
               Window predicate: windowStart <= now AND (windowEnd IS NULL OR windowEnd > now),
               ORDER BY windowStart DESC, first wins.
Condition      available ? PASSED : FAILED
NOT_ENFORCED?  never
Two causes     an active non-AVAILABLE window, OR engineer_master.is_active = false.
               ⚠ The trace cannot tell them apart — both produce `SE_UNAVAILABLE`.
```

#### F3 `OVER_CAPACITY` — `IMPLEMENTED`

```
Source fn      evaluateFilter case 'OVER_CAPACITY'            hard-filters.ts:71-72
Input          c.overCapacity
Built as       capacity !== undefined && committed >= capacity.dailyCapacity
                                                              candidate-readiness.ts:59
Boundary       `>=`, NOT `>`. An SE at exactly 6/6 is one no automatic path will add to,
               "so the badge and the filter agree at the boundary rather than one step apart."
Missing master `capacity === undefined` (an SE reachable via se_coverage with no
               engineer_master row) is deliberately NOT over-capacity — "an engineer must
               never be filtered out by a missing master-data field" (candidate-readiness.ts:9-12)
Counter        the RUN's in-memory `assigned` map, seeded from committedDayPlan and
               incremented on every win (recommender.service.ts:813)
NOT_ENFORCED?  never
IMPORTANT      This is the ONLY hard capacity gate, and it applies ONLY to automatic paths.
               Manual paths never consult it — see §17.4.
```

#### F4 `COMMON_KIT_INCOMPLETE` — `IMPLEMENTED` (with a seam-default)

```
Source fn      evaluateFilter case 'COMMON_KIT_INCOMPLETE'    hard-filters.ts:73-74
Input          c.commonKitComplete
Feed           InventoryService.commonKitStatus(seId), memoised per run
                                                              inventory.service.ts:51-67
Logic          kit = common_kit_definitions WHERE active, joined to component_master
               if kit.length === 0                       → complete (nothing defined)
               if se_van_stock count for this SE === 0   → complete  ◄── SEAM DEFAULT
                  "inventory not yet tracked — don't ground them on a data gap"
               else missing = kit items where have < minQty
Condition      complete ? PASSED : FAILED
Side effect    a kit drop that leaves the pool empty writes a ComponentBlockedQueue row
               with the missing parts (recommender.service.ts:736-740) — suppressed on dry runs
NOT_ENFORCED?  never (it reports PASSED under the seam default)
⚠ Consequence  An SE with zero van-stock rows always passes. The trace shows PASSED, which is
               truthful about the rule but not about the stock. `IMPLEMENTED_DIFFERENTLY`
               relative to a naive reading of "kit complete".
Intraday       The CRITICAL sweep passes commonKitComplete: true unconditionally
               (intraday-insertion.service.ts:255-259) — "the intraday path has never
               consulted van stock". A documented scope difference, not a bug.
```

#### F5 `COMPONENT_UNAVAILABLE` — `PARTIALLY_IMPLEMENTED` (logic real, feed absent)

```
Source fn      evaluateFilter case 'COMPONENT_UNAVAILABLE'    hard-filters.ts:75-77
Inputs         c.componentAvailabilityEnforced, c.expectedComponentsAvailable
Condition      !enforced → NOT_ENFORCED; else available ? PASSED : FAILED
NOT_ENFORCED?  YES — always today. candidate-readiness.ts:61-62 hardcodes
               expectedComponentsAvailable:true, componentAvailabilityEnforced:false
Blocked on     Issue 22 (`expected_components`)
```

### 12.3 The filter that was deliberately removed — `IMPLEMENTED_DIFFERENTLY`

**SE activity-ping staleness is NOT a hard filter, and this is load-bearing.**

`hard-filters.ts:9-13`: *"`last_activity_at` is visibility/audit only and never removes a candidate
(CONTEXT.md Decisions §3 & §16, revised 2026-06-09 — **supersedes the ADR-0016/0024 '15-min intra-day
heartbeat filter'**). An SE working offline or in a no-network field area must stay a candidate."*

Pinned negatively by `test/hard-filters.spec.ts:57-66` — asserts no reason is ever
`HEARTBEAT_STALE`.

⚠ **A real consequence, self-documented.** The retired filter pointed at "Acceptance Timeout +
reroute (Issue 29/30)" as the recovery path for intra-day unreachability — and **#268 deleted that
machinery**. `stranded-work-escalation.service.ts:31-34` states: *"the documented recovery path for
intra-day unreachability had no implementation at all, and no replacement was filed. This is the
replacement."* The replacement is **escalate-only** (§36.4): nothing is reassigned automatically.

### 12.4 The tri-state honesty contract `FRONTEND_RELEVANT`

`type FilterState = 'PASSED' | 'FAILED' | 'NOT_ENFORCED'` (`hard-filters.ts:45`).

- `evaluateAllFilters(c)` → `{ filter, state }[]` in evaluation order — the shape the trace and the
  admin drawer render (`:83-87`).
- `notEnforcedFilters(c)` → the subset currently `NOT_ENFORCED` (`:92-96`).

Both are persisted per trace row:
- trace-level `notEnforcedFilters` — computed once from `readiness[0]` (identical for every candidate
  today, since both stubbed feeds are global) or `[]` for an empty pool
  (`recommender.service.ts:638`);
- per-candidate `filterStates` — on the chosen row **and** every runner-up
  (`recommender.service.ts:727, 903, 924`).

**The UI contract, stated in code:** *"the UI/trace must never render the latter as a pass"*
(`hard-filters.ts:41-43`). Pinned by `test/hard-filters.spec.ts:108-115` — today's production feed
never reports `PASSED` for either stubbed filter.

**Note:** `NOT_ENFORCED` does **not** appear in `CandidateQueryService`'s output. That surface emits
only `PASSED` / `DROPPED` (`candidate-query.service.ts:27`) plus the raw
`availabilityStatus`/`kitComplete` fields. `TIER_NOT_REACHED` is also absent there, deliberately
(`:79-83`): "a human may cross tiers deliberately, so a never-reached tier would be a rejection the
operator's own decision has not yet made." **Frontend gap → §39.**
---

## 13. Ticket Ranking / Canonical Sort

`recommender/canonical-sort.ts` — pure, deterministic, **the only thing that orders the dispatch
path**.

### 13.1 The comparator, key by key

`compareCandidates(a, b)` — `canonical-sort.ts:83-116`.

| # | Key | Direction | Source field | Transformation | Why | Example |
|---|---|---|---|---|---|---|
| 1 | Company Tier | **desc** | `companyTier` (override-resolved) | `tierRank` = index in `['SILVER','GOLD','PLATINUM']`; higher index = higher priority | contract value | PLATINUM before GOLD before SILVER |
| 2 | Device Bucket | **desc** | `deviceBucket` | `bucketRank` = index in `BUCKET_ORDER` (8 members, `WARNING`→`LONG_PENDING`) | outage severity | `LONG_PENDING`(7) before `CRITICAL`(3) |
| 2b | **Return Due Today** | true first | `returnDueToday` | boolean | vehicle is back — work it now | only decides between two **sub-CRITICAL** tickets |
| 3 | Company Priority Rank | **asc** | `companyPriorityRank` | string compare | contractual tie-break | `'A' < 'B' < 'C'` |
| 4 | Oldest Inactive | **asc** | `latestGpsDatetime` | `inactiveKey` — `null → +Infinity` | longest-silent first | 08:00 before 12:00; a null-GPS device sorts **last** |
| 5 | Device ID | **asc** | `deviceId` | string compare | absolute determinism | `'3' < '7'` |

The `TIER_ORDER` array (`:49`) is **stored reversed** (`SILVER` first) so `indexOf` yields the
priority rank directly. `TIER_ORDER_EFFECTIVE_PRIORITY_DESC` (`:66`) is **derived** from it, not
hand-duplicated, "so a drift between the two encodings is a real test failure, not two copies of the
same literal." `tiers.rank` in the database encodes the same order right-side-up
(`schema.prisma:47-52`).

### 13.2 Key 2b — the return-date gate, and why it is placed exactly there

`canonical-sort.ts:100-105`:

```ts
if (!isCriticalPlus(a.deviceBucket) && !isCriticalPlus(b.deviceBucket)) {
  const aDue = a.returnDueToday === true;
  const bDue = b.returnDueToday === true;
  if (aDue !== bDue) return aDue ? -1 : 1;
}
```

**The gate is two-sided even though step 2 makes one side redundant** — "it states the invariant the
placement relies on instead of depending on it" (`:98-99`). Because step 2 returns whenever buckets
differ, in practice this only decides between tickets sharing a sub-CRITICAL bucket, where it
**outranks Company Priority Rank**.

**Why the alternative was rejected** (`:93-95`): promoting `sla_bucket` for a returning vehicle would
corrupt Fleet Uptime, the Soft Inactive Count zones are graded on, SLA reporting, and the decision
traces — all of which read that column.

Order of business: **Critical/Severe → return-date → normal backlog**. Pinned by
`test/recommender-return-date-priority.e2e-spec.ts`.

### 13.3 Urgency derivation — shared with the intraday path

```ts
export function urgencyFromBucket(b: DeviceBucket): number {
  return bucketRank(b) / (BUCKET_ORDER.length - 1);          // 0 … 1
}                                                             canonical-sort.ts:77-79
```

| Bucket | rank | urgency |
|---|:--:|---|
| `WARNING` | 0 | 0.000 |
| `EARLY_RISK` | 1 | 0.143 |
| `RISK` | 2 | 0.286 |
| `CRITICAL` | 3 | 0.429 |
| `HIGH_CRITICAL` | 4 | 0.571 |
| `SEVERE` | 5 | 0.714 |
| `VERY_SEVERE` | 6 | 0.857 |
| `LONG_PENDING` | 7 | 1.000 |
| *(install — no bucket)* | — | **0** (`recommender.service.ts:558`) |

Derived from `BUCKET_ORDER` rather than a second literal array, for the same reason as the tier
order: "a drift between two copies of 'bucket severity order' would be silent everywhere except a
score."

### 13.4 Install sort — a separate, shorter comparator

`compareInstallCandidates` (`:139-147`): tier desc → priority rank asc → oldest `backlogAnchor` →
`ticketId` asc. `anchorKey` mirrors `inactiveKey` (null → `+Infinity` → sorts last).

Installs are appended **after** all TROUBLESHOOT candidates and only in PREVENTIVE mode
(`recommender.service.ts:486-489`): "installs fill remaining SE capacity."

### 13.5 Sort verification `TESTS ARE EVIDENCE`

`test/canonical-sort.spec.ts:26-35` pins a 6-ticket shuffled fixture to the exact order
`['C','E','F','B','A','D']`, exercising every tie-break level, and asserts the input array is not
mutated.

---

## 14. Candidate Tier Selection

`recommender/tier-score-chooser.ts:55-73` — 19 lines of logic, three steps.

```ts
const winningTier    = passed[0]?.coverageType ?? null;                          // step 1
const tierCandidates = passed.filter(c => c.coverageType === winningTier);
const tierScores     = new Map(tierCandidates.map(c => [c.seId, scoreFor(c)]));  // step 2

const pinned = pinnedSeIds ? passed.find(c => pinnedSeIds.has(c.seId)) : undefined;
const chosen = pinned                                                            // step 3
  ?? [...tierCandidates].sort((a, b) => {
       const byScore = (tierScores.get(b.seId) ?? 0) - (tierScores.get(a.seId) ?? 0);
       return byScore !== 0 ? byScore : a.seId.localeCompare(b.seId);
     })[0]
  ?? null;
```

**Step 1 is a scan, not a sort**, because `passed` is already in coverage-precedence order (the
partition in `applyHardFilters` preserves input order, and
`orderedCandidatesForPlant` returns `[...dedicated, ...multi, ...floating]`). A lower tier is reached
only when every higher-tier candidate was filtered out.

**`scoreFor` is called only for `tierCandidates`.** Candidates in lower tiers are *never scored* —
this is what produces the third verdict, `TIER_NOT_REACHED` (§14.2).

**Returns:** `{ chosen, winningTier, tierCandidates, tierScores }`. `winningTier` is persisted as
`trace.chosen.tierEvaluated`.

### 14.1 Precedence vs. score — the ruling

`tier-score-chooser.ts:46-48`: *"A FLOATING SE can therefore never out-score an eligible DEDICATED
one: the score is only ever consulted within one tier."*

`recommender.service.ts:655-661` records the operator ruling on the pin's exception in full:

> "The pin is searched across ALL passing candidates, not just the winning tier, and that is a
> deliberate operator ruling rather than an oversight. ADR-0022's bias has crossed tiers since Issue
> 14a — `recommender-planner-bias.e2e-spec.ts` pins a planner-named MULTI_PLANT SE beating an eligible
> DEDICATED one — and restricting it to the winning tier would silently retire that, overriding a
> manager's explicit choice with an SE they did not name and giving them no signal their pin was
> discarded. So Q1's 'precedence is inviolable' binds the SCORE, which is all this issue needed: a
> higher score can never cross a tier, while a human's pin still can."

Pinned by `test/recommender-score-selection.e2e-spec.ts:215-226` — a FLOATING SE already holding the
plant (i.e. carrying the cluster bonus) still loses to a DEDICATED one.

### 14.2 The three verdicts `FRONTEND_RELEVANT`

`recommender.service.ts:917-921` — the runner-up verdict expression:

```ts
verdict: !passedSet.has(c.seId) ? 'DROPPED'
       : tierScores.has(c.seId) ? 'PASSED'
       :                          'TIER_NOT_REACHED'
```

| Verdict | Means | Has a `score`? | Has a `dropReason`? |
|---|---|:--:|:--:|
| `DROPPED` | a hard filter rejected it | no (`null`) | yes |
| `PASSED` | eligible, in the winning tier, scored, lost on merit | **yes** | no |
| `TIER_NOT_REACHED` | eligible, but in a tier below the winning one — **never scored** | no (`null`) | no |

`recommender.service.ts:913-916` explains why three and not two: *"Calling that PASSED-with-a-score
said it had been weighed and lost on merit; calling it DROPPED would say a filter rejected it.
Neither happened, so it gets the verdict that describes what did."*

⚠ **`TIER_NOT_REACHED` exists only in the dispatch trace.** `CandidateQueryService` deliberately does
not emit it (`candidate-query.service.ts:79-83`).

### 14.3 Tier data freshness summary

| Leg | Table/view | Cached? | Refreshed | Stale-handling |
|---|---|---|---|---|
| DEDICATED | `se_coverage` | no | live | — |
| MULTI_PLANT | `se_coverage` | no | live | — |
| FLOATING | `plant_eligible_floating_se` MV ⋈ `engineer_master` | MV is the cache | 04:30 IST cron + on territory edits | joined live against `engineer_master`; staleness recorded, run proceeds |

Within a run, **kit status and availability are memoised per SE** (`recommender.service.ts:514-515,
1007-1018`); **capacity, home bases, plant coords, weights, cluster multiplier and planner pins are
read once per zone-run** (`:491-521`). `orderedCandidatesForPlant` is **not** memoised — it re-runs
per ticket.

---

## 15. Scoring Engine

`recommender/scoring.ts` — 155 lines, pure.

### 15.1 The actual formula

```ts
baseScore =   wRank        * rankScore(companyPriorityRank)
            + wUrgency     * dispatchUrgency
            − wRepeat      * repeatPenalty
            + wRepeatBonus * repeatPenalty
            + wAge         * ageScore(inactivityHours)
            + wDistance    * distanceScore(distanceFromPrevStopKm)

score     = Math.max(baseScore, 0) * clusterMultiplier
```
`scoring.ts:126-142`.

**The floor is on the base, before the multiplier, and is an operator ruling** (`:135-141`):

> "`baseScore` can reach zero or go negative: with the seeded DEFICIT weights an install-backlog
> ticket has `dispatchUrgency` 0 by design, so a repeat-failure ticket for a company at rank F scores
> exactly 0 (the bonus is a no-op) and at rank G or below scores negative — where a 1.25× 'bonus'
> would make the SE already going to that plant score WORSE than one who has never been.
> `company_priority_rank` is a free String column, not an enum, so those letters are reachable."

The breakdown still carries the **true, unfloored** `baseScore`, so nothing is hidden.

### 15.2 Component catalogue

| Name | Meaning | Formula | Input | DB source | Weight key | Range | Default weight | Missing-data behaviour | Where calculated | Persisted | Exposed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `rankScore` | contractual priority letter | `max(0, 1 − 0.1×(charCode−'A'))` | `companyPriorityRank` | `company_master.company_priority_rank` | `company_priority_rank` | 0…1 | **0.4** | non-alpha / `<'A'` → **0** | `scoring.ts:89-93` | `scoreBreakdown.rankScore` | trace, batch row |
| `urgency` | outage severity | `bucketRank/7` | `deviceBucket` | `device_states.sla_bucket` | `dispatch_urgency` | 0…1 | **0.3** | no bucket (install) → **0** | `canonical-sort.ts:77` | `scoreBreakdown.urgency` | trace |
| `repeatPenalty` | prior failure on this device | `repeatFailure ? 1 : 0` | `tickets.repeat_failure` | ↑ | `repeat_failure_penalty` | 0 or 1 | **0.2** | false → 0 | `scoring.ts:114` | `scoreBreakdown.repeatPenalty` | trace |
| `repeatBonus` | PREVENTIVE inversion — same input, opposite sign | same `repeatPenalty` value | ↑ | ↑ | `repeat_failure_bonus` | 0 or 1 | **0** in DEFICIT, **0.5** in PREVENTIVE code-default | — | `scoring.ts:130` | via `weights` | trace |
| `ageScore` | aged-device bias | `min(1, max(0,hours)/168)` | `inactivityHours` | derived from `device_states.latest_gps_datetime` | `device_age` | 0…1 | **0** in DEFICIT, **0.5** in PREVENTIVE code-default | `null`/`NaN` → **0** | `scoring.ts:102-105` | `scoreBreakdown.ageScore` | trace |
| `distanceScore` | route proximity | `1/(1 + max(0,km))` | `distanceFromPrevStopKm` | `plants.location` + `engineer_master.home_lat/lng` | `distance` | (0…1] | **0.1** | `null` → **0** (neutral, never a penalty) | `scoring.ts:96-99` | `scoreBreakdown.distanceScore` + `.distanceKm` | trace |
| `clusterMultiplier` | already going to this plant today | ×1.25 or ×1.0 | per-candidate plant set | `system_settings.plant_cluster_multiplier` | *(not a weight)* | >0 | **1.25** | invalid/≤0 → 1.25 | `recommender.service.ts:646` | `scoreBreakdown.clusterMultiplier` | trace |

**`AGE_CAP_HOURS = 168`** (7 days), `scoring.ts:58`.

### 15.3 The closed component vocabulary — `IMPLEMENTED`

```ts
export const SCORING_COMPONENTS = [
  'company_priority_rank', 'dispatch_urgency', 'repeat_failure_penalty',
  'distance', 'repeat_failure_bonus', 'device_age',
] as const;                                                          scoring.ts:74-81
```

`scoring.ts:60-72` records why the set was closed: `priority_rule_config` accepted any component
string, the admin form's Component field is free text, and `activeWeights` loads whatever is active —
"so a weight named anything at all would appear in the settings table beside the real ones and ride
along in every persisted `score_breakdown.weights`, contributing nothing. **Three had been seeded
that way since Issue 02** (`company_tier`, `device_bucket`, `sla_urgency`) **and were read by
nothing.**" Retired by migration `20260821120000_retire_dead_scoring_weights`, dropped from the seed
(`org-seed.ts:71-77`), and now validated by the admin API against `isScoringComponent`.

**Frontend-relevant:** `GET /api/org/scoring-weights/components` serves the list, "so the picker and
the validation that rejects a bad component cannot drift" (`scoring-weights.controller.ts:21-27`).

### 15.4 Seeded DEFICIT weight set `v1`

`org-seed.ts:67-83`:

| Component | Weight |
|---|---|
| `company_priority_rank` | **0.4** |
| `dispatch_urgency` | **0.3** |
| `repeat_failure_penalty` | **0.2** |
| `distance` | **0.1** |
| `repeat_failure_bonus` | *(absent → 0)* |
| `device_age` | *(absent → 0)* |

Weight set ref `v1` (`DEFAULT_WEIGHT_SET`, `scoring-config.ts:8`).

### 15.5 Weight-set resolution

`readBaseActiveWeights` — `scoring-config.ts:25-37`:

```ts
const active = await prisma.priorityRuleConfig.findMany({ where:{active:true}, orderBy:{id:'asc'} });
const baseRef =
     active.find(r => r.component === 'company_priority_rank' && !r.weightSetRef.endsWith('_preventive'))?.weightSetRef
  ?? active.find(r => !r.weightSetRef.endsWith('_preventive'))?.weightSetRef
  ?? 'v1';
for (const r of active) if (r.weightSetRef === baseRef) weights[r.component] = Number(r.weight);
```

The anchor is `company_priority_rank` because it is the component most likely to exist in any real
set. `Number(r.weight)` converts a Prisma `Decimal(10,4)`.

`RecommenderService.activeWeights` (`:1138-1155`) layers the PREVENTIVE branch on top:

```
mode !== 'PREVENTIVE'  → { baseWeights, baseRef }
otherwise:
  preventiveRef = `${baseRef}_preventive`
  if a configured active set with that ref exists → use it
  else → CODE DEFAULT: { ...baseWeights,
                         repeat_failure_penalty: 0,
                         repeat_failure_bonus:   0.5,   // PREVENTIVE_REPEAT_BONUS
                         device_age:             0.5 }  // PREVENTIVE_AGE_WEIGHT
```
`recommender.service.ts:50-54, 1148-1153`. **The base/DEFICIT set is never mutated**, so DEFICIT
scoring is byte-identical.

**The intraday CRITICAL sweep deliberately uses `readBaseActiveWeights` only** — never PREVENTIVE
(`scoring-config.ts:17-23`): the repeat-failure-bonus/aged-device bias "exists to redirect attention
toward backlog when a zone is *healthy* and would be a live contradiction on an active emergency
ticket. This is a scope decision #268's own text does not make, so it is recorded here rather than
silently inherited."

### 15.6 Mode selection — DEFICIT vs PREVENTIVE

`SoftInactiveCountService.modeForZone` — `reports/soft-inactive-count.service.ts`:

```sql
SELECT COUNT(*) FILTER (WHERE ds.is_inactive AND ds.eligible_for_uptime) AS "softInactive",
       COUNT(*) FILTER (WHERE ds.eligible_for_uptime)                    AS "eligible"
  FROM device_states ds JOIN plants p ON p.plant_id = ds.plant_id
 WHERE p.zone_id = $1
```
```ts
isDeficit = softInactive > thresholdPct * eligible          // thresholdPct default 0.02 (2%)
mode      = isDeficit ? 'DEFICIT' : 'PREVENTIVE'
```

⚠ **`IMPLEMENTED_DIFFERENTLY` — the `now` argument is ignored.** The recommender threads `asOf` into
`modeForZone` "for intent", and notes honestly at `recommender.service.ts:313-316` that the parameter
is `_now` and the count is read from **materialised** `device_states`. The mode is therefore
as-of-last-recompute, exactly as the buckets are. `bucketsAsOf` is the caveat covering both.

⚠ **`AMBIGUOUS` — no deactivated-plant filter.** `modeForZone` joins `plants` without excluding
deactivated ones. `operatingModes` (the legibility read, `:96-104`) deliberately mirrors this: "a
legibility surface must show the real signal, not a prettier variant."

⚠ **The default is PREVENTIVE.** A zone with `eligible = 0` yields `0 > 0` = false → PREVENTIVE. A
brand-new or empty zone therefore runs the Install backlog.

**Never render the enum.** `soft-inactive-count.service.ts:11-13`: *"The `mode` enum must never be
rendered to a user; the admin FE maps it to plain language ('Catch-up'/'Steady') in one util."*

### 15.7 Per-candidate vs per-ticket features — the structural fact

`recommender.service.ts:545-564`:

```ts
const featuresFor = (c: RunCandidate, seId: string) => ({
  companyPriorityRank:     c.companyPriorityRank,        // TICKET
  dispatchUrgency:         c.deviceBucket ? urgencyFromBucket(c.deviceBucket) : 0,   // TICKET
  repeatFailure:           c.repeatFailure,              // TICKET
  inactivityHours:         c.ageAnchor ? max(0,(now−anchor)/3.6e6) : null,           // TICKET
  distanceFromPrevStopKm:  distanceKmFor(seId, String(c.plantId)),   // ◄── PER CANDIDATE
});
```

> "Every field but `distanceFromPrevStopKm` comes from the TICKET, which is the structural fact
> behind #258 Q-A: candidates for one ticket share an identical `baseScore`, so without a
> per-candidate term the score cannot order them at all."

**So there are exactly two per-candidate terms:** `distanceFromPrevStopKm` (#267) and the
`clusterMultiplier` (#266 Q-A). Everything else is constant across the tier, and `se_id` ascending
breaks the remaining tie.

### 15.8 Distance — full derivation `IMPLEMENTED`

**Read once per zone-run** (never per ticket/candidate — the AC this guards,
`recommender.service.ts:517-521`):

```ts
const plantCoords = await plantCoordinatesForZone(prisma, zoneId);   // ST_Y/ST_X, NULL rows absent
const homeBases   = await this.engineerHomeBases();                  // NULL coords absent
```

```sql
SELECT plant_id, ST_Y(location) AS lat, ST_X(location) AS lng
  FROM plants WHERE zone_id = $1 AND location IS NOT NULL
```
`plant-geometry.ts:23-28`.

**Route position, seeded lazily and advanced on wins** (`:526-543`, `:820-825`):

```
currentPosFor(seId):
   seed = plantCoords[lastStopPlantId]      // their last live stop today
       || homeBases[seId]                   // else home base
       || null                              // else NOT_AVAILABLE

distanceKmFor(seId, plantId):
   pos = currentPosFor(seId); dest = plantCoords[plantId]
   if (pos === null || dest === undefined) return null      // ◄── never (0,0)
   return haversineKm(pos, dest)

on a win:  if (plantCoords[wonPlant]) currentPos.set(seId, wonCoord)
           // only advances with REAL geometry — a plant with no location leaves the SE where
           // they were, "honest rather than pretending the SE moved to an unknown point"
```

**Haversine** (`distance.ts:22-30`), `EARTH_RADIUS_KM = 6371`, `asin(min(1, sqrt(h)))`.
"Deliberately simple — adequate for comparing candidates against each other, not routing."

**Null-honesty** (`:535-537`): *"missing position AND/OR missing destination geometry both mean
'cannot be computed' — never a fabricated `(0,0)`, which is a real point in the Gulf of Guinea and
would hand every such candidate a spectacular fake distance."*

Persisted as `scoreBreakdown.distanceKm: number | "NOT_AVAILABLE"` (`distance.ts:12-13`,
`scoring.ts:149`). **The UI must render the sentinel, not 0.**

The intraday CRITICAL sweep wires distance identically (`intraday-insertion.service.ts:218-237`).

### 15.9 Cluster multiplier — the Q-A correction `IMPLEMENTED`

```ts
const clusterFor = (seId: string): number =>
  plantsBySe.get(seId)?.has(ticketPlant) ? clusterMultiplier : 1;    recommender.service.ts:646-647
```

`recommender.service.ts:642-645` records what it used to be and why that was broken:

> "The multiplier is per candidate, and means what its name says: does THIS engineer already go to
> this plant today? (The old test asked whether ANY SE had been seeded at the plant this run — one
> value applied to every candidate, so it cancelled out of every comparison and could decide
> nothing.)"

`plantsBySe` is seeded from `committedDayPlan(targetDay).plants` and **grown in-run** on every win
(`:504-512`, `:817-819`), mirroring the capacity counter one line above, "so 'how much is this
engineer carrying' and 'where are they already going' can never drift apart."

`clusterSeed` = `multiplier === 1` — i.e. **this decision was NOT a cluster follow-on for the
winner** (`:668-671`).

Pinned: `test/recommender-score-selection.e2e-spec.ts:197-211` — the SE already holding a stop at the
plant beats the lower `se_id`; a multiplier of 1.0 hands it back to the `se_id` winner.

### 15.10 `scoreDegenerate` — derived from the spread `IMPLEMENTED`

```ts
const tierScoreValues = [...tierScores.values()];
const scoreDegenerate =
  tierScoreValues.length < 2 ||
  Math.max(...tierScoreValues) - Math.min(...tierScoreValues) < 1e-9;    recommender.service.ts:863-866
```

`:855-862` records the correction: it used to read
`distanceFromPrevStopKm === null || weights.distance === 0`, "on the reasoning that distance was the
only per-SE component, so everything tied and precedence decided. Q-A broke that without touching the
expression: the cluster multiplier is per candidate, so two candidates in the winning tier genuinely
differ and the score genuinely decides — while the old flag still announced that precedence had. That
is worse than a stale field, because an operator reading 'precedence decided' goes looking for a
coverage explanation that does not exist."

**Frontend meaning:** `scoreDegenerate: true` ⇒ **hide the numeric scores and explain in precedence
terms**. It is surfaced on the batch assignment row so the table can decide without a per-ticket
trace fetch (`dispatch-transparency-query.service.ts:188-193`). `null` for pre-ledger rows with no
trace.

### 15.11 Scoring verification `TESTS ARE EVIDENCE`

`test/scoring.spec.ts` (55 lines) asserts, with `W = {rank:1, urgency:1, repeat:1, distance:1}`:
- higher rank letter scores higher (`:29-31`)
- score increases with urgency, decreases with repeat-failure (`:33-36`)
- nearer previous stop scores higher; `null` distance yields `distanceScore === 0` exactly (`:38-45`)
- `score === baseScore × 1.5` to 6 dp with multiplier 1.5 (`:47-52`)
- zero weight removes a component's effect entirely (`:54-57`)

---

## 16. KPI and Metrics Catalog

**Every figure the Scheduler Engine calculates or exposes.** Verified to exist in code. Figures that
merely sound like KPIs but have no implementation are listed in §16.5 as `EXPECTED_BUT_NOT_FOUND`.

### 16.1 Run-level (persisted on `dispatch_runs`)

| KPI | Business meaning | Formula | Source | Calculated by | Persisted | API | Frontend location | Refresh |
|---|---|---|---|---|---|---|---|---|
| `zones` | zones this run **processed** (contended excluded) | `summary.zones++` per successful `processZone` | — | `processZone:1088` | ✓ `dispatch_runs.zones` | run list + detail | Runs list | on finalize |
| `schedules` | work schedules created **or appended to** | Σ `out.schedules` | `dispatchForSe` | `:1104` | ✓ | ✓ | Runs list | on finalize |
| `batches` | plant stops created | Σ `out.batches` | ↑ | `:1106` | ✓ | ✓ | Runs list | on finalize |
| `ticketsDispatched` | tickets placed on a day plan | Σ `out.tickets` | ↑ | `:1105` | ✓ | ✓ | Runs list, "Dispatched" | on finalize |
| `recommended` | tickets the engine placed with an SE | Σ `rec.recommended` | recommender | `:1107` | ✓ | ✓ | Runs list | on finalize |
| `unassignable` | tickets with **no eligible SE** | Σ `rec.unassignable` | ↑ | `:1108` | ✓ | ✓ | Runs list | on finalize |
| `withheldBelowThreshold` | held back by the SE-assignment threshold | Σ | ↑ | `:1109` | ✓ | ✓ | zone card | on finalize |
| `bucketlessDropped` | **nullable** — dropped, unrankable | Σ (null-preserving) | ↑ | `:1110` | ✓ | ✓ | zone card | on finalize |
| `componentBlockedWithheld` | **nullable** — part on order | Σ (null-preserving) | ↑ | `:1111` | ✓ | ✓ | zone card | on finalize |
| `status` | run outcome | §7.3 expression | — | `execute:922` | ✓ | ✓ | Runs list badge | on finalize |
| `durationMs` | **calculated at read time** | `finishedAt − startedAt`, `null` while running | — | `dispatch-transparency-query.service.ts:333` | ✗ | ✓ | Runs list | per request |
| `errorCount` | **calculated at read time** | `zoneRows.filter(z => z.error !== null).length` | — | `:345` | ✗ | ✓ | Runs list | per request |
| `build.staleBuild` | ran under an older build than current | `buildVersion < runtime_lock.version` | `runtime_lock` | `:459-476` | partly | ✓ | run-detail badge | per request |

### 16.2 Zone-level (persisted on `dispatch_run_zones`)

| KPI | Meaning | Formula | Calculated by | API field |
|---|---|---|---|---|
| `ticketsConsidered` | tickets that **entered the loop** (canonical-sorted TS + PREVENTIVE installs) | `runList.length` | `recommender.service.ts:970` | `ticketsConsidered` |
| `recommended` / `unassignable` | per zone | loop counters `:826`, `:760` | ↑ | ✓ |
| `unassignableReasons.NO_COVERAGE` | pool was empty — **Ops coverage gap** | `ordered.length === 0` | `:701` | ✓ |
| `unassignableReasons.ALL_DROPPED` | candidates existed; filters emptied the pool | else branch | `:701` | ✓ |
| `unassignableReasons.dropBuckets[reason]` | per-filter drop counts across unassignable tickets only | accumulated `:703-704` | ↑ | ✓ |
| `withheldBelowThreshold` | separate `ticket.count` with the age gate **inverted** | `:402-412` | ↑ | ✓ |
| `componentBlockedWithheld` | separate `ticket.count`, cycle predicate flipped | `:421-431` | ↑ | ✓ |
| `bucketlessDropped` | `tickets.length − rankable.length` | `:439` | ↑ | ✓ |
| `assignmentThresholdHours` | the threshold **in force for this zone** | read per run | `:324` | ✓ |
| `mode` | `DEFICIT` \| `PREVENTIVE` | Soft Inactive Count | `soft-inactive-count.service.ts` | ✓ |
| `weightSetRef` | the weight set that applied | `activeWeights` | `:1138` | ✓ |
| `schedules`/`batches`/`ticketsDispatched` | commit outcome | `DispatchSummary` | `batch-assignment.service.ts` | ✓ |
| `outcome` (`status`) | `RUNNING`\|`DONE`\|`ERROR`\|`CONTENDED` | claim lifecycle | `:1141` | ✓ |
| `contendedWithRunId` | who held the zone | `claimantsOf` | `:409` | ✓ |
| `seSkips[]` | per-engineer failures, contained | `describeSeSkip` | `se-skip.ts:291` | ✓ |
| `ticketsStillAssigned` | **live counter, read-time** | run's batch tickets with `removed_at IS NULL` | `dispatch-transparency-query.service.ts:437-453` | ✓ |
| `ticketsRemovedSince` | **live counter, read-time** | same rows with `removed_at NOT NULL` | ↑ | ✓ |

**`ticketsRemovedSince` deliberately does not attribute a cause** (`:76-79`): "bulk unassign,
REMOVE_TICKET and DEFER_TICKET all stamp the same column, and guessing between them from timestamps
would be fiction." Both are 0 for a run whose batches carry no `run_id`.

### 16.3 Per-ticket decision metrics (in `dispatch_decision_traces.trace` JSONB)

| Metric | Meaning | Where |
|---|---|---|
| `candidatesTotal` | size of the ordered pool **before** filters | `:838`, `:877` |
| `passedCount` | survivors of the hard filters | `:839`, `:878` |
| `dropCounts{reason: n}` | per-filter counts across the whole pool | `:674-675` |
| `notEnforcedFilters[]` | filters with no real feed | `:638` |
| `poolEmptyReason` | `NO_COVERAGE` \| `ALL_DROPPED` \| `null` | `:701` |
| `scoreDegenerate` | did the score actually decide? | `:864` |
| `chosen.precedenceRank` | 1-based index in the ordered pool | `:867` |
| `chosen.tierEvaluated` | the winning tier | `chooseWithinTier` |
| `chosen.score` + `.breakdown` | the winner's number and its parts | `:896-897` |
| `chosen.capacityAtDecision{used,cap}` | the SE's load **at that moment** | `:888-891` |
| `chosen.clusterSeed` | not a cluster follow-on | `:892` |
| `chosen.plannerPlanned` / `.plannerBias` | pinned / pin actually changed the pick | `:886-887` |
| `runnersUp[≤5]` | `TRACE_RUNNERS_UP = 5` (`:49`) | `:905-933` |
| `processingRank` | on the **recommendation** row, not the trace | `:591` |

### 16.4 Read-surface metrics (calculated per request, not persisted)

| Metric | Formula | Service | Endpoint |
|---|---|---|---|
| `TodaySituation.placed` | Σ tickets across all lanes' stops | `dispatch-today-query.service.ts:289` | `/api/dispatch/today` |
| `.unassignable` | `unassignable.length` (from today's traces) | `:290` | ↑ |
| `.held` | `held.length` | `:291` | ↑ |
| `.criticalNeedsYou` | open `ESCALATION_REQUIRED` insertions | `:292` | ↑ |
| `.overCapacity` | lanes where `committed >= dailyCapacity` | `:293` | ↑ |
| `.changesToday` | human adds + human removes in the IST day | `:465-478` | ↑ |
| `policyWithheld.count` | latest run-zone's `withheld_below_threshold` | `:481-488` | ↑ |
| `TodayEngineer.committed` / `.overCapacity` | `committedDayPlan` / `>=` | `:232, 242` | ↑ |
| `AssignablePlantRow.openUnassigned` | count of `assignableTickets(day)` | `assignable-work-query.service.ts:95` | `/api/schedules/assignable-work` |
| `.criticalCount` | of those, `isCriticalPlus(slaBucket)` | `:98` | ↑ |
| `.oldestInactivityHours` | `max(Number(inactivityHours))`, null-safe | `:103-106` | ↑ |
| `.heldCount` | `groupBy` over `heldTickets(day)` | `:80-84` | ↑ |
| `.totalDevices` | `device_states` grouped by (company, plant) | `:142-146` | ↑ |
| `CandidateRow.committed` / `.dailyCapacity` | shared | `candidate-query.service.ts:164-165` | `/api/schedules/candidates` |
| `.tierRank` | `{DEDICATED:1, MULTI_PLANT:2, FLOATING:3}` | `:14` | ↑ |
| `OverrideLaneImpact.after` | `max(0, committed ± n)` | `override-projection.service.ts:177` | `/api/batches/:id/override/preview` |
| `.overCapacity` | `after >= dailyCapacity` | `:191` | ↑ |
| `headroom` (Distribute) | `dailyCapacity − (committed + runningPlaced)`; unset cap → `+Infinity` | `distribute-projection.service.ts:195-197` | `/api/schedules/distribute-preview` |
| `PlantDeviceStats.*` | totals / inactive / assigned / unassigned per plant | `dispatch-transparency-query.service.ts:603-639` | zone detail |
| `DispatchChangesTodayView.counts.*` | adds / removes / swaps / total | `dispatch-changes-today.service.ts:156-161` | `/api/dispatch/changes-today` |
| recovery `attempts` | persisted counter | `dispatch-run.service.ts:700` | today view rail |
| `ZoneOperatingMode.silentCount`/`.eligibleCount` | the mode's own inputs | `soft-inactive-count.service.ts` | operating-mode read |

### 16.5 Named in the task, `EXPECTED_BUT_NOT_FOUND` as scheduler metrics

| Asked for | Verdict | Nearest real thing |
|---|---|---|
| "tickets deferred" as a run metric | `EXPECTED_BUT_NOT_FOUND` on the run ledger | `heldCount` (work pool), `TodayHold[]` (cockpit), `deferredExcluded` (bulk-unassign preview) |
| "tickets held" as a run metric | ↑ same | ↑ |
| "conflict count" | `EXPECTED_BUT_NOT_FOUND` — no counter | `OverrideConflicts{onSite[], deferred[]}` per proposal only |
| "retry count" (dispatch) | `EXPECTED_BUT_NOT_FOUND` — the patience loop keeps **no** counter | recovery `attempts` is a different thing; `intraday_insertions.retry_count` exists but is `DEAD/UNUSED` since #268 removed the offer machinery |
| "utilization" | `EXPECTED_BUT_NOT_FOUND` as a computed ratio | UI must compute `committed / dailyCapacity` itself; both fields ship |
| "preview freshness" | `PARTIALLY_IMPLEMENTED` | `bucketsAsOf` (a data watermark) + `previewToken` (a staleness *proof*, not a timestamp) |
| "run duration" as a stored column | `IMPLEMENTED_DIFFERENTLY` | computed at read time from `startedAt`/`finishedAt` |
| "failure count" as a run column | `IMPLEMENTED_DIFFERENTLY` | `errorCount` computed at read time from zone rows |
| "SLA bucket" as a scheduler output | `BACKEND_ONLY` upstream | produced by `DeviceStateService.recompute`, consumed here |
| "cluster multiplier" as a KPI | it is a **config value**, per-candidate ×1.25/×1.0, in every breakdown | — |
| "route position" | in-memory only, **never persisted** | `stop_sequence` is the persisted route |
---

## 17. Capacity Calculation

### 17.1 The denominator

`engineer_master.daily_capacity` — `Int`, **not nullable**, no default in the schema
(`schema.prisma:246`). Read once per run for **every** engineer, not just the zone's:

```ts
prisma.engineerMaster.findMany({ select:{ engineerId:true, dailyCapacity:true, isActive:true } })
```
`scoring-config.ts:47-52`. Not zone-scoped, deliberately, matching `readEngineerHomeBases`: "a
floating/multi-plant SE's home base is a global fact, not a per-zone one" (`:57-59`).

### 17.2 The numerator

`committedDayPlan(targetDay)` — §10.3. Whole-day, all zones, all runs.

**Seeding is the NEW-A1 fix** (`recommender.service.ts:495-499`):

> "Seed the capacity counter from the SE's ALREADY-committed day plan (other zones this run, and any
> earlier run today), so `daily_capacity` caps the whole day rather than this zone-run in isolation.
> Without this a cross-zone floating/multi-plant SE is dispatched up to capacity in **every** zone
> the daily loop visits (each `runForZone` started the map at 0)."

Then incremented in-run on each win (`:813`), giving a running whole-day total to check against the
cap.

### 17.3 The check

```ts
overCapacity: input.capacity !== undefined && input.committed >= input.capacity.dailyCapacity
```
`candidate-readiness.ts:59`. `>=`, not `>`.

`capacity === undefined` (no `engineer_master` row — reachable through `se_coverage`, keyed on
`se_id`) is **not** over-capacity, deliberately (`:9-12`).

### 17.4 Where capacity blocks and where it only warns `FRONTEND_RELEVANT`

This is the single most important operational asymmetry in the engine.

| Path | Capacity behaviour | Evidence |
|---|---|---|
| Morning batch (`runForZone`) | **HARD BLOCK** — `OVER_CAPACITY` drops the candidate | `hard-filters.ts:71-72` |
| Intraday CRITICAL sweep | **HARD BLOCK**, and rather than bypass it the ticket **escalates** to the ZM | `intraday-insertion.service.ts:286-290`; docstring `:134-135`: "there is no automatic capacity bypass, ever" |
| `POST /schedules/assign` | **NO CHECK AT ALL** | `override.service.ts:404-585` — no capacity read |
| `POST /schedules/assign-batch` / `assign-plants` | **NO CHECK** | `assignLane:723-877` |
| `POST /batches/:id/override` (any action) | **NO CHECK** | `override.service.ts:151-232` |
| `POST /intraday-insertions/:id/manual-assign` | **NO CHECK**; the modal deliberately offers over-capacity SEs | `intraday-insertion.service.ts:382-401`: "a capacity- or kit-short SE was always offered here (Q2: an administrative override, not a gate), and folding the verdict in would silently narrow the set" |
| Override impact preview | **REPORTS** `overCapacity: true`, never refuses | `override-projection.service.ts:189-192` |
| Distribute preview | **REPORTS** `overCapacitySeIds[]`, never refuses | `distribute-projection.service.ts:214-238` |
| Candidate column | **REPORTS** `verdict:'DROPPED', dropReason:'OVER_CAPACITY'` — the row is still returned | `candidate-query.service.ts:74-77` |
| Cockpit lane | **REPORTS** `overCapacity: boolean` | `dispatch-today-query.service.ts:242` |

**The ruling (#258 Q2), quoted:** *"overload is an administrative right, so it is a seen decision
rather than a refused one"* (`zm-schedule-query.service.ts:36-38`).

**Frontend consequence:** every manual assign surface must show `committed / dailyCapacity` and mark
overload, and must **not** disable the action. Every automatic path is already blocked server-side.

### 17.5 Capacity at decision — the historical record

`trace.chosen.capacityAtDecision = { used, cap }` (`recommender.service.ts:888-891`), where `used`
is the in-run counter *after* this win and `cap` comes from the run's live `capacity` map.

Separately, the **zone-detail read** derives `capacityUsed` from the run's **frozen snapshot**:

```ts
capacityUsed: { used: usedBySchedule.get(scheduleId) ?? b.tickets.length,
                cap:  capacityOf(b.seId) }        // from config_snapshot.capacity
```
`dispatch-transparency-query.service.ts:539`, `capacityFromSnapshot:935-944`. `used` is
**live** (all live tickets across the SE's whole schedule for this zone/day, every run that appended)
while `cap` is **historical**. That is deliberate — "the historical 18/25 denominator; a later
capacity edit must not rewrite past runs" — but a UI showing `used/cap` from this endpoint is mixing
a live numerator with a frozen denominator. Worth a tooltip.

---

## 18. Winner Selection

### 18.1 The decision, in order

```
1. ordered      = orderedCandidatesForPlant(plantId)          [+ #276 engineerIds narrowing]
2. readiness    = ordered.map(buildCandidateReadiness)
3. {passed,dropped} = applyHardFilters(readiness)
4. winningTier  = passed[0]?.coverageType ?? null
5. tierCandidates = passed.filter(c => c.coverageType === winningTier)
6. tierScores   = tierCandidates.map(scoreCandidate(featuresFor(ticket, seId), weights,
                                                    clusterFor(seId)))
7. chosen       = pinned(passed)                          ← crosses tiers
               ?? tierCandidates.sortBy(score desc, seId asc)[0]
               ?? null
```

### 18.2 Every edge case, with the exact behaviour

| Situation | Behaviour | Where | Persisted |
|---|---|---|---|
| **No candidate exists** (`ordered.length === 0`) | `chosen = null`; `poolEmptyReason = 'NO_COVERAGE'`; `unassignableReasons.NO_COVERAGE++` | `:701-702` | `recommendations` row `status:'UNASSIGNABLE'`, `seId: null`, `scoreBreakdown.reason:'NO_ELIGIBLE_SE'` + trace with `candidatesTotal: 0, passedCount: 0` |
| **All candidates fail filters** | `chosen = null`; `poolEmptyReason = 'ALL_DROPPED'`; `dropBuckets` accumulated | `:701-704` | as above, `candidatesTotal > 0`; `runnersUp` = first 5 of `ordered`, all `verdict:'DROPPED'` with their `dropReason` |
| **Candidate lacks ranking data** — no `engineer_master` row | passes `OVER_CAPACITY` (undefined ≠ over) and `SE_UNAVAILABLE` (`isActive ?? true`) → **stays a candidate** | `candidate-readiness.ts:56,59` | scored normally; `capacityAtDecision.cap` is `null` |
| **Ticket lacks ranking data** — no `sla_bucket` | dropped **before** the loop; no recommendation, no trace | `:434-439` | only `bucketlessDropped` count |
| **Candidates score equally** | `se_id.localeCompare` ascending decides | `tier-score-chooser.ts:68` | `scoreDegenerate: true` on the trace |
| **Manager pins an engineer** | the pin wins outright, across tiers, over any score | `tier-score-chooser.ts:63-65` | `plannerPlanned: true`; `plannerBias: true` **only if** `passed[0].seId !== chosen.seId` |
| **Capacity exhausted** | `OVER_CAPACITY` drop → the tier may empty → the next tier is reached | `hard-filters.ts:71` | `dropCounts.OVER_CAPACITY` |
| **Engineer unavailable** | `SE_UNAVAILABLE` drop | `hard-filters.ts:69` | `dropCounts.SE_UNAVAILABLE` |
| **Stale data** (buckets, mode) | run proceeds; `bucketsAsOf` records the watermark | `:442-445` | `projection.bucketsAsOf` on previews; **`NOT SURFACED` on real runs** — see §39 |
| **Stale floating MV** | run proceeds with a log warning | `:1270-1292` | `config_snapshot.eligibilityMv.stale` |
| **Concurrent run already holds this ticket's SUGGESTED** | `P2002` caught → `continue` — the ticket is **skipped silently**, no counter | `:803-811` | nothing. ⚠ **This ticket vanishes from the run's arithmetic.** |
| **Crash-window orphan SUGGESTED** | retired to `RETIRED` before the loop (zone-wide), freeing the partial unique | `:588` → `:994-1004` | status flip; the trace survives |

### 18.3 The `P2002 → continue` gap ⚠ `AMBIGUOUS`

`recommender.service.ts:809`:

```ts
} catch (e) {
  if ((e as { code?: string }).code === 'P2002') continue;
  throw e;
}
```

A ticket skipped this way increments **neither** `recommended` nor `unassignable`, writes no
recommendation and no trace. `ticketsConsidered` still counts it. So on a run where this fires,
`recommended + unassignable < ticketsConsidered` by the number of collisions, with nothing naming the
difference.

The code justifies the *choice* (guard-not-throw beats wedging the whole zone, `:773-776`) and the
dry-run docstring names the divergence honestly (`:804-808`), but **no counter exists**. This is a
real gap → §39.

### 18.4 Planner bias — the two different booleans `FRONTEND_RELEVANT`

```ts
plannerPlanned: planned?.has(chosen.seId) ?? false                        // was this SE pinned?
plannerBias:    plannerPlanned && passed[0]?.seId !== chosen.seId         // did the pin CHANGE it?
```
`:868`, `:887`, and identically on `PreviewDecision.plannerBias` (`:843`).

**They mean different things.** A pin on the SE who would have won anyway is `plannerPlanned: true,
plannerBias: false` — the manager's intent is recorded, but the engine's answer is unchanged. Only
`plannerBias: true` means "a human's choice overrode the engine's."

⚠ **The comparison baseline is `passed[0]`, not `tierCandidates.sortBy(score)[0]`.** `passed[0]` is
the highest-precedence *eligible* candidate, not the top-scoring one in the winning tier. When the
score reorders within a tier, a pin on the score-winner (who is not `passed[0]`) reports
`plannerBias: true` even though the pin changed nothing. `IMPLEMENTED_DIFFERENTLY` — the flag reads
"the pin differed from precedence", not "the pin differed from the engine's answer."

---

## 19. Planner / Manager Pin

### 19.1 The read

```ts
private async plannerForDate(zoneId: bigint, day: Date): Promise<Map<string, Set<string>>> {
  const entries = await this.prisma.sePlanner.findMany({
    where: { plannedDate: day, plant: { zoneId } },
    select: { seId: true, plantId: true },
  });
  // → plant_id(string) → Set<se_id>
}
```
`recommender.service.ts:1111-1124`. One query per zone-run.

**`day` must be the IST calendar day** (`:1108-1110`): "`planned_date` is a `@db.Date`, and deriving
it from UTC components read the *previous* day's rows for every run between 00:00 and 05:29 IST,
dropping the bias with nothing logged."

### 19.2 Model + CRUD

`se_planner` — `@@unique([seId, plantId, plannedDate])`, `@@index([plannedDate])`
(`schema.prisma:757-771`). Plant-level intent, **distinct from the ticket-level Day Plan**.

| Route | Role | Body/Query | Outcome |
|---|---|---|---|
| `GET /api/planner?dateFrom&dateTo` | ZM/CSM/OH | ISO dates | `PlannerEntryView[]`, ZM zone-clamped via `plant.zoneId` |
| `GET /api/planner/plants` | ZM/CSM/OH | — | `PlannerPlantView[]` — zone-scoped picker source |
| `POST /api/planner` | ZM/CSM/OH | `{seId, plantId, plannedDate}` | idempotent `upsert` (`update:{}`); 404 `PLANT_NOT_FOUND`, 403 `ZONE_SCOPE_VIOLATION` |
| `DELETE /api/planner/:id` | ZM/CSM/OH | — | `{deleted:true}`; 404 `PLANNER_ENTRY_NOT_FOUND`, 403 `ZONE_SCOPE_VIOLATION` |

`planner/se-planner.controller.ts`, `se-planner.service.ts`.

⚠ **No date validation.** `POST` does `new Date(input.plannedDate)` unguarded
(`se-planner.service.ts:53`); `GET` likewise for the range. A malformed date yields Invalid Date and
a Prisma error — not a 400. Minor, but the frontend must validate client-side.

⚠ **Stray in-repo comment** at `se-planner.controller.ts:58`: `//new HttP methord (25th August )`.
Cosmetic; noted for completeness.

### 19.3 Pin semantics — soft bias, three consequences

1. **It is not a hard constraint.** A pinned SE who fails a hard filter is not in `passed` and
   `passed.find(...)` will not find them. The pin is silently ignored, and **nothing records that**.
   → §39.
2. **It crosses tiers** (`tier-score-chooser.ts:63`). §14.1.
3. **It beats the score** — it is the first term of the `??` chain.

**The intraday CRITICAL sweep has no pin** (`intraday-insertion.service.ts:279-280`): "the ADR-0022
soft bias is a morning-batch concept the issue's ACs never extend to CRITICAL work, so this stays
pure tier+score rather than inventing a new rule."

Verified by `test/recommender-planner-bias.e2e-spec.ts` (a planner-named MULTI_PLANT SE beats an
eligible DEDICATED one).

---

## 20. Recommendation Generation

### 20.1 The two row shapes

**Assignable** — `recommender.service.ts:779-801`:

```ts
prisma.recommendation.create({ data: {
  ticketId, seId: chosen.seId, companyTier: t.companyTier, deviceBucket: t.deviceBucket,
  scoreBreakdown: { ...scored.breakdown, mode, weightSetRef, coverageType,
                    companyTier, deviceBucket, companyPriorityRank,
                    score: scored.score, tierOverrideId },
  processingRank, status: 'SUGGESTED', path: 'MORNING_BATCH', runId: opts.runId ?? null,
}})
```

**Unassignable** — `:680-699`:

```ts
{ ticketId, seId: null, companyTier, deviceBucket,
  scoreBreakdown: { reason: 'NO_ELIGIBLE_SE', mode, weightSetRef,
                    companyTier, deviceBucket, tierOverrideId },
  processingRank, status: 'UNASSIGNABLE', path: 'MORNING_BATCH', runId }
```

**The winner's persisted breakdown is the same computation that selected them** (`:769-771`) — same
helper, same multiplier — "rather than a second derivation that could quietly disagree with it."

### 20.2 `recommendations.status` — a plain TEXT column, four values

`recommender/recommendation-status.ts:1-17` is the only place the vocabulary is agreed:

| Value | Meaning |
|---|---|
| `SUGGESTED` | live; offered and unconsumed. **At most one per ticket**, by the partial unique `recommendations_one_suggested_per_ticket` |
| `DISPATCHED` | consumed — the dispatch transaction placed it on a Day Plan |
| `UNASSIGNABLE` | the engine considered the ticket and could place it nowhere |
| `RETIRED` | superseded — live when the owning run stopped being live |

**`RETIRED` exists because the alternative was DELETE, and `dispatch_decision_traces` cascades on
delete** (`schema.prisma:998`). "So the next run for a zone destroyed the crashed run's reasoning as
its first act, and 'what was the dead run about to do?' became permanently unanswerable at exactly
the moment somebody would ask" (`recommender.service.ts:987-992`).

`RETIRED` frees the partial unique identically, because that index is `WHERE status = 'SUGGESTED'`.
What actually prevents a double dispatch is **that index plus the in-transaction re-read**, never the
DELETE.

### 20.3 `SUPERSEDED_RECOMMENDATION_STATUSES` — the read-side consequence

```ts
export const SUPERSEDED_RECOMMENDATION_STATUSES = ['RETIRED'];   recommendation-status.ts:27
```

Retiring rather than deleting changed what `ORDER BY recommendation_id DESC LIMIT 1` returns: a
retired row is *newer* than the DISPATCHED row that actually explains the ticket's placement. Two
readers exclude it:
- `ZmScheduleQueryService.reasoningByTicket` (`:269`) — the "Why suggested?" chip;
- `DispatchTransparencyQueryService.getBatchDetail` (`:693`) — the batch table.

And one deliberately **keeps** it: `getRunDecisions` (Replay, `:790-792`) — "it is what the run
intended for a ticket it did not end up placing, which is precisely the question Replay exists to
answer."

### 20.4 Orphan clearing — two sweeps

| Sweep | When | Scope | Predicate |
|---|---|---|---|
| `clearFinalizedOrphans` `:994` | **zone-wide, before** the loop | zone | `status:'SUGGESTED'` AND (`runId: null` OR `run.status != 'RUNNING'`) |
| `clearFailedSeOrphans` `batch-assignment.service.ts:359` | after commit | **only the SEs whose transaction failed** | `runId`, `zoneId`, `status:'SUGGESTED'`, `seId: { in: failedSeIds }` |

Both now `updateMany → RETIRED` (`#286`), not delete.

**The zone-wide sweep is suppressed on dry runs** and this is the mutation that most needs it
(`:585-587`): "the delete is ZONE-WIDE, so a preview that ran it would silently destroy a concurrent
live run's SUGGESTED rows. Skipping it is also why a dry run cannot hit the P2002 path — it never
creates."

**The per-SE sweep's scope is #262's correction to a zone-wide delete** (`:352-357`): "with per-SE
claiming, a row this dispatch never saw is a row **somebody else has locked** (SKIP LOCKED), and
sweeping the zone would delete work out from under its claimant."

### 20.5 Trace rows

Accumulated in memory (`traceRows: Prisma.DispatchDecisionTraceCreateManyInput[]`, `:570`) and
written in **one `createMany` after the loop** (`:944-946`), gated on
`opts.runId !== undefined && traceRows.length > 0 && !dryRun`.

⚠ **No trace without a `runId`.** A `runForZone` called without one (possible in tests and via the
scoped-projection path) writes recommendations but no traces.

---

## 21. Day Plan Generation

`BatchAssignmentService` — `scheduling/batch-assignment.service.ts`, 370 lines.

### 21.1 The unit of work is the SE, not the zone `IMPLEMENTED`

`:52-60` records why this changed:

> "This used to be a single transaction spanning every SE in the zone, which had three consequences
> that only appear in production: one conflict rolled back everybody's day plan; transaction duration
> grew with the zone at ~3 round-trips per ticket, against an interactive-transaction budget of 5 s
> that nobody had chosen; and recommendation consumption was one zone-wide flip at the end, so a
> concurrent claimer collided instead of simply not seeing the rows."

### 21.2 `dispatchForZone` — the outer loop

```
seIds = sesWithSuggestions(zoneId)          // OUTSIDE any transaction (:102)
  ordered by processingRank asc, first appearance wins → "SEs are dispatched in the order their
  best-ranked ticket implies"                                                        (:313-322)
if empty → return {0,0,0}
for seId of seIds:
   try   dispatchForSe(...) → accumulate
   catch describeSeSkip(seId, e) → seSkips.push, log warn, CONTINUE          (:105-116)
orphansCleared = clearFailedSeOrphans(runId, zoneId, failedSeIds)            (:122)
drainRows(prisma, notifier, outboxIds, now)        ◄── POST-COMMIT           (:128)
```

### 21.3 `dispatchForSe` — one engineer, one transaction

`:147-306`.

```sql
-- 1. bound the lock wait, then take it (BLOCKING, not try)
SET LOCAL lock_timeout = '3000ms'
SELECT pg_advisory_xact_lock(hashtext('dispatch_zone_<id>'))

-- 2. claim THIS SE's recommendations
SELECT r.recommendation_id, r.ticket_id, t.plant_id
  FROM recommendations r
  JOIN tickets t ON t.ticket_id = r.ticket_id
  JOIN plants  p ON p.plant_id  = t.plant_id
 WHERE r.status='SUGGESTED' AND r.se_id = $1::uuid AND p.zone_id = $2
 ORDER BY r.processing_rank ASC NULLS LAST, r.recommendation_id ASC
   FOR UPDATE OF r SKIP LOCKED
```

**`FOR UPDATE OF r`** names the recommendations alone — "the joined ticket and plant rows are read
for their columns and must not be locked, or an unrelated ticket write would block on us" (`:170-171`).

**`SKIP LOCKED` is the point** (`:164-166`): "a concurrent claimer's rows become invisible rather than
a P2002 nobody can recover from in place (a P2002 aborts its transaction)."

Then:

```
3. alreadyAssigned = batch_assignment_tickets WHERE ticketId IN claimed AND removedAt IS NULL
   fresh = claimed.filter(not already)                                          (:182-190)
4. byPlant: Map<plantId, ticketIds[]>  — insertion order = canonical processing order (:193-198)
5. schedule: reuse the SE's existing LIVE (se, zone, dateFrom) schedule, oldest first,
   else create one  { status:'ACTIVE', source:'SYSTEM_GENERATED', dispatchedAt: now, runId }
                                                                                (:214-236)
6. stopSequence continues after max(stop_sequence) on that schedule             (:240-244)
7. coverageByPlant = resolveCoverageForPlants(tx, seId, plants)  — one lookup per stop (:249)
8. per plant: create plant_batch_assignments { status:'AUTO_ASSIGNED', stopSequence,
                                               runId }                          (:254-256)
9. per ticket: create batch_assignment_tickets { sortOrder, addSource:'AUTO_DISPATCH',
                addedBy: NULL, coverageTypeAtAssign, createdAt: now }           (:262-276)
   + ticket.update { assignmentState:'FORMALLY_ASSIGNED', deferredUntil: null } (:279-284)
10. queueDayPlanDispatched(tx, {...}) → outbox row id                           (:292)
11. recommendation.updateMany { in: claimed ids } → status:'DISPATCHED'         (:299-302)
```

**APPEND, don't collide** (`:205-213`): reuse the SE's existing live schedule instead of creating a
second one. `#153` made this use `liveScheduleFilter()`, and here **the unique index cannot be the
safety net** — it is partial on `status='ACTIVE'`, so once a ZM override flipped the schedule to
`OVERRIDDEN` this lookup missed it, the create succeeded unopposed, and the SE ended the day with two
day plans.

**Recommendations are consumed for every row CLAIMED, guarded duplicates included** (`:298`) —
"they are done with, not to be re-evaluated." Scoped to the claimed ids rather than to the SE, "so a
row that arrived after the claim is left for the next pass instead of being silently retired unread."

**`addedBy` stays NULL by construction** for engine writes (`:266-269`): "the actor column answers
'which person did this', and here none did. `run_id` on the batch is the engine's own handle."

**A fresh batch per run** even when the plant already has a stop from an earlier run (`:251-253`) —
keeps run-attribution clean and avoids mutating another run's batch.

### 21.4 Stop ordering — the deferred seam

```ts
private orderPlantStops(byPlant: Map<bigint, string[]>): [bigint, string[]][] {
  return [...byPlant.entries()];      // insertion order
}                                                     batch-assignment.service.ts:330-332
```

"Recommendations arrive in canonical processing order, so each plant's insertion position already
reflects the rank of its lead (best) ticket… **This is the hook that swaps to PostGIS route-distance
once day-plan geo exists (Issue 14).**"

`EXPECTED_BUT_NOT_FOUND` — there is **no route optimisation**. Stops are ordered by the rank of each
plant's best ticket, and nothing reorders them afterwards except an explicit `REORDER` override or
`insertAtTop`.

### 21.5 Per-SE skip vocabulary `FRONTEND_RELEVANT`

`se-skip.ts:291-315` — `describeSeSkip(seId, e)`:

| Constraint | Reason string |
|---|---|
| `WorkSchedule` | `SCHEDULE_CONFLICT: this SE already holds an ACTIVE schedule for this zone/day` |
| `BatchAssignmentTicket` | `TICKET_CONFLICT: one of this SE's tickets was put on a live batch by someone else mid-dispatch` |
| `null` + `/lock timeout/i` | `ZONE_LOCK_TIMEOUT: another zone-wide operation held the lock` |
| `null` (anything else) | the raw error message |

**The discriminator is `uniqueViolationModel`, not `e.meta.target`** (`:284-289`): "#262's issue text
specifies `meta.target` — the field every Prisma example keys on — and **it does not exist under this
repo's driver adapter**; #265 measured its absence and established `meta.modelName` as what actually
arrives." Exact only because each table carries exactly one unique constraint.

`seSkips` is written to `dispatch_run_zones.se_skips` (JSONB) and **kept apart from `error`**
(`dispatch-run.service.ts:1163-1165`): "a zone that dispatched four of five SEs did not fail;
recording that as a zone error would put a contained, named, single-engineer problem in the run's
Errors column."

Read back defensively — `readSeSkips` (`dispatch-transparency-query.service.ts:288-296`) drops
anything not matching `{seId: string, reason: string}` "rather than rendering as `[object Object]` on
an operator's screen." **An empty array and a NULL mean the same thing to the reader.**

### 21.6 `DispatchSummary.skipReason` — now whole-zone only

```ts
skipReason?: string | null    // batch-assignment.service.ts:40
```
`:36-39`: "#262 narrowed what may appear here. It is now reserved for **whole-zone** conditions —
today only `LOCK_CONTENDED`… before this, one SE's collision produced a zone-wide
`SCHEDULE_CONFLICT` that named a skip which had not happened."

⚠ Note: grep finds no live writer of `LOCK_CONTENDED` inside `BatchAssignmentService` post-#262 — the
per-SE lock timeout now surfaces as a `seSkip`. `skipReason` may be effectively `DEAD/UNUSED` on the
dispatch path, while `bulk-unassign.service.ts` still uses the same string for its own skips. The UI
should treat a non-null zone `error` as authoritative and read `seSkips` for per-engineer detail.

---

## 22. Assignment Commit

### 22.1 What "committed" writes

| Table | Write | Notes |
|---|---|---|
| `work_schedules` | reuse-or-create | `ACTIVE`, `SYSTEM_GENERATED`, `dispatchedAt: now`, `runId` |
| `plant_batch_assignments` | create per plant | `AUTO_ASSIGNED`, `stopSequence`, `runId` |
| `batch_assignment_tickets` | create per ticket | `sortOrder`, `addSource:'AUTO_DISPATCH'`, `addedBy: null`, `coverageTypeAtAssign`, `createdAt: now` |
| `tickets` | update | `assignmentState → 'FORMALLY_ASSIGNED'`, `deferredUntil → null` |
| `recommendations` | update | claimed rows → `'DISPATCHED'` |
| `day_plan_notification_outbox` | create | one row per SE, **inside** the transaction |

**"Committed work leaves the Shared Pool"** (`:277-278`): the dispatched ticket is now a Formal
Assignment, not pickable secondary work.

**The deferral is spent on dispatch** (`:281-283`): "the batch row's `deferred_to_date` is the
durable record of what the ZM did."

### 22.2 The idempotency guards (why a re-run the same day is safe)

| Guard | Mechanism | Where |
|---|---|---|
| G1 one live SUGGESTED per ticket | partial unique `recommendations_one_suggested_per_ticket` | DB |
| G2 one live batch row per ticket | partial unique `batch_assignment_tickets_one_active_per_ticket` (`schema.prisma:712-713`) | DB |
| G3 one ACTIVE schedule per (se, zone, date_from) | partial unique `work_schedules_one_active_per_se_zone_day` | DB |
| G4 one RUNNING claim per zone | `ux_dispatch_run_zones_one_running_per_zone` | DB |
| G5 in-transaction re-read | `alreadyAssigned` set, computed **inside** the tx | `:182-190` |
| G6 cross-instance tick claim | `cron_tick_claims` composite PK | `cron-tick-claim.service.ts` |
| G7 claim-then-deliver | outbox `sentAt IS NULL` guarded update | `day-plan-notification-outbox.ts:112-117` |
| G8 recommendation consumption | claimed rows flipped `DISPATCHED` | `:299` |

`#286`'s recovery relies on these: "work the dead run already committed is already committed, and the
recommendation-consuming dispatch simply finds nothing left to place for it"
(`dispatch-run.service.ts:606-609`). **AC3 holds without a line of code.**

### 22.3 Notification outbox `IMPLEMENTED`

`scheduling/day-plan-notification-outbox.ts`.

**Write inside, deliver outside.** `queueDayPlanDispatched` / `queueDayPlanOverridden` write the row
in the caller's own transaction (`:22-59`), so "the intent commits with the plan or not at all."
Delivery is attempted post-commit.

**Claim before deliver** (`:106-131`):

```ts
const claim = await transitionOrConflict(prisma.dayPlanNotificationOutbox,
  { id: row.id, sentAt: null },
  { sentAt: now, attempts: { increment: 1 } });
if (!claim.won) return;                 // already sent, or another drain just claimed it
try { await deliver(notifier, row); }
catch (e) {
  await update({ where:{id}, data:{ sentAt: null, lastError: message } });   // un-claim
  logger.warn(...);                     // NEVER rethrows
}
```

**This is #264's core guarantee**: "the dispatch/override this row belongs to has ALREADY committed —
a delivery failure here must never propagate into that outcome." Before this, a notifier failure
surfaced as a *zone dispatch error* even though every schedule had committed
(`batch-assignment.service.ts:125-127`).

**Bounds:** `MAX_OUTBOX_ATTEMPTS = 5` (`:9`), `OUTBOX_RETENTION_DAYS = 30` (`:11`). The `*/2` re-drain
sweep takes `attempts < 5`; an exhausted row **stays visible via `lastError`**, never retried forever
and never silently dropped. Pruning rides the daily partition-maintenance tick, not a cron of its own.

**Event types:** `DAY_PLAN_DISPATCHED` (payload `{stops, tickets}`, carries `zoneId`) and
`DAY_PLAN_OVERRIDDEN` (payload `{batchId, action}`, `zoneId: null`). An unknown `event_type` is
**logged, not thrown**, "so one malformed row can never wedge a drain pass over the rows after it"
(`:92-95`).

**Recipient:** always the SE themselves, one recipient, no lookup (`day-plan-notifier.ts:49-55`). No
`entityType`/`entityId` is set — "Home *is* the Day Plan", so there is nothing to tap-route into.
---

## 23. Database Model / Data Map

All models are in `apps/backend/prisma/schema.prisma`. Column names are the `@map`ped SQL names.

### 23.1 `dispatch_runs` — the run ledger `:823-877`

```
Purpose     one row per runForActiveZones invocation; observe-only
PK          run_id BIGSERIAL
FKs         none outbound (actor_user_id is a bare uuid, FK deferred)
Columns     trigger DispatchRunTrigger(CRON|MANUAL) · actor_user_id uuid? · actor_role text?
            reason text?                                  ← #213 operator "why", MANUAL only
            started_at timestamptz · finished_at timestamptz?
            heartbeat_at timestamptz?                      ← #261; NULL for pre-column rows
            status DispatchRunStatus(RUNNING|SUCCESS|PARTIAL|FAILED|ABORTED)
            zones · schedules · batches · tickets_dispatched · recommended · unassignable   int @default(0)
            withheld_below_threshold int @default(0)
            bucketless_dropped int?                        ← NULLABLE = "not recorded"
            component_blocked_withheld int?                ← NULLABLE = "not recorded"
            config_snapshot jsonb                          ← §7.7
            build_version bigint? · build_fingerprint text?
Index       @@index([startedAt(sort: Desc)])
Read by     DispatchTransparencyQueryService.listRuns/getRunDetail; DispatchTodayQueryService.latestRun
Written by  admit (create), execute (finalize, guarded), reapStaleDispatchRuns (ABORTED),
            touchHeartbeat
Frontend    Runs list, Run detail header, Config-in-effect panel, build badge
```

### 23.2 `dispatch_run_zones` — the zone claim + zone card `:887-932`

```
Purpose     BOTH the run's durable claim on a zone AND its per-zone result card
PK          id BIGSERIAL
Unique      @@unique([runId, zoneId])                     ← one row per (run, zone)
DB unique   ux_dispatch_run_zones_one_running_per_zone     ← raw SQL, partial on status='RUNNING'
FKs         run_id → dispatch_runs (onDelete: Cascade)
            zone_id → zones (onDelete: Cascade)
            contended_with_run_id  ← PLAIN BIGINT, NO RELATION, deliberately: "a purge must not be
                                     able to rewrite this history" (:895-896)
Columns     status DispatchZoneClaimStatus (NO DEFAULT — "a claim and a refusal are written by
                   different code paths and each has to say which one it is")
            mode DispatchZoneMode? · weight_set_ref text?  ← null when the zone errored pre-recommender
            tickets_considered · recommended · unassignable int @default(0)
            unassignable_reasons jsonb?
            withheld_below_threshold int @default(0)
            assignment_threshold_hours int?
            bucketless_dropped int? · component_blocked_withheld int?
            schedules · batches · tickets_dispatched int @default(0)
            error text? · se_skips jsonb?
            started_at timestamptz (= claim time, not processing time) · finished_at timestamptz?
Read by     listRuns (clamped), getRunDetail, getZoneDetail, DispatchTodayQueryService
            (latestRun, policyWithheldCount), holdersFor/claimantsOf (raw SQL)
Written by  admit, promoteContendedClaim, finalizeZoneClaim, releaseStrandedClaims, reaper
Frontend    zone cards, contention badge, seSkips list, the four funnel populations
```

### 23.3 `recommendations` — append-only explainability `:486-510`

```
Purpose     "why suggested?" — one row per (ticket, decision)
PK          recommendation_id BIGSERIAL
Unique      recommendations_one_suggested_per_ticket  ← raw SQL, partial WHERE status='SUGGESTED'
FKs         ticket_id → tickets · se_id → engineer_master (nullable)
            run_id → dispatch_runs (onDelete: SetNull)
Columns     company_tier CompanyTier? · device_bucket SlaBucket?
            score_breakdown jsonb        ← the whole explanation
            processing_rank int?         ← canonical order, per zone
            status text                  ← NOT an enum: SUGGESTED|DISPATCHED|UNASSIGNABLE|RETIRED
            path RecPath(MORNING_BATCH|INTRADAY)
            retry_chain jsonb?           ← DEAD/UNUSED on this table
Relation    trace DispatchDecisionTrace?  (1:1)
Indexes     [ticketId] [seId] [runId]
Retention   90 days (#104 matrix)
```

⚠ `path` is **always `MORNING_BATCH`** in practice — the intraday sweep writes no recommendation row
at all (it goes straight to `assignTicket`). `INTRADAY` is `DEAD/UNUSED`.

### 23.4 `dispatch_decision_traces` — the evidence `:987-1005`

```
Purpose     bounded per-ticket decision trace, 1:1 with the recommendation
PK          trace_id BIGSERIAL
Unique      recommendation_id @unique
FKs         run_id → dispatch_runs · recommendation_id → recommendations (onDelete: Cascade)
            ticket_id → tickets · se_id → engineer_master?
Columns     zone_id bigint    ← DENORMALISED: what makes the zone clamp a predicate rather than a
                                join through ticket → plant (dispatch-transparency:785-787)
            trace jsonb       ← §34.1
Indexes     @@index([runId, zoneId])  @@index([ticketId])
Retention   90 days, same window as recommendations
Note        seId NULL ⟺ unassignable decision
```

### 23.5 `dispatch_zone_recoveries` `:957-978`

```
Purpose     one row per (zone, operating day) recording a day owed
PK          id BIGSERIAL
Unique      @@unique([zoneId, businessDate])   ← ONE attempt budget per zone per DAY
FK          zone_id → zones (Cascade); marked_by_run_id is a PLAIN BIGINT (same reason as above)
Columns     business_date @db.Date · state DispatchRecoveryState
            attempts int @default(0) · marked_at · last_attempt_at? · resolved_at? · last_error?
Read by     recoverMarkedZones; DispatchTodayQueryService.recoveryToday
Written by  markZonesForRecovery (upsert + guarded updateMany), retireMark, cutoff expiry
Frontend    the cockpit's `recovery` rail
```

### 23.6 `work_schedules` `:651-676`

```
PK          schedule_id BIGSERIAL
Unique      work_schedules_one_active_per_se_zone_day  ← raw SQL, partial:
            UNIQUE (se_id, zone_id, date_from) WHERE status = 'ACTIVE'
            ⚠ date_to is NOT in the index (override.service.ts:1048-1058 — a find that included it
              gave a different answer from the constraint and killed every manual assign to an
              engineer with a multi-day or null-dated plan)
FKs         se_id → engineer_master · zone_id → zones · run_id → dispatch_runs (SetNull)
Columns     date_from/date_to @db.Date · status WorkScheduleStatus(ACTIVE|OVERRIDDEN|COMPLETED|PARTIAL)
            source ScheduleSource(SYSTEM_GENERATED|ZM_MANUAL)
            dispatched_at? · last_overridden_by uuid? · last_overridden_at?
Indexes     [seId,dateFrom] [zoneId,status] [runId]
LIVE        ACTIVE ∪ OVERRIDDEN  (schedule-status.ts:23)
```

### 23.7 `plant_batch_assignments` `:681-708`

```
PK          batch_id BIGSERIAL
FKs         schedule_id · plant_id · se_id · run_id (SetNull)
Columns     status BatchStatus(AUTO_ASSIGNED|OVERRIDDEN|COMPLETED|PARTIAL)
            stop_sequence int · override_reason text?
Indexes     [scheduleId] [plantId] [seId] [runId]
Note        run_id is on the BATCH, not only the schedule: "a same-day re-run appends fresh batches
            onto an SE's existing schedule, so a schedule can span runs" (:689-692)
```

### 23.8 `batch_assignment_tickets` — the assignment window `:714-752`

```
PK          id BIGSERIAL
Unique      batch_assignment_tickets_one_active_per_ticket  ← raw SQL, partial
            UNIQUE (ticket_id) WHERE removed_at IS NULL
FKs         batch_id → plant_batch_assignments · ticket_id → tickets
── the START of the window (#283) ──
  added_by uuid?          NULL for engine writes BY CONSTRUCTION, and NULL for pre-#283 history
  add_reason text?        the human "why", where the door required one
  add_source text?        one of ADD_SOURCES (9 members) — TEXT, not an enum
  coverage_type_at_assign text?   one of COVERAGE_AT_ASSIGN incl. NONE
  created_at timestamptz  stamped from the CALLER's clock, not the DB default
── the END of the window (#241) ──
  removed_at timestamptz? NULL ⟺ still live
  removed_by uuid?        NULL for system removals
  removal_reason text?    one of REMOVAL_REASONS (13 members) — TEXT, not an enum
  deferred_to_date @db.Date?
── ordering ──
  sort_order int
Indexes     [batchId] [ticketId]
```

**Why TEXT and not Postgres enums** (`add-source.ts:59-62`, `removal-reason.ts:198-203`): "later
slices add members without a schema migration, and the discipline lives here, in one importable set
every writer uses." The value is read as a **predicate**, not shown as a label, so a typo silently
reclassifies an operation.

**The NULL contract, stated twice:** `add_source`/`added_by` NULL means "the row predates
provenance" — *"Readers must render NULL as unknown, never as a system decision, which is the one
direction that would break the grammar's promise"* (`add-source.ts:64-68`).

### 23.9 `ADD_SOURCES` — the closed vocabulary `add-source.ts:69-94`

| Value | Written by | Actor |
|---|---|---|
| `AUTO_DISPATCH` | morning batch `dispatchForSe` | NULL |
| `SYSTEM_CRITICAL` | intraday CRITICAL sweep via `assignTicket` as SYSTEM | NULL |
| `MANUAL_ASSIGN` | `POST /schedules/assign` | user |
| `MANUAL_BATCH_ASSIGN` | `POST /schedules/assign-batch` | user |
| `MANUAL_PLANT_ASSIGN` | `POST /schedules/assign-plants` | user |
| `MANUAL_REASSIGN` | destination row of a REASSIGN | user |
| `MANUAL_SPLIT` | destination row of a SPLIT_BATCH | user |
| `SAME_DAY_ADD` | `POST /intraday-updates/add` | user |
| `CROSS_ZONE_ASSIGN` | `CrossZoneEscalationService.approve` | user |

`SYSTEM_ADD_SOURCES = [AUTO_DISPATCH, SYSTEM_CRITICAL]`; `isSystemAddSource(null) === false`.

`addProvenanceSourceFor(auditAction, systemActor)` (`:171-185`) — **the actor decides first**, because
the system CRITICAL sweep and a ZM's one-click assign both pass `auditAction = 'CRITICAL_ASSIGN'`.
"That collision is precisely the provenance gap #283 exists to close."

### 23.10 `REMOVAL_REASONS` — 13 members `removal-reason.ts:208-247`

`ZM_WITHDRAWN` · `ZM_DEFERRED` · `REASSIGNED` · `BULK_UNASSIGNED` · `AUTO_RECOVERY` ·
`TICKET_CANCELLED` · `TICKET_RESOLVED` · `COMPONENT_WAIT` · `PLAN_EXPIRED` · `VEHICLE_UNAVAILABLE` ·
`RESOLVED_AT_CLOSURE` · `DEV_CLEANUP` · `HUMAN_REMOVED` (backfill only, never written by live code).

**`REASSIGNED` is the only removal reason that promises a matching add**, which is what makes swap
pairing possible (`dispatch-changes-today.service.ts:85-86`).

### 23.11 Supporting models

| Model | Key columns | Scheduler role |
|---|---|---|
| `priority_rule_config` `:459-471` | `weight_set_ref`, `component`, `weight Decimal(10,4)`, `active`, `effective_from?` | scoring weights; `@@unique([weightSetRef, component])`, `@@index([weightSetRef, active])`. ⚠ `effective_from` is **never read** — `DEAD/UNUSED` |
| `system_settings` `:1557` | `key`, `value jsonb`, `description` | `dispatch_cron`, `plant_cluster_multiplier`, `se_assignment_threshold_hours`, `inactivity_threshold_hours`, `eligibility_mode` |
| `engineer_master` `:242-287` | `daily_capacity`, `coverage_type`, `zone_id`, `home_lat/lng`, `is_active`, `last_activity_at`, `shift_start/end` | capacity, tier, distance |
| `se_coverage` `:305-318` | `(se_id, plant_id)` unique + a **raw-SQL partial unique** `UNIQUE(se_id) WHERE coverage_type='DEDICATED'` that **Prisma cannot see** — an `upsert` with a DEDICATED payload will insert a second row and get a `P2002` naming `se_id` alone (`:293-304`) | tiers 1–2 |
| `plant_eligible_floating_se` | materialized view, not a Prisma model | tier 3 |
| `mv_refresh_state` `:2871` | `view_name` PK, `last_attempt_at`, `last_success_at`, `last_error` | MV freshness |
| `engineer_territory_coverage` `:425-439` | `district_id`/`region_id`/`state`/`polygon` — union membership; raw-SQL CHECK requires ≥1 dimension | feeds the MV |
| `se_planner` `:757-771` | `(se_id, plant_id, planned_date)` unique | the pin |
| `se_availability` `:1470` | `window_start/end` **timestamptz, end-exclusive**, `status`, `set_by_role` | `SE_UNAVAILABLE` |
| `tickets` `:2497-2591` | `deferred_until @db.Date`, `assignment_state`, `repeat_failure`, `company_tier` (denormalised) | selection |
| `device_states` `:2334-2380` | `sla_bucket`, `inactivity_hours Decimal(12,4)`, `latest_gps_datetime`, `computed_at`, `is_inactive`, `eligible_for_uptime`, `is_departed` | ranking |
| `failure_cycles` `:2385` | `state FailureCycleState` incl. `WAITING_COMPONENT` | component gate |
| `vehicle_unavailability_reports` `:2427` | `expected_from`, `proposed_from`, `status`, `decided_by` | `returnDueToday`, hold context |
| `company_tier_overrides` `:69-88` | `(company, zone)`, `tier`, `expires_at`, `status`; **stacking allowed**, newest-wins | effective tier |
| `tiers` `:47-52` | `name` PK, `rank` unique | canon order as data |
| `intraday_insertions` `:532-563` | `insertion_type`, `status`, `offered_se_id?`, `acceptance_deadline?`, `retry_count`, `retry_chain` | CRITICAL ledger + escalations |
| `cron_tick_claims` `:2850` | `(job_name, window_start)` composite PK, `claimed_by` | cross-instance |
| `day_plan_notification_outbox` `:2889` | `event_type`, `se_id`, `schedule_id`, `zone_id?`, `payload`, `sent_at?`, `attempts`, `last_error?` | notifications |
| `component_blocked_queue` `:1385` | ticket + SE + missing parts | ZM-visible kit blocks |
| `audit_logs` `:1715` | `actor_id`, `actor_role`, `acted_as_role`, `acting_zone`, `action`, `entity_type`, `entity_id`, `metadata` | the trail |
| `runtime_lock` | raw table; `version`, `fingerprint` | build-stamp comparison |
| `soft_inactive_count_history` `:2634` | per zone twice daily | mode history |

### 23.12 Relationship map (scheduler subgraph)

```
zones ─┬─< plants ─┬─< tickets ─┬─< recommendations ──1:1── dispatch_decision_traces
       │           │            ├─< batch_assignment_tickets >── plant_batch_assignments
       │           │            ├─< intraday_insertions           │
       │           │            ├─< cross_zone_escalations        │
       │           │            └─< vehicle_unavailability_reports│
       │           ├─< se_coverage >── engineer_master            │
       │           └─< se_planner  >── engineer_master            │
       ├─< dispatch_run_zones >── dispatch_runs ──< work_schedules ┘
       ├─< dispatch_zone_recoveries                     │
       ├─< company_tier_overrides >── company_master    └──< plant_batch_assignments
       └─< engineer_master ──< se_availability

dispatch_runs ──< recommendations        (run_id, SetNull)
dispatch_runs ──< plant_batch_assignments (run_id, SetNull)
dispatch_runs ──< dispatch_decision_traces (run_id, RESTRICT — no onDelete specified)
```

⚠ **Cascade asymmetry worth knowing:** `dispatch_run_zones` cascades from `dispatch_runs`, and
`dispatch_decision_traces` cascades from `recommendations` — but the trace's `run_id` FK has **no**
`onDelete`, so deleting a run with traces would be restricted. Meanwhile `recommendations.run_id`,
`work_schedules.run_id` and `plant_batch_assignments.run_id` are all `SetNull`. A run is not simply
deletable.

---

## 24. API Inventory

**32 scheduler-relevant endpoints across 8 controllers.** All prefixed `/api`. All behind
`AuthGuard` + `RoleGuard`. `MANAGER_ROLES = ['ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD']`.

### 24.1 `SchedulesController` — `/api/schedules` (`schedules.controller.ts`)

| # | Method | Route | Roles | Acting-zone aware | Mutates |
|---|---|---|---|:--:|:--:|
| 1 | GET | `/dispatch-schedule` | OH | ✗ | ✗ |
| 2 | PUT | `/dispatch-schedule` | OH | ✓ (`CurrentActor`) | ✓ |
| 3 | POST | `/dispatch-run` | OH, CSM | ✗ | ✓ |
| 4 | GET | `/dispatch-run/in-flight` | OH, CSM | ✗ | ✗ |
| 5 | POST | `/bulk-unassign` | **OH only** | ✗ | ✓ (EXECUTE) |
| 6 | GET | `/bulk-unassign/history` | **OH only** | ✗ | ✗ |
| 7 | GET | `/preview?date=` | MANAGER | ✗ (claims only) | ✗ |
| 8 | POST | `/holds` | MANAGER | ✓ | ✓ |
| 9 | POST | `/holds/release` | MANAGER | ✓ | ✓ |
| 10 | GET | `/me` | **SERVICE_ENGINEER** | n/a | ✗ |
| 11 | POST | `/assign` | MANAGER | ✓ | ✓ |
| 12 | POST | `/assign-plants` | MANAGER | ✓ | ✓ |
| 13 | POST | `/assign-batch` | MANAGER | ✓ | ✓ |
| 14 | GET | `/?date=` | MANAGER | ✗ | ✗ |
| 15 | GET | `/engineers` | MANAGER | ✗ | ✗ |
| 16 | GET | `/assignable-work` | MANAGER | ✓ | ✗ |
| 17 | GET | `/candidates?plantIds=` | MANAGER | ✓ | ✗ |
| 18 | GET | `/assignable-tickets?plantIds=` | MANAGER | ✓ | ✗ |
| 19 | POST | `/distribute-preview` | MANAGER | ✓ | ✗ |
| 20 | GET | `/:engineerId` | MANAGER | ✗ | ✗ |

⚠ **Route ordering is load-bearing.** Every static path (1, 6, 7, 15, 16, 17, 18) is declared before
`GET /:engineerId`, or it would be captured as a param. Pinned by
`test/schedules-route-conflicts.e2e-spec.ts`.

⚠ **Acting-zone is inconsistent.** `scopeFor(user, actor)` (`:79-83`) collapses an acting CSM/OH into
`{role:'ZONAL_MANAGER', zoneId: actingZone}`. It is applied on 2, 8, 9, 11, 12, 13, 16, 17, 18, 19 —
and **not** on 7 (`preview`), 14 (`list`), 15 (`engineers`) or 20 (`detail`), which build scope
straight from claims. #239 owns the sweep; the divergence is live today. **An Operations Head acting
in a zone sees that zone's work pool but a pan-India preview.**

### 24.2 `DispatchRunsController` — `/api/dispatch-runs` (`dispatch-runs.controller.ts`)

| # | Method | Route | Roles | Cross-zone refusal style |
|---|---|---|---|---|
| 21 | GET | `/?limit=` | MANAGER | list is clamped, not refused |
| 22 | GET | `/:runId` | MANAGER | zone cards filtered |
| 23 | GET | `/:runId/zones/:zoneId` | MANAGER | **403** `ZONE_SCOPE_VIOLATION` — global `ZoneScopeGuard` |
| 24 | GET | `/:runId/decisions?zoneId&limit&offset` | MANAGER | **403** `ZONE_SCOPE_VIOLATION` — raised by the service (camelCase param, the guard does not fire) |
| 25 | GET | `/:runId/tickets/:ticketId/trace` | MANAGER | **404** `DISPATCH_TRACE_NOT_FOUND` — no `:zoneId`, service-level clamp |

The controller docstring (`:31-39`) states each route's **actual** behaviour "rather than promising a
uniform rule the platform prevents." `parseId` maps a malformed id to a 404, never a 500 (`:124-132`).

### 24.3 `BatchesController` — `/api/batches` (`batches.controller.ts`)

| # | Method | Route | Roles |
|---|---|---|---|
| 26 | GET | `/:batchId` | MANAGER |
| 27 | POST | `/:id/override/preview` | ZM, CSM, OH |
| 28 | POST | `/:id/override` | ZM, CSM, OH |

A batch is addressed **by its own id, not via its run** (`dispatch-runs.controller.ts:25-27`):
"most live batches have no `run_id` and a run-scoped path left them unreachable."

### 24.4 `DispatchTodayController` — `/api/dispatch` (`dispatch-today.controller.ts`)

| # | Method | Route | Roles | Notes |
|---|---|---|---|---|
| 29 | GET | `/today?zoneId=` | MANAGER | `@CurrentScope()` — the acting-zone standard |
| 30 | GET | `/changes-today?zoneId=` | MANAGER | ↑ |

**Read-only by contract** (`:19-22`): "the cockpit's writes go to the endpoints that already own
them… because #282 R5 forbids a second implementation of anything the engine already does."

`parseZoneId` (`:54-63`): a ZM need not name a zone; **anyone broader must** — 400 `ZONE_REQUIRED`,
"because there is no honest default — 'all zones' is not a cockpit, it is a different product."
Non-integer → 400 `INVALID_FILTER`.

### 24.5 `IntradayInsertionController` — `/api/intraday-insertions`

| # | Method | Route | Roles |
|---|---|---|---|
| 31 | GET | `/` | MANAGER |
| 32 | POST | `/fire` | MANAGER |
| 33 | GET | `/:id/available-ses` | MANAGER |
| 34 | POST | `/:id/manual-assign` | MANAGER |

`accept`, `decline` and `sweep-timeouts` **are gone** with the offer machinery (#268) —
`intraday-insertion.controller.ts:34-36`.

### 24.6 `IntradayUpdatesController` — `/api/intraday-updates`

| # | Method | Route | Roles |
|---|---|---|---|
| 35 | GET | `/` | MANAGER |
| 36 | POST | `/add` | MANAGER |
| 37 | POST | `/remove` | MANAGER |
| 38 | POST | `/reorder` | MANAGER |

⚠ **No admin code calls these** — §5.10.

### 24.7 `SePlannerController` — `/api/planner`

| # | Method | Route | Roles |
|---|---|---|---|
| 39 | GET | `/?dateFrom&dateTo` | MANAGER |
| 40 | GET | `/plants` | MANAGER |
| 41 | POST | `/` | MANAGER |
| 42 | DELETE | `/:id` | MANAGER |

### 24.8 Config surfaces the scheduler UI needs

| # | Method | Route | Roles | Purpose |
|---|---|---|---|---|
| 43 | GET | `/api/org/scoring-weights?weightSetRef=` | **OH only** | list weights |
| 44 | POST | `/api/org/scoring-weights` | **OH only** | upsert; validates against `SCORING_COMPONENTS` |
| 45 | GET | `/api/org/scoring-weights/components` | **OH only** | the closed vocabulary |
| 46 | PUT | `/api/settings/assignment-threshold` | OH/CSM | the specialised writer |
| 47 | GET/PUT | `/api/settings/:key` | OH | generic; **refuses** `dispatch_cron` and `se_assignment_threshold_hours` |

`SPECIALISED_SETTING_WRITERS` (`settings/settings.service.ts`) maps each refused key to the endpoint
that owns it, so the UI can route the operator correctly.

### 24.9 SE-facing

| # | Method | Route | Roles |
|---|---|---|---|
| 48 | GET | `/api/schedules/me` | SERVICE_ENGINEER |
| 49 | GET | `/api/me/shared-pool` | SERVICE_ENGINEER |

Both are scoped to the caller's own id server-side, "never an arbitrary se param"
(`shared-pool.controller.ts:21-22`).

---

## 25. API Request / Response Contracts

Shapes below are **extracted from the TypeScript interfaces and the code that builds them**, not
invented. Field-by-field.

### 25.1 `GET /api/schedules/dispatch-schedule` → `DispatchScheduleView`

```json
{ "cron": "0 5 * * *", "timeZone": "Asia/Kolkata", "nextFireAt": "2026-08-27T05:00:00.000Z" }
```
`dispatch-schedule.service.ts:22-27`. `nextFireAt` is absolute "so an operator can confirm the change
took, not just that it saved."

**`PUT`** body `{ cron: string }` → same shape, or **400**
`{ code:'INVALID_CRON_EXPRESSION', reason: "<the parser's own message>" }`.

**The validator is the parser that will run it** (`dispatch-cron.ts:122-131`) — `CronTime` is taken
off the live job instance rather than imported, so "a separately-resolved `cron` could accept an
expression the scheduler then rejects, which is exactly the accepted-then-silently-dead schedule #213
exists to prevent." Note it accepts **any** valid expression including `* * * * *`; narrowing the
sensible range is explicitly not ruled on.

### 25.2 `POST /api/schedules/dispatch-run` → `DispatchRunSummary`

```json
{
  "zones": 3,
  "schedules": 12,
  "tickets": 47,
  "errors": [ { "zoneId": "5", "message": "…" } ],
  "runId": "1284",
  "zoneOutcomes": [
    { "zoneId": "3", "outcome": "DONE" },
    { "zoneId": "5", "outcome": "ERROR" },
    { "zoneId": "7", "outcome": "CONTENDED",
      "holder": { "zoneId":"7", "startedAt":"2026-08-26T05:00:02.000Z",
                  "trigger":"CRON", "actor":"SYSTEM", "runId":"1283" } }
  ]
}
```
`dispatch-run.service.ts:111-128`, `:72-85`, `:92-100`.

- `runId` is a **string** — "bigint does not survive JSON serialization" (`:120`).
- `zones` **excludes contended zones**; `zoneOutcomes` includes **every requested zone**. Without
  the latter "a caller could not tell a three-zone run that dispatched three zones from a four-zone
  run that was refused one" (`:122-126`).
- `holder.actor` is `actor_role` or the literal `'SYSTEM'` for the cron (`:480-482`).

**409:** `{ code:'DISPATCH_ALREADY_RUNNING', message:"dispatch already running for this zone (zone 7, started 05:00 IST by SYSTEM)", inFlight: DispatchInFlight[] }`.

### 25.3 `GET /api/schedules/dispatch-run/in-flight`

```json
{ "inFlight": [ { "zoneId":"7", "startedAt":"…Z", "trigger":"CRON", "actor":"SYSTEM", "runId":"1283" } ] }
```

### 25.4 `GET /api/dispatch-runs` → `DispatchRunListRow[]`

```json
[{
  "runId":"1284", "trigger":"CRON", "actorRole":null, "actorName":null,
  "startedAt":"2026-08-26T05:00:00.000Z", "finishedAt":"2026-08-26T05:04:11.000Z",
  "durationMs":251000, "status":"PARTIAL",
  "zones":3, "schedules":12, "batches":19, "ticketsDispatched":47,
  "recommended":51, "unassignable":6, "errorCount":1
}]
```
`dispatch-transparency-query.service.ts:8-26`.

**For a ZONAL_MANAGER the totals are their own zone row's totals** (`:348-362`) — `zones` is
`1` or `0`, and **`0` when the zone row is CONTENDED**, because "counting it as a processed zone would
tell the ZM their zone was worked and produced nothing, when in fact it was not worked at all."

`limit`: `1..100`, default **30** (`dispatch-runs.controller.ts:49-50`).

### 25.5 `GET /api/dispatch-runs/:runId` → `DispatchRunDetail`

```json
{
  "runId":"1284", "trigger":"MANUAL",
  "actorUserId":"…uuid", "actorRole":"OPERATIONS_HEAD", "actorName":"A. Rao",
  "reason":"post-outage catch-up",
  "startedAt":"…Z", "finishedAt":"…Z", "durationMs":251000, "status":"PARTIAL",
  "schedules":12, "batches":19, "ticketsDispatched":47, "recommended":51, "unassignable":6,
  "errorCount":1,
  "configSnapshot": { /* §7.7 */ },
  "build": { "buildVersion":"41", "buildFingerprint":"abc123",
             "staleBuild":false, "currentVersion":"41", "currentFingerprint":"abc123" },
  "zones": [{
    "zoneId":"3", "zoneName":"West",
    "mode":"DEFICIT", "weightSetRef":"v1",
    "ticketsConsidered":22, "recommended":19, "unassignable":3,
    "unassignableReasons": { "NO_COVERAGE":1, "ALL_DROPPED":2,
                             "dropBuckets": { "OVER_CAPACITY":5, "SE_UNAVAILABLE":2 } },
    "schedules":4, "batches":7, "ticketsDispatched":19,
    "error":null, "outcome":"DONE", "contendedWithRunId":null,
    "seSkips":[ { "seId":"…", "reason":"ZONE_LOCK_TIMEOUT: …", "constraint":null } ],
    "withheldBelowThreshold":140,
    "bucketlessDropped":512,
    "componentBlockedWithheld":8,
    "ticketsStillAssigned":17, "ticketsRemovedSince":2
  }]
}
```
`dispatch-transparency-query.service.ts:28-109`.

`build` is `null` for a run predating #130, or when `runtime_lock` has no row.
`bucketlessDropped` / `componentBlockedWithheld` are `null` when the zone's recommender threw.

### 25.6 `GET /api/dispatch-runs/:runId/zones/:zoneId` → `DispatchZoneDetail`

```json
{
  "runId":"1284",
  "zone": { /* the same DispatchRunZoneCard as above */ },
  "batches": [{
    "batchId":"901","scheduleId":"455","seId":"…uuid","seName":"R. Iyer",
    "plantId":"12","plantName":"Bhilai-3","companyName":"Acme +2",
    "stopSequence":1,"status":"AUTO_ASSIGNED","ticketCount":4,
    "capacityUsed": { "used":5, "cap":6 }
  }],
  "unassignable": [{
    "ticketId":"…uuid","deviceId":"D-991","plantId":"12","plantName":"Bhilai-3",
    "companyName":"Acme","poolEmptyReason":"ALL_DROPPED",
    "dropCounts": { "OVER_CAPACITY":3 }
  }],
  "plantStats": { "12": { "totalDevices":38,"inactiveDevices":9,
                          "assignedDevices":6,"unassignedDevices":3 } }
}
```
`:111-162`.

`companyName` uses `distinctLabel` — one distinct value → that value; several → `"first +N"`; none →
`null` (`:923-932`).

`plantStats.assignedDevices/unassignedDevices` **exclude resolved tickets** (`:618-622`) — "a finished
ticket is neither assigned work nor outstanding work."

Batch attribution: `OR: [{ runId }, { runId: null, schedule: { runId } }]` (`:493-497`) — the second
leg attributes legacy batches via their schedule; "those schedules are unshared, so exactly one leg
matches per batch."

### 25.7 `GET /api/dispatch-runs/:runId/decisions` → `DispatchRunDecisions`

```json
{ "runId":"1284", "total":340, "limit":100, "offset":0,
  "rows": [{
    "ticketId":"…uuid","zoneId":"3","processingRank":1,"status":"DISPATCHED",
    "seId":"…uuid","seName":"R. Iyer","plantId":"12","plantName":"Bhilai-3",
    "deviceId":"D-991","companyTier":"PLATINUM","deviceBucket":"LONG_PENDING",
    "poolEmptyReason":null,"candidatesTotal":4,"passedCount":2
  }] }
```
`:242-270`.

**Ordered by `processing_rank` asc, `traceId` asc.** The tie-break is required for stable paging:
"`processing_rank` is per zone, so a multi-zone run has as many rank 1s as it had zones, and two
pages of an unstably-ordered query can drop a row and repeat another" (`:820-822`).

Driven from `dispatch_decision_traces`, **not** `recommendations` (`:782-789`): the trace carries a
denormalised `zone_id` (making the clamp a predicate, not a join) and the recommender writes one
trace per decision **including unassignable ones**. "An unassignable decision is a decision: leaving
it out would show a run doing less than it did."

`limit` default **100**, max **500** (`:911-912`) — "a caller asking for more is asking for an export,
which is a different endpoint's job."

### 25.8 `GET /api/dispatch-runs/:runId/tickets/:ticketId/trace` → `DispatchTicketTrace`

```json
{
  "runId":"1284","ticketId":"…uuid","seId":"…uuid",
  "trace": { /* §34.1 — the full JSONB */ },
  "scoreBreakdown": { /* the recommendation's own */ },
  "recStatus":"DISPATCHED",
  "seNames": { "<seId>":"R. Iyer", "<seId2>":"S. Kaur", "<seId3>":null },
  "identity": { "deviceId":"D-991","vehicleNo":"MH12AB1234",
                "plantName":"Bhilai-3","companyName":"Acme","transporterName":"TransCo" }
}
```
`:215-232`. `seNames` covers **chosen + every runner-up** so the UI shows names, not UUIDs
(`:886-899`).

### 25.9 `GET /api/batches/:batchId` → `DispatchBatchDetail`

```json
{
  "runId":"1284"|null, "batchId":"901","scheduleId":"455","zoneId":"3",
  "seId":"…","seName":"R. Iyer","plantId":"12","plantName":"Bhilai-3",
  "rows": [{
    "ticketId":"…","deviceId":"D-991","companyName":"Acme",
    "vehicleNo":"MH12AB1234","transporterName":"TransCo",
    "deviceType":"VT-10","imsiNo":"4041…",
    "latestGpsDatetime":"…Z","tripCreationDatetime":"…Z",
    "plantId":"12","seId":"…","sortOrder":1,
    "rank":1, "score":0.83, "scoreDegenerate":false,
    "recStatus":"DISPATCHED","ticketStatus":"OPEN","hasTrace":true
  }]
}
```
`:164-213`. `runId` is `null` for a manual plan and — **since #283** — for a `SYSTEM_GENERATED`
schedule the intraday CRITICAL sweep created, "which is the engine's work but not a *run's*"
(`:200-204`).

### 25.10 `GET /api/schedules/preview` → `SchedulerPreviewResult`

```json
{
  "targetDate":"2026-08-27",
  "zones": [ /* ZoneProjection[] — §31.1 */ ],
  "holds": [{ "ticketId":"…","heldUntil":"2026-08-29","zoneId":"3",
              "plantName":"Bhilai-3","deviceId":"D-991" }],
  "bucketsAsOf":"2026-08-26T04:31:00.000Z",
  "previewToken":"<base64url>.<base64url>",
  "errors":[ { "zoneId":"5","message":"…" } ]
}
```
`scheduler-preview.service.ts:42-57`.

**`bucketsAsOf` is the OLDEST watermark across zones, deliberately** (`:47-51`): "the caveat has to
describe the staleness of the whole picture, and a newest-wins figure would understate it whenever
one zone lagged."

### 25.11 `POST /api/schedules/holds`

Body `{ ticketId, heldUntil:"YYYY-MM-DD", reasonCode, confirm? }`.

| Status | Body |
|---|---|
| 200 | `{ result:'OK', ticketId, heldUntil:"2026-08-29" }` |
| 400 | `{ code:'INVALID_HOLD', message:'ticketId, heldUntil and reasonCode are required.' }` |
| 400 | `{ code:'INVALID_DATE', message:'heldUntil must be YYYY-MM-DD.' }` |
| 404 | `{ code:'TICKET_NOT_FOUND' }` |
| 409 | `{ code:'TICKET_NOT_HOLDABLE', result:'NOT_HOLDABLE', status, assignmentState }` |
| 409 | `{ code:'CONFLICT_VEHICLE_UNAVAILABLE', result:…, expectedFrom, reportId }` |

`POST /api/schedules/holds/release` → `{ result:'OK', ticketId }` \| 404 `TICKET_NOT_FOUND` \|
200 `{ result:'NOT_HELD' }`.

⚠ `NOT_HELD` is returned as a **200 body**, not a 4xx (`schedules.controller.ts:348-354`).

### 25.12 `POST /api/batches/:id/override/preview` → `OverrideImpact`

```json
{
  "result":"OK","action":"REASSIGN",
  "batchId":"901","plantId":"12","plantName":"Bhilai-3",
  "ticketIds":["…"],
  "from": { "seId":"…","seName":"R. Iyer","committed":2,"after":1,
            "dailyCapacity":8,"overCapacity":false },
  "to":   { "seId":"…","seName":"S. Kaur","committed":0,"after":1,
            "dailyCapacity":8,"overCapacity":false },
  "rank": { "ticketId":"…","runId":"1284","processingRank":3,
            "chosenSeId":"…","targetPrecedenceRank":2,
            "targetVerdict":"PASSED","targetDropReason":null },
  "route": { "targetScheduleId":"460","appendedAsStop":3,
             "joinsExistingStop":false,"reordersExistingStops":false },
  "conflicts": { "onSite":[], "deferred":[] }
}
```
`override-projection.service.ts:9-86`.

- `rank` is `null` when there is nothing to say — hand-placed ticket, pre-trace run, or the target
  was not in the pool. **"Null is *unknown*, never *unranked*"** (`:29-30`).
- `targetVerdict` is `'CHOSEN'` when the target *is* the winner (`:236`) — a fourth value the trace
  itself never uses.
- `reordersExistingStops` is **always `false`**, stated rather than assumed (`:53-59`): "a projection
  that merely omitted the question would leave the promise unverifiable."
- `conflicts.onSite` reads **empty today** — the soft-state seam.

### 25.13 `POST /api/schedules/distribute-preview` → `DistributeResult`

```json
{
  "strategy":"CAPACITY_HEADROOM","targetDate":"2026-08-26",
  "lanes": [ { "seId":"…","plants":[{ "plantId":"12","ticketIds":["…","…"] }] } ],
  "unplaced": [ { "ticketId":"…","plantId":"19","reason":"NO_COVERAGE" } ],
  "overCapacitySeIds": ["…"]
}
```
`distribute-projection.service.ts:12-32`. `reason` ∈ `NO_COVERAGE` \| `ALL_DROPPED`.

### 25.14 `GET /api/schedules/assignable-work` → `AssignableWorkView`

```json
{
  "date":"2026-08-26",
  "totals": { "openUnassigned":312, "criticalCount":88, "heldCount":14, "plants":27 },
  "companies": [{
    "companyId":"7","companyName":"Acme",
    "plants":[{ "plantId":"12","plantName":"Bhilai-3","zoneId":"3",
                "openUnassigned":22,"totalDevices":38,"criticalCount":9,
                "oldestInactivityHours":141.5,"heldCount":2 }]
  }]
}
```
`assignable-work-query.service.ts:9-36`. Companies sorted by total open work desc, then name; plants
likewise — "the operator's eye should land on the work, not on an alphabet."

**Grouped by (company, plant), not plant** (`:47-52`): `plants` carries no `company_id`, several
companies' vehicles sit at one site, and the tier that decides dispatch priority is a *company*
attribute.

### 25.15 `GET /api/schedules/candidates?plantIds=1,2,3` → `CandidatesView`

```json
{
  "date":"2026-08-26",
  "plants": [{
    "plantId":"12","plantName":"Bhilai-3","zoneId":"3",
    "candidates": [{
      "seId":"…","name":"R. Iyer","coverageType":"DEDICATED","tierRank":1,
      "verdict":"PASSED","dropReason":null,
      "committed":4,"dailyCapacity":6,
      "availabilityStatus":"AVAILABLE","kitComplete":true,"missingKit":[]
    },{
      "seId":"…","name":"S. Kaur","coverageType":"FLOATING","tierRank":3,
      "verdict":"DROPPED","dropReason":"COMMON_KIT_INCOMPLETE",
      "committed":1,"dailyCapacity":6,
      "availabilityStatus":"AVAILABLE","kitComplete":false,"missingKit":["Antenna","SIM"]
    }]
  }]
}
```
`candidate-query.service.ts:17-52`.

**Order is the engine's order, untouched** (`:62-64`): "sorting for the operator's convenience would
render a ranking the engine does not use." **Dropped candidates are returned, not filtered**
(`:74-77`): "the operator's question at this column is 'why not them', and an empty list is the least
useful possible answer."

`parsePlantIds` is **lenient** — an unparseable id is dropped, not 400'd
(`schedules.controller.ts:86-100`).

### 25.16 `GET /api/dispatch/today` → `DispatchTodayView`

```json
{
  "operatingDay":"2026-08-26",
  "zone": { "zoneId":"3","name":"West" },
  "run": { "runId":"1284","status":"PARTIAL","trigger":"CRON",
           "startedAt":"…Z","finishedAt":"…Z" },
  "recovery": { "state":"RECOVERED","attempts":1,"markedAt":"…Z",
                "lastAttemptAt":"…Z","lastError":null },
  "engineers": [{
    "seId":"…","name":"R. Iyer","coverageType":"DEDICATED",
    "committed":5,"dailyCapacity":6,"overCapacity":false,
    "availability":"AVAILABLE","scheduleId":"455","scheduleStatus":"ACTIVE",
    "stops":[{
      "batchId":"901","stopSequence":1,"plantId":"12","plantName":"Bhilai-3",
      "status":"AUTO_ASSIGNED","runId":"1284",
      "tickets":[{ "ticketId":"…","sortOrder":1,"slaBucket":"CRITICAL",
                   "companyTier":"PLATINUM","addSource":"AUTO_DISPATCH",
                   "addedBy":null,"addReason":null,
                   "coverageTypeAtAssign":"DEDICATED",
                   "systemPlaced":true,"returnDueToday":false }]
    }]
  }],
  "situation": { "placed":47,"unassignable":6,"held":14,
                 "criticalNeedsYou":2,"overCapacity":1,"changesToday":5 },
  "rails": {
    "unassignable":[ { "ticketId":"…","deviceId":"D-991","plantId":"12",
                       "plantName":"Bhilai-3","poolEmptyReason":"NO_COVERAGE" } ],
    "held":[ { "ticketId":"…","deviceId":"D-882","plantName":"Bhilai-3",
               "heldUntil":"2026-08-29","expectedFrom":"…Z","decidedBy":"…uuid" } ],
    "policyWithheld": { "count":140, "itemised": false }
  },
  "escalations": [{
    "insertionId":"77","ticketId":"…","slaBucket":"HIGH_CRITICAL","createdAt":"…Z",
    "insertionType":"SE_UNAVAILABLE","assignedSeId":"…","assignedSeName":"R. Iyer"
  }]
}
```
`dispatch-today-query.service.ts:11-150`.

**`policyWithheld.itemised: false` is a contract, not a placeholder** (`:139-147`): "the engine counts
it and never itemises it — those tickets get no recommendation, no UNASSIGNABLE row and no trace, so
there is nothing to list. Publishing a fabricated list here, or silently showing a count that looks
like a truncated list, is exactly what #282 R6 forbids."

**A lane is present even when the engineer has nothing today** — "an empty lane is a fact" (`:39`).

**`escalations[].assignedSeId` decides which button to offer** (`:120-125`): non-null means the
queue's Assign **cannot** resolve it (`assignTicket` refuses an assigned ticket) and the door that
works is a reassign on that engineer's day plan.

### 25.17 `GET /api/dispatch/changes-today` → `DispatchChangesTodayView`

```json
{
  "operatingDay":"2026-08-26","zoneId":"3",
  "counts": { "adds":3,"removes":1,"swaps":1,"total":5 },
  "changes": [{
    "kind":"SWAP","ticketId":"…","actorId":"…uuid","at":"…Z",
    "reason":"engineer sick","toSeId":"…","fromSeId":"…","via":"MANUAL_REASSIGN"
  }]
}
```
`dispatch-changes-today.service.ts:8-29`.

**A swap counts once** (`:47-50`) — the source row (`REASSIGNED`) and destination row
(`MANUAL_REASSIGN`/`MANUAL_SPLIT`) are paired by ticket within the window. **Only a move's
*destination* row pairs** (`:99-105`): "an operator who assigns a ticket in the morning and moves it
after lunch has made two decisions, and the earlier plain assign is an ADD in its own right."

**The engine's own dispatch is excluded** by `addedBy: { not: null }` (`:71-74`): "the morning run
placing 200 tickets is not 200 'changes today'."

Ordering ties break on the row's autoincrement `id` (`:92-95`): "two changes written under one frozen
clock share an instant to the millisecond, and insertion order is the only thing that still
distinguishes 'assigned, then moved' from 'moved, then assigned'."

### 25.18 `GET /api/schedules/me` → `DayPlanView` (SE)

```json
{ "dispatched": true, "scheduleId":"455", "dateFrom":"2026-08-26","dateTo":"2026-08-26",
  "stops":[{ "batchId":"901","stopSequence":1,"plantId":"12","plantName":"Bhilai-3",
             "deviceCount":4,
             "tickets":[{ "ticketId":"…","sortOrder":1 }] }] }
```
Empty state: `{ "dispatched": false, "scheduleId": null, "dateFrom": null, "dateTo": null, "stops": [] }`
(`day-plan-query.service.ts:9`).

**Hollow stops are omitted, not shown empty** (`:55-57`) — a batch whose tickets were all removed
"would render above the SE's real remaining work with deviceCount 0."

### 25.19 `GET /api/schedules` → `ZmScheduleRow[]`, `GET /api/schedules/:engineerId` → `ZmScheduleDetail`

```json
[{ "scheduleId":"455","seId":"…","seName":"R. Iyer","zoneId":"3","zoneName":"West",
   "dateFrom":"2026-08-26","dateTo":"2026-08-26","status":"ACTIVE",
   "batchCount":3,"ticketCount":11 }]
```

⚠ **`GET /api/schedules` has no date filter unless you pass one** (`zm-schedule-query.service.ts:100-112`):
"this read has never had a date predicate: it filters on live status alone, so a never-closed plan
from last week comes back beside today's while the nav row, the page copy and `DispatchTimelineNote`
all promise 'today'." `?date=` is **additive, never a new default** — "making 'today' the default
would silently narrow every existing caller, which is a behaviour change wearing a bugfix's clothes."

**The frontend must pass `?date=` on any surface that says "today".**

Detail adds per-stop `tickets[]` with `{ ticketId, sortOrder, slaBucket, companyTier,
partialRecovery, reasoning: { companyTier, deviceBucket, companyPriorityRank, clusterMultiplier } | null }`.

⚠ `getScheduleDetail` picks `findFirst({ status: LIVE, zoneFilter }, orderBy: dispatchedAt desc)`
with **no date predicate** (`:147-150`) — unlike `listSchedules`, which now accepts one. A ZM opening
an engineer's detail can be shown a stale plan.

### 25.20 `GET /api/schedules/engineers` → `ZoneEngineerRow[]`

```json
[{ "engineerId":"…","name":"R. Iyer","coverageType":"DEDICATED","zoneId":"3",
   "committed":4,"dailyCapacity":6,"isActive":true }]
```
**The load is deliberately NOT zone-filtered** (`zm-schedule-query.service.ts:216-218`):
"`daily_capacity` caps the engineer's day, and a floating SE's work in a neighbouring zone is still
work they have to do."
---

## 26. Frontend Data Contract

### 26.1 The rule set a frontend developer must internalise

1. **BigInt ids are strings on the wire.** Every id (`runId`, `zoneId`, `batchId`, `scheduleId`,
   `plantId`, `insertionId`) is `String(...)`-ed at the boundary. `ticketId` and `seId` are UUIDs.
   Never parse an id as a number.
2. **Dates are ISO instants except day-scoped ones.** `startedAt`/`finishedAt`/`createdAt`/`at` are
   `toISOString()`. `operatingDay`, `targetDate`, `date`, `heldUntil`, `dateFrom`, `dateTo`,
   `plannedDate` are `YYYY-MM-DD` (via `.toISOString().slice(0,10)`) and mean **IST calendar days**.
3. **`null` is a value with meaning.** §1.5.
4. **Never render `mode`.** `DEFICIT`/`PREVENTIVE` map to plain language in one util
   (`soft-inactive-count.service.ts:11-13`).
5. **Never render `NOT_ENFORCED` as a pass** (`hard-filters.ts:41-43`).
6. **Never render a NULL `addSource` as a system decision** (`add-source.ts:108-114`).
7. **Never render `distanceKm: "NOT_AVAILABLE"` as 0** (`distance.ts:8-11`).
8. **Zone scoping is server-side.** Do not filter client-side for security. Do handle 403/404/omission
   per §38.4.
9. **`scoreDegenerate: true` ⇒ hide numeric scores**, explain in precedence terms.
10. **Overload is shown, never blocked** on manual paths (§17.4).

### 26.2 Read/refresh model

| Data | Changes when | Suggested refresh |
|---|---|---|
| run list / run detail | a run starts or finalises | poll while any run is `RUNNING`; otherwise on demand |
| in-flight zones | a run admits or finalises a zone | poll while the Run-dispatch button is visible |
| `/dispatch/today` | any assign/override/dispatch/escalation | refetch after **every** mutation; poll during the 05:00 window |
| `/dispatch/changes-today` | any human add/remove/swap | refetch with the cockpit |
| `/schedules/preview` | continuously (it re-runs the engine live) | on demand + on `previewToken` staleness |
| `/schedules/candidates` | availability, capacity, kit, coverage | refetch when the plant selection changes and after a commit |
| `/schedules/assignable-work` | ticket creation, assignment, holds | refetch after a commit |
| decision trace | never (append-only per run) | cache indefinitely per (runId, ticketId) |
| `config_snapshot` | never (frozen) | cache indefinitely per runId |

### 26.3 The mutation → invalidation map

| Mutation | Invalidate |
|---|---|
| `POST /schedules/dispatch-run` | run list, run detail, in-flight, today, changes-today, assignable-work, schedules list |
| `POST /schedules/assign` \| `assign-batch` \| `assign-plants` | today, changes-today, assignable-work, candidates, schedules, `/schedules/:engineerId` |
| `POST /batches/:id/override` | today, changes-today, batch detail, schedules detail, engineers (committed) |
| `POST /schedules/holds` \| `holds/release` | preview (holds + counts), today (held rail), assignable-work (heldCount) |
| `POST /intraday-insertions/:id/manual-assign` | intraday list, today (escalations + lanes) |
| `POST /schedules/bulk-unassign` (EXECUTE) | **everything** |
| `PUT /schedules/dispatch-schedule` | dispatch-schedule |
| `POST /org/scoring-weights` | scoring weights; **future** runs only — past `config_snapshot`s are frozen |
| `POST /planner` \| `DELETE /planner/:id` | planner grid; affects the **next** run only |

---

## 27. Scheduler Dashboard Data

**`EXPECTED_BUT_NOT_FOUND` as a single endpoint.** There is no fleet-wide scheduler dashboard read.
The closest surface, `GET /api/dispatch/today`, is **single-zone** and 400s for a multi-zone role that
does not name one.

### 27.1 What a dashboard needs, and where each piece actually is

| Needed | Available? | Source |
|---|---|---|
| current run status | ✓ per zone | `GET /api/dispatch/today` → `run.status` |
| current run status, fleet-wide | ✓ | `GET /api/dispatch-runs?limit=1` → `rows[0].status === 'RUNNING'` |
| last successful run | ⚠ **client-side derivation** | `GET /api/dispatch-runs?limit=30`, first row with `status === 'SUCCESS'`. No server-side filter exists. |
| next run | ✓ | `GET /api/schedules/dispatch-schedule` → `nextFireAt` (**OH only** ⚠) |
| number of tickets considered | ✓ per zone card | `ticketsConsidered` |
| assigned | ✓ | `recommended` / `ticketsDispatched` |
| unassigned | ✓ | `unassignable` |
| deferred / held | ⚠ **not on the run ledger** | `/dispatch/today` → `situation.held`; or `/schedules/assignable-work` → `totals.heldCount` |
| capacity | ⚠ per engineer only | `/dispatch/today` → `engineers[].dailyCapacity`; or `/schedules/engineers` |
| utilization | ✗ **compute client-side** | `Σcommitted / Σ dailyCapacity` |
| zone status | ✓ | run detail `zones[].outcome` |
| failures | ✓ | `errorCount`, `zones[].error`, `zones[].seSkips` |
| warnings | ⚠ **partly log-only** | MV staleness is in `config_snapshot.eligibilityMv.stale`; the log warning is not exposed |
| stale data | ⚠ | `bucketsAsOf` **only on previews**; `config_snapshot.eligibilityMv` on runs |
| recovery status | ✓ per zone | `/dispatch/today` → `recovery` |

### 27.2 The realistic composition

A pan-India scheduler dashboard must fan out:

```
GET /api/dispatch-runs?limit=30           → run history, current status, last SUCCESS
GET /api/dispatch-runs/{latestRunId}      → per-zone cards (the funnel, per zone)
GET /api/schedules/dispatch-schedule      → next fire        [OPERATIONS_HEAD ONLY]
GET /api/schedules/dispatch-run/in-flight → live zones       [OH/CSM ONLY]
GET /api/dispatch/today?zoneId=N          → per zone, N times
```

⚠ **Role asymmetry breaks the composition for a ZM.** `dispatch-schedule` and `in-flight` are
OH/CSM-only, so a Zonal Manager's dashboard cannot show "next run" or "a run is in flight" at all.
→ §39.

---

## 28. Ticket Assignment UI Data

For **one ticket**, everything needed to answer "why this SE, and why not the others."

### 28.1 The single call

```
GET /api/dispatch-runs/:runId/tickets/:ticketId/trace
```

### 28.2 Field-by-field mapping

| UI question | Field | Notes |
|---|---|---|
| why was it selected | `trace.chosen.score` + `.breakdown` + `.tierEvaluated` + `.precedenceRank` | breakdown = `{rankScore, urgency, repeatPenalty, ageScore, distanceScore, distanceKm, weights, baseScore, clusterMultiplier}` |
| why was it **not** selected (unassignable) | `trace.poolEmptyReason` + `trace.dropCounts` | `NO_COVERAGE` ⇒ Ops; `ALL_DROPPED` ⇒ read the counts |
| candidate engineers | `trace.runnersUp[]` (≤5) + `trace.chosen` | **`candidatesTotal` may exceed 6** — the rest are counts only |
| candidate tiers | `runnersUp[].coverageType`, `chosen.coverageType` | |
| hard-filter results | `runnersUp[].filterStates[]`, `chosen.filterStates[]` | tri-state, in evaluation order |
| score components | `chosen.breakdown` | runner-up breakdowns are **not** stored — only their `score` |
| final score | `chosen.score` | |
| winner | `trace.seId`, `chosen.seId`, `seNames[seId]` | |
| planner pin | `chosen.plannerPlanned` / `.plannerBias`; `runnersUp[].plannerPlanned` | §18.4 |
| rejected candidates | `runnersUp[].verdict === 'DROPPED'` + `.dropReason` | |
| rejection reasons | `.dropReason` per candidate; `dropCounts` pool-wide | |
| rank | `recommendations.processingRank` — via `/decisions` or `/batches/:id` `rows[].rank` | ⚠ **not on the trace itself** |
| capacity impact | `chosen.capacityAtDecision {used, cap}` | at that moment, not now |
| route impact | `chosen.clusterSeed` | **no stop number** — see below |
| filters not enforced | `trace.notEnforcedFilters[]` | render as "not evaluated" |
| ticket identity | `identity{deviceId, vehicleNo, plantName, companyName, transporterName}` | "read context without navigating away" |
| current state | `recStatus` | `DISPATCHED`\|`SUGGESTED`\|`UNASSIGNABLE`\|`RETIRED` |

### 28.3 What this endpoint does **not** give you

| Missing | Workaround |
|---|---|
| `processingRank` | fetch `/decisions?zoneId=` and join on `ticketId`, or `/batches/:id` `rows[].rank` |
| the resulting stop / `sortOrder` | `GET /api/batches/:batchId` |
| candidates 7…N (when `candidatesTotal > 6`) | **none — the rows were never stored.** `TRACE_RUNNERS_UP = 5` |
| runner-up score **breakdowns** | none — only their final `score` |
| `deviceBucket` / `companyTier` | on the recommendation; reachable via `/decisions` |
| **which** availability status caused `SE_UNAVAILABLE` | none — the filter collapses "on leave", "off shift" and "deactivated" into one reason |

### 28.4 Suggested two-call composition

```
GET /api/dispatch-runs/:runId/decisions?zoneId=N&limit=500   → rank, tier, bucket, plant, status
GET /api/dispatch-runs/:runId/tickets/:ticketId/trace        → the deep view on click
```
This is exactly the split the code intends: the stream is "flat and small… the per-ticket inspector
already owns the deep view" (`dispatch-transparency-query.service.ts:236-241`).

---

## 29. Engineer UI Data

### 29.1 What each surface gives you

| Field | `/schedules/engineers` | `/dispatch/today` `engineers[]` | `/schedules/candidates` | `/intraday-insertions/:id/available-ses` |
|---|:--:|:--:|:--:|:--:|
| `seId` / `name` | ✓ | ✓ | ✓ | ✓ |
| **global** coverage type | ✓ | ✓ | ✗ | ✗ |
| **per-plant** coverage type | ✗ | ✗ | ✓ + `tierRank` | ✓ + `tierRank` |
| `committed` | ✓ | ✓ | ✓ | ✓ |
| `dailyCapacity` | ✓ | ✓ | ✓ (nullable) | ✓ (nullable) |
| `overCapacity` | ✗ (derive `>=`) | ✓ | ✗ (see `dropReason`) | ✗ |
| availability status | ✗ | ✓ | ✓ | ✓ (**filtered to AVAILABLE**) |
| kit completeness + missing parts | ✗ | ✗ | ✓ `kitComplete`, `missingKit[]` | ✓ |
| engine verdict | ✗ | ✗ | ✓ `verdict`, `dropReason` | ✓ (present, but the set is availability-filtered) |
| `isActive` | ✓ | (only actives returned) | ✗ | ✗ |
| route / stops | ✗ | ✓ `stops[]` | ✗ | ✗ |
| `scheduleId` / `scheduleStatus` | ✗ | ✓ | ✗ | ✗ |
| zone | ✓ | (the requested zone) | (plant's zone) | ✗ |

### 29.2 Projected capacity after an action

Two purpose-built endpoints:

- **one move** → `POST /api/batches/:id/override/preview` → `from.after` / `to.after` /
  `to.overCapacity`
- **many moves** → `POST /api/schedules/distribute-preview` → `overCapacitySeIds[]`

For an arbitrary draft the console computes it client-side from `committed + drafted` against
`dailyCapacity` — which is safe **because** `committed` comes from the shared `committedDayLoad`.

### 29.3 What is not available

| Wanted | Verdict |
|---|---|
| engineer's live GPS position | `NOT FOUND IN CODEBASE` — "NO live GPS in Phase 1" (`schema.prisma:253-256`) |
| engineer's route geometry / travel time | `EXPECTED_BUT_NOT_FOUND` — distance exists only as a scoring term; `orderPlantStops` is the deferred hook |
| a per-engineer score/ranking outside a decision | `EXPECTED_BUT_NOT_FOUND` — scores exist only per (ticket, candidate) inside a run |
| shift window in any scheduler read | `DEAD/UNUSED` — `shift_start`/`shift_end` are persisted and read by nothing |
| engineer conflicts as a list | `PARTIALLY_IMPLEMENTED` — only per-proposal (`OverrideConflicts`) or per-escalation |

---

## 30. Zone UI Data

| Need | Field | Source |
|---|---|---|
| zone state | `zones[].outcome` | run detail |
| claim state | `outcome === 'RUNNING'`, or `/dispatch-run/in-flight` | |
| tickets considered / recommended / unassignable | zone card | |
| the 3 withheld populations | `withheldBelowThreshold`, `bucketlessDropped`, `componentBlockedWithheld` | |
| engineers | `/dispatch/today` `engineers[]` (that zone) | |
| coverage gaps | `unassignableReasons.NO_COVERAGE` + `rails.unassignable[].poolEmptyReason` | |
| run progress | ⚠ **only DONE/ERROR/CONTENDED/RUNNING** — there is **no percentage and no per-ticket progress** | |
| failures | `error`, `seSkips[]` | |
| retry state | `recovery.attempts` / `.state` | `/dispatch/today` |
| contention | `outcome === 'CONTENDED'` + `contendedWithRunId` | |
| completion state | `finishedAt` on the zone row — ⚠ **not exposed** by any read | see §39 |
| live vs historical | `ticketsDispatched` vs `ticketsStillAssigned`/`ticketsRemovedSince` | |
| mode + weight set | `mode`, `weightSetRef` | |
| threshold in force | `assignmentThresholdHours` | |

### 30.1 Zone progress `EXPECTED_BUT_NOT_FOUND`

There is **no intra-zone progress signal**. A zone is RUNNING or terminal. The heartbeat
(`dispatch_runs.heartbeat_at`) advances per zone and would let a UI say "the run is alive", but it is
**not exposed on any read** (`DispatchRunListRow`/`Detail` omit it). → §39.

---

## 31. Preview APIs

### 31.1 `ZoneProjection` — the scheduler preview's per-zone payload

`recommender/recommender.service.ts:170-205`.

```jsonc
{
  "zoneId": "3",
  "targetDate": "2026-08-27",
  "bucketsAsOf": "2026-08-26T04:31:00.000Z" | null,
  "mode": "DEFICIT",
  "recommended": 19,
  "unassignable": 3,
  "withheldBelowThreshold": 140,
  "componentBlockedWithheld": 8,
  "unassignableReasons": { "NO_COVERAGE":1, "ALL_DROPPED":2, "dropBuckets": { … } },
  "decisions": [ /* PreviewDecision[] */ ],
  "plan": [ { "seId":"…", "plants":[ { "plantId":"12", "ticketIds":["…"] } ] } ]
}
```

**`PreviewDecision`** (`:130-158`) deliberately mirrors the persisted trace shape rather than
inventing a preview-only vocabulary — "#251 renders 'why this SE' from this, and two different
explanations of the same decision is exactly the drift the 'project the real recommender' decision
exists to prevent":

```jsonc
{ "ticketId","plantId","processingRank","companyTier","deviceBucket","tierOverrideId",
  "seId": null,            // null ⟺ unassignable; poolEmptyReason then says which kind
  "coverageType","score","candidatesTotal","passedCount","dropCounts",
  "poolEmptyReason","plannerBias","clusterSeed",
  "capacityAtDecision": { "used":5,"cap":6 } | null,
  "notEnforcedFilters": ["VEHICLE_ON_TRIP","COMPONENT_UNAVAILABLE"] }
```

⚠ **`bucketlessDropped` is on `RunSummary` but NOT on `ZoneProjection`.** A preview cannot report the
unrankable population. → §39.

**Why the run-level tallies ride on the projection** (`:186-193`): "`previewActiveZones` returns
projections, not summaries, so without these the preview would have to re-derive the figures
client-side — and two of them cannot be re-derived at all: `withheldBelowThreshold` is a separate
count with no per-ticket decision behind it, and `mode` decides whether the Install backlog appears
at all."

`buildPreviewPlan` (`:216-230`) mirrors what `dispatchForZone` would build — SE, then a plant stop per
distinct plant, tickets in decision order — but derives it from the decisions rather than calling the
dispatcher, "because the dispatcher is transactional and consumes recommendation rows a dry run
deliberately never wrote."

### 31.2 The three previews compared

| | Scheduler Preview | Override Impact | Distribute |
|---|---|---|---|
| Route | `GET /schedules/preview` | `POST /batches/:id/override/preview` | `POST /schedules/distribute-preview` |
| Question | "what would the next run do?" | "what would this one move do?" | "how do I spread this selection?" |
| Uses the engine? | **YES** — `runForZone({dryRun:true})` | no — reads persisted trace + `committedDayPlan` | **`COVERAGE_TIER` yes**; the other two allocate over `CandidateQueryService` |
| Date | any IST day (`?date=`) | today | today |
| Writes | 0 | 0 | 0 |
| Locks / claims | none | none | none |
| Staleness proof | `previewToken` (HMAC, 10 min) | none | none |
| Errors | per-zone `errors[]` | 400/404 | 400 |

### 31.3 `previewToken` — a signed staleness proof `IMPLEMENTED`

`scheduling/preview-token.ts`. Format: `<base64url(payload)>.<base64url(hmac-sha256)>` —
**deliberately not a JWT** (`:371-374`): "there is no algorithm field to confuse and no third-party
parser involved, so the `alg: none` class of mistake is unavailable by construction."

Secret: `JWT_ACCESS_SECRET` — "same trust boundary, different payload shape" (`:358-361`).
TTL: `PREVIEW_TOKEN_TTL_SEC = 600` — shared by every consumer on purpose, because "'how stale is too
stale' is one policy, not a per-feature preference" (`:343-347`).

`verifyPreviewToken` returns `null` for a malformed string, a bad signature, an unparseable body **or**
an expiry — callers cannot tell them apart, deliberately (`:385-389`): "every one of them means the
same thing operationally ('get a fresh preview'), and distinguishing them would tell an attacker
which half of a forgery attempt was wrong." Length is checked before `timingSafeEqual`, which throws
on a length mismatch.

The scheduler preview signs `{ targetDate, countsByZone: { [zoneId]: {recommended, unassignable,
withheld} } }` (`scheduler-preview.service.ts:60-63`).

⚠ **`checkStaleness` is not exposed.** `SchedulerPreviewService.checkStaleness` (`:135-150`) exists
and returns `FRESH` \| `TOKEN_INVALID` \| `TOKEN_STALE` + `freshPreview` — but **no controller route
calls it**. `NOT FOUND IN CODEBASE` as an endpoint. The token is minted and never verifiable by the
frontend. → §39 (high priority).

*(Bulk-unassign's token **is** verified, at `bulk-unassign.service.ts:186-194`.)*

### 31.4 Distribute — the three strategies

| Strategy | Mechanism | Where |
|---|---|---|
| `COVERAGE_TIER` | **the engine's own answer** — `runForZone({dryRun, ticketIds, engineerIds})`, grouped by zone, merged | `distribute-projection.service.ts:96-126` |
| `PLANT_WHOLE` | best tier → the candidate with the most headroom takes **the whole plant** | `:176-179` |
| `CAPACITY_HEADROOM` | best tier → **per ticket**, most-headroom-first, "so load actually spreads across a tier with more than one eligible engineer rather than landing on whichever sorts first" | `:180-188` |

`mostHeadroom` (`:194-198`): `dailyCapacity === null ? +Infinity : dailyCapacity − (committed + runningPlaced)`,
tie-broken by `seId.localeCompare`. `runningPlaced` grows as the projection places work — the same
NEW-A1 pattern.

**Tier order is respected by all three** (`:130-134`) — a lower tier is consulted only when the
selection has no PASSED candidate in any higher one, "a structural fact of coverage, which is
per-plant, not per-ticket."

**`COVERAGE_TIER` is the odd one out, deliberately** (`:50-54`): it is not a re-derivation at all.
"That is what makes the single-ticket/single-candidate AC true by construction: for a selection with
only one possible placement, all three strategies collapse to this one anyway."

**#276's two scope options on `runForZone`** (`recommender.service.ts:274-288`): `ticketIds` narrows
the ticket universe *at the query*, still subject to every gate; `engineerIds` narrows the pool
**once, at the point `orderedCandidatesForPlant` returns, and nowhere else** (`:598`) — "every rule
downstream runs unmodified over the narrowed pool, which is what keeps this the same selection code
rather than a second copy of it."

### 31.5 Preview vs real execution — can the frontend trust it?

The task asked this explicitly. Answered per preview.

#### Scheduler Preview — **trustworthy for today, caveated for D+1**

| Question | Answer | Evidence |
|---|---|---|
| Same functions as production? | **YES.** `previewActiveZones` → `runForZone({dryRun:true})` — the identical function the run calls, one flag different | `dispatch-run.service.ts:811` |
| What reads differ? | `targetDate` moves the **date-bound** reads: `notDeferredOn(targetDay)`, planner pins, `committedDayPlan(targetDay)`, availability windows (`asOf`), `returnDueTickets(asOf)` | `recommender.service.ts:298-308` |
| What writes are disabled? | **all of them** — the zone-wide orphan sweep, both `recommendation.create` calls, `recordComponentBlock`, `resolveComponentBlock`, the trace `createMany` | `:588, 680, 737, 765, 779, 944` |
| Transaction behaviour? | none — no transaction is opened, no advisory lock, no in-flight slot, no `dispatch_runs` row | `:788-796` |
| What snapshot/time? | `asOf = now + (targetDay − today)` — "the same time-of-day as `now`, shifted onto the target IST day" | `:299-308` |
| Consistency guarantee? | **today-parity by construction.** `asOf === now` for a preview of today, so every window predicate agrees with the real run *by construction rather than by coincidence* — "the alternative (probing at the target day's midnight) would silently disagree with the real run for every availability window that opens during the working day" | `:299-306` |
| What can differ? | **1.** `slaBucket` / `inactivityHours` are **materialised**, so a D+1 preview ranks on *today's* buckets — "no as-of-date variant exists and none is being built" (`:176-183`). **2.** `mode` is likewise as-of-last-recompute (`:313-316`). **3.** Under concurrency, a ticket a live run has already claimed still appears in the preview — "it cannot be closed without reading the other run's state, and reading it would make the preview's answer depend on when it was asked" (`:804-808`). **4.** The world moves between preview and run. | |
| Returned data | `ZoneProjection` — §31.1 | |

**Test evidence (`TESTS ARE EVIDENCE`):**
- `test/recommender-dry-run.e2e-spec.ts:130-135` — "a dry run writes nothing anywhere and still
  decides": whole-table count equality before/after.
- `:184-210` — **"AC-4: a dry run for today reaches the same decisions as the real run"**: asserts
  `recommended`, `unassignable`, `ticketsConsidered`, `mode` all equal, **and** that the projected
  decision set equals the persisted set (`expect(projected).toEqual(persisted)`, 3 decisions).
- `:218-232` — a ticket deferred until tomorrow appears in **tomorrow's** preview, not today's, and
  `bucketsAsOf` is **identical** across both (proving the watermark is not date-shifted).
- `:240-248` — control: without the flag, the same call writes real rows.
- `test/dispatch-preview.e2e-spec.ts:162-167` — a preview holds no in-flight slot and does not block a
  real run.

**Verdict: `IMPLEMENTED`.** For **today**, the frontend may present the preview as what the run will
do, subject only to the world moving. For **D+1**, it must display `bucketsAsOf` — the code calls this
"the projection's honest limit and #251 **must** display it… A preview that hid this would look
authoritative about an ordering it cannot know" (`:176-183`).

#### Override Impact Preview — **trustworthy, and re-derives nothing**

`override-projection.service.ts:100-107`: "It re-derives nothing either. Capacity comes from
`committedDayPlan` (the one definition the engine itself enforces against), the conflicts are read
with the same predicates `OverrideService.override` gates on, and the route effect mirrors what
`moveTickets` actually does. **A preview computed a second way is a preview that will eventually
disagree with the commit it precedes — which is worse than no preview, because the operator would
have trusted it.**"

Divergence risk: the two `committedDayPlan` reads (`from`, `to`) are one query, but a concurrent write
between the read and the confirm is unguarded. `lane.after` is clamped at 0 for exactly that reason
(`:170-174`): "a source whose committed count is smaller than the set being moved means the two reads
disagree… and showing a negative day would be a worse answer than showing an empty one."

`conflicts` are **reported, not enforced** (`:290-297`) — both are confirm-and-reason gates on the
write, "so a preview that hid a conflicted move would be lying about what the operator is allowed to
do."

#### Distribute Preview — **trustworthy for `COVERAGE_TIER`; the other two are policy, not prediction**

`COVERAGE_TIER` **is** the engine (`runForZone` scoped dry run) and predicts exactly.

`CAPACITY_HEADROOM` / `PLANT_WHOLE` share the engine's **eligibility** answer
(`CandidateQueryService` → `buildCandidateReadiness` + `applyHardFilters`) but apply their own
**allocation** policy — "a policy choice, not a second copy of the selection rule"
(`distribute-projection.service.ts:44-49`). They are not predictions of what the engine would do, and
must not be labelled as such in the UI. There is **no commit endpoint that executes a Distribute
result directly** — it feeds the console draft, which commits through `assign-batch`.

`overCapacitySeIds` is computed once, after lanes are final, "so it applies uniformly whichever
strategy built them… and does not assume that invariant holds forever" (`:214-220`).

---

## 32. Override APIs

### 32.1 The six commands

```ts
type OverrideCommand =
  | { action:'REMOVE_TICKET'; ticketId; reasonCode; confirm? }
  | { action:'DEFER_TICKET';  ticketId; deferredToDate: string; reasonCode; confirm? }
  | { action:'REORDER';       stopSequence: number; reasonCode; confirm? }
  | { action:'SWAP_SE';       newSeId; reasonCode; confirm? }
  | { action:'REASSIGN';      ticketId; newSeId; reasonCode; confirm? }
  | { action:'SPLIT_BATCH';   ticketIds: string[]; newSeId; reasonCode; confirm? }
```
`override.service.ts:29-35`. `reasonCode` is required by the type on all six; **it is not validated at
the controller** for `/batches/:id/override` — only `intraday-updates` validates it.

### 32.2 The shared pre-flight (`override`, `:151-232`)

```
1. load batch + schedule; zone clamp                     → 404 NOT_FOUND
2. affected = affectedTicketIds(batch, cmd)              :1187-1204
      REMOVE/DEFER/REASSIGN → [cmd.ticketId]
      SPLIT_BATCH           → cmd.ticketIds
      SWAP_SE/REORDER       → every live ticket on the batch
3. ON_SITE gate: conflict.activeOnSiteTicketIds(affected)
      >0 and !confirm → 409 CONFLICT_ON_SITE { ticketIds, seId }
      >0 and  confirm → audit OVERRIDE_AFTER_ON_SITE, proceed
4. DEFERRAL gate — MOVE_ACTIONS ONLY (SWAP_SE, REASSIGN, SPLIT_BATCH):
      held = deferredTicketIds(affected, istDate(now))
      >0 and !confirm → 409 CONFLICT_DEFERRED { ticketIds, seId }
      >0 and  confirm → audit OVERRIDE_DEFERRED_MOVE, proceed
5. dispatch to the action handler
```

**REMOVE / DEFER / REORDER are deliberately outside the deferral gate** (`:195-197`): "none of them
creates an assignment, and refusing to *withdraw* or re-order a held ticket would obstruct the very
actions that respect the hold. The deferral is preserved on a confirmed move — only an assignment
spends one."

`MOVE_ACTIONS`' deferral gate is **near-vacuous by construction** (a deferred ticket has no live batch
row to move) and reachable only through a bug #249 also closed — "it is gated anyway, because 'you can
only get here through a bug we just fixed' is not a guarantee" (`:191-193`).

### 32.3 Per-action detail

#### `REMOVE_TICKET` `:234-287`
```
Pre-read  batchAssignmentTicket.findFirst { batchId, ticketId, removedAt: null } → 404
In tx     stampOnceOrLose(bat, {id, removedAt: null},
                          { removedAt: now, removedBy: actor, removalReason: ZM_WITHDRAWN })
          ticket.update { assignmentState: 'UNASSIGNED' }
          flagOverridden(batch → OVERRIDDEN; schedule → OVERRIDDEN, guarded on liveness)
          queueDayPlanOverridden → outboxId
Post      drainRows
LostRace  → 404 NOT_FOUND ("the same answer the pre-read would have given a moment later")
Result    { result:'OK', batchId, scheduleId, seId, status:'OVERRIDDEN' }
```
**`removedAt: null` is back in the WHERE** (`:259-264`): "the read above happened outside this
transaction, so a concurrent remover — or the 04:00 closure recycle — can commit in between; an update
keyed only on `id` would then overwrite their actor and reason with ours. #244 reads `removal_reason`
as a predicate, so that is an **operational reclassification**, not a visible error. Losing throws so
the transaction rolls back **including the audit row**: nothing may record a withdrawal that did not
happen."

#### `DEFER_TICKET` `:289-356`
Same shape, **two clauses** (`:313-318`): `removalReason: ZM_DEFERRED` + `deferredToDate` on the batch
row, **and** `ticket.assignmentState → 'UNASSIGNED'` + `deferredUntil ← deferredToDate`.

"Only the first was written, and `deferredToDate` had zero readers, so the ticket stayed on today's
plan and kept burning a capacity slot for a day it would not be worked."
"Splitting them would make defer a same-day no-op with extra steps" (`:334-340`).

⚠ `new Date(cmd.deferredToDate)` — **unvalidated**. A malformed string yields Invalid Date.

#### `REORDER` `:358-396`
Reads every batch on the schedule ordered by `stopSequence`, splices the target to
`clamp(cmd.stopSequence, 1, batches.length)`, renumbers **all** stops `1..n`. Others keep their
relative order. Not guarded by `stampOnceOrLose`.

#### `SWAP_SE` `:879-920`
Moves the **whole batch row** to the target's schedule: `plantBatchAssignment.update { scheduleId,
seId, status:'OVERRIDDEN', overrideReason, stopSequence: next }`. The source schedule flips
`OVERRIDDEN` (guarded on liveness). Wrapped in `retryOnceOnUniqueViolation('WorkSchedule', …)`.

#### `REASSIGN` / `SPLIT_BATCH` `:924-1024`
Shared `moveTickets`. Per ticket: `stampOnceOrLose(source, REASSIGNED)` **then** create the
destination row.

**Update-before-insert is required** by `batch_assignment_tickets_one_active_per_ticket` (`:969`).

**Losing the race on ANY row fails the whole move** (`:970-974`) — "That is the point. A REASSIGN that
moved three of four tickets and reported success would leave a half-moved plan nobody asked for; the
throw rolls the transaction back whole."

Destination `addSource`: `MANUAL_REASSIGN` \| `MANUAL_SPLIT`; `addedBy: actor`; `addReason: reasonCode`;
`createdAt: now` — **the same instant** the source row is stamped, "so the ledger can pair the two
halves of this move inside one day window."

**#288 side effect** (`:1008-1011`): open `ESCALATION_REQUIRED` insertions for the moved tickets are
closed to `ACCEPTED` with `offeredSeId = newSeId` — "a move is the human decision the stranded-work
escalation was asking for." **Removal is deliberately not a closer.**

⚠ **`moveTickets` returns the SOURCE ids** (`:1023`): `{ batchId: batch.batchId, scheduleId:
batch.scheduleId, seId: batch.seId }` — *not* the destination. `swapSe` returns the **destination**
(`:919`). The UI must not assume the returned `seId` is the new owner for `REASSIGN`/`SPLIT_BATCH`.

### 32.4 The `flagOverridden` liveness guard `IMPLEMENTED`

```ts
await tx.plantBatchAssignment.update({ where:{batchId}, data:{status:'OVERRIDDEN', overrideReason} });
await tx.workSchedule.updateMany({ where:{ scheduleId, ...liveScheduleFilter() },
                                   data:{ status:'OVERRIDDEN', lastOverriddenBy, lastOverriddenAt } });
```
`:1099-1125`.

"`OVERRIDDEN` is a LIVE status while `COMPLETED`/`PARTIAL` are terminal, so an unguarded write by
primary key **resurrects a closed day plan**… No race needed; a manager acting on a stale screen after
the 04:00 closure is enough."

`updateMany` with **no count check, deliberately**: "the withdrawal the manager asked for is still
valid on a finished plan (the ticket returns to the pool), and only the *provenance* stamp is
meaningless there."

### 32.5 Two-lane behaviour and refresh

| Action | Lanes | Preview available | UI must refresh |
|---|:--:|:--:|---|
| `REMOVE_TICKET` | 1 | ✗ | source lane, pool, changes-today |
| `DEFER_TICKET` | 1 | ✗ | source lane, held rail, pool |
| `REORDER` | 1 | ✗ | that schedule's stops **entirely** (all renumbered) |
| `SWAP_SE` | 2 | ✓ | both lanes |
| `REASSIGN` | 2 | ✓ | both lanes |
| `SPLIT_BATCH` | 2 | ✓ | both lanes |

---

## 33. Hold Lifecycle

**A "hold" is one column: `tickets.deferred_until` (`@db.Date`).** There is no hold table.

### 33.1 Two writers, two shapes

| | `SchedulerPreviewService.placeHold` | `OverrideService.deferTicket` |
|---|---|---|
| Route | `POST /api/schedules/holds` | `POST /api/batches/:id/override` `{action:'DEFER_TICKET'}` |
| Precondition | ticket **OPEN + UNASSIGNED** | ticket on a **live batch row** |
| Writes | `deferred_until` only | `deferred_until` **+** `batch_assignment_tickets.{removed_at, removed_by, removal_reason:ZM_DEFERRED, deferred_to_date}` **+** `assignment_state → UNASSIGNED` |
| Audit | `SCHEDULER_HOLD_PLACED` | `BATCH_OVERRIDE_DEFER_TICKET` |

`scheduler-preview.service.ts:26-29` explains why the second writer was insufficient: "the existing
hold writer is `DEFER_TICKET`, which requires a live `batch_assignment_tickets` row — it defers work
*off a day plan*. A ticket that has not been dispatched yet has no such row, so an unassigned ticket
simply could not be held before now."

### 33.2 The boundary — inclusive, one definition

```ts
export function notDeferredOn(day: Date) {
  return { OR: [{ deferredUntil: null }, { deferredUntil: { lte: day } }] };
}
export function isNotDeferredOn(deferredUntil: Date | null, day: Date): boolean {
  return deferredUntil === null || deferredUntil <= day;
}
```
`ticketing/deferral.ts`.

**`heldUntil` is the day the ticket RETURNS.** Holding it off tomorrow means naming the day after
(`schedules.controller.ts:300-303`, `scheduler-preview.service.ts:154-159`).

Seven readers spread this predicate: the recommender's TROUBLESHOOT selection and Install backlog, the
Shared Pool, the intraday CRITICAL sweep, cross-zone auto-escalation, `assignableTickets`, and
`assignTicket`'s own gate. `deferral.ts:19-23` names #153 as the cautionary tale: "six copies of a
liveness filter drifted apart and blanked every SE's day plan."

### 33.3 Vehicle-return conflict `IMPLEMENTED`

`placeHold` refuses (409 `CONFLICT_VEHICLE_UNAVAILABLE`, with `expectedFrom` + `reportId`) when an
OPEN `vehicle_unavailability_report` exists and `confirm !== true`
(`scheduler-preview.service.ts:182-193`).

"The two are different concepts sharing one column: a hold is an admin's scheduling preference, a
return date is an operational fact about a vehicle. Overwriting the second with the first would lose
information nobody could recover" (`:76-81`).

On confirm, the audit metadata records `overrodeVehicleReport: <reportId>` — "an override of a
vehicle-return date is the one case where this write destroys information, so the trail has to say it
happened and who accepted it" (`:208-211`).

### 33.4 Expiration, priority impact, and clearing

| Event | Effect |
|---|---|
| the day arrives | **nothing happens** — the predicate simply stops excluding it. No sweep, no state change. |
| return date reached | the ticket becomes `returnDueToday` and gains **sort key 2b** — but only below CRITICAL+ |
| dispatch | `deferredUntil ← null` (`batch-assignment.service.ts:283`) — "the batch row's `deferred_to_date` is the durable record" |
| manual assign | same clear (`override.service.ts:562`) — "leaving a future date on a FORMALLY_ASSIGNED ticket is the verified stale-deferral edge this closes" |
| release | `deferredUntil ← null`, audit `SCHEDULER_HOLD_RELEASED` with `releasedFrom` |
| **nightly recycle** | **does NOT touch `deferred_until`** (`schedule-closure-scheduler.service.ts:244-247`): "`UNASSIGNED` says *something* may re-plan it, `deferred_until` says *not yet*. The sweep writes only the first, so the wait survives the plan expiring." |

### 33.5 Where holds are visible

| Surface | Field | Predicate |
|---|---|---|
| `/schedules/preview` | `holds[]` | `deferredUntil > day`, ZM-clamped, ordered asc |
| `/dispatch/today` | `rails.held[]` + `situation.held` | same, plus the OPEN report's `expectedFrom`/`decidedBy` |
| `/schedules/assignable-work` | `heldCount` per (company, plant) + `totals.heldCount` | `heldTickets(day)` |
| bulk-unassign preview | `deferredExcluded` | informational: "a deferred ticket is already UNASSIGNED with its batch row already removed, so it is never reachable through this query at all — this tells the OH it exists and will not be touched, structurally" |

`heldTickets` is **the exact complement**, reported rather than derived by subtraction
(`assignable-work.ts:34-42`): "a dispatcher who can see 12 devices at a plant and is offered 9 needs
the missing 3 accounted for on screen… Deriving it as `total − assignable` would also quietly absorb
any future exclusion into 'held', which is the kind of number that is wrong for a year before anyone
notices."

### 33.6 Overriding a hold to assign

`assignTicket` (`override.service.ts:459-491`) — the pattern every door shares:

```
held = !isNotDeferredOn(ticket.deferredUntil, day)
if held:
   if !confirm      → 409 CONFLICT_DEFERRED { ticketId, deferredUntil, vuReport }
   if !reasonCode   → 400 REASON_REQUIRED
   audit OVERRIDE_DEFERRED_ASSIGN { seId, deferredUntil, reasonCode, vuReportId }
```

"Mirrors the ON_SITE gate: confirming is not enough on its own. Overruling a hold somebody placed for
a stated reason is the one action whose 'why' is the entire accountability record" (`:470-472`).

"**Named, not decided**: the report itself is untouched. Overriding the hold says 'assign it anyway',
not 'the vehicle is back' — only #245's decide path may move the return date" (`:485-487`).

Reachable from `/schedules/assign`, `/intraday-updates/add`, and
`/intraday-insertions/:id/manual-assign` — all three map the same 409/400 vocabulary.
---

## 34. Audit / Decision Trace

### 34.1 The `dispatch_decision_traces.trace` JSONB — exact shape

**Assignable decision** (`recommender.service.ts:869-940`):

```jsonc
{
  "candidatesTotal": 4,
  "passedCount": 2,
  "dropCounts": { "OVER_CAPACITY": 1, "SE_UNAVAILABLE": 1 },
  "notEnforcedFilters": ["VEHICLE_ON_TRIP", "COMPONENT_UNAVAILABLE"],
  "chosen": {
    "seId": "…uuid",
    "coverageType": "DEDICATED",
    "precedenceRank": 1,                    // 1-based index in the FULL ordered pool
    "plannerPlanned": false,
    "plannerBias": false,
    "capacityAtDecision": { "used": 5, "cap": 6 },
    "clusterSeed": true,                    // NOT a cluster follow-on for this winner
    "score": 0.8312,
    "breakdown": {
      "rankScore": 1, "urgency": 0.4286, "repeatPenalty": 0, "ageScore": 0.7321,
      "distanceScore": 0.0847, "distanceKm": 10.8,     // or "NOT_AVAILABLE"
      "weights": { "company_priority_rank":0.4, "dispatch_urgency":0.3,
                   "repeat_failure_penalty":0.2, "distance":0.1 },
      "baseScore": 0.8312, "clusterMultiplier": 1
    },
    "tierEvaluated": "DEDICATED",
    "filterStates": [ { "filter":"VEHICLE_ON_TRIP","state":"NOT_ENFORCED" },
                      { "filter":"SE_UNAVAILABLE","state":"PASSED" },
                      { "filter":"OVER_CAPACITY","state":"PASSED" },
                      { "filter":"COMMON_KIT_INCOMPLETE","state":"PASSED" },
                      { "filter":"COMPONENT_UNAVAILABLE","state":"NOT_ENFORCED" } ]
  },
  "runnersUp": [ {
      "seId":"…","coverageType":"MULTI_PLANT","precedenceRank":2,
      "verdict":"TIER_NOT_REACHED",          // PASSED | DROPPED | TIER_NOT_REACHED
      "dropReason": null,
      "plannerPlanned": false,
      "filterStates": [ … ],
      "score": null                          // only PASSED runners-up carry one
  } ],
  "scoreDegenerate": false,
  "poolEmptyReason": null
}
```

**Unassignable decision** (`:706-733`): `chosen: null`, `passedCount: 0`, `scoreDegenerate: true`,
`poolEmptyReason: 'NO_COVERAGE' | 'ALL_DROPPED'`, and `runnersUp` = the **first 5 of `ordered`**
(not of the survivors) each `verdict:'DROPPED'` with their own `dropReason` and `filterStates`.

⚠ **Bounded at 5** — `TRACE_RUNNERS_UP = 5` (`:49`). "At most this many runners-up are recorded per
ticket (drop COUNTS cover the rest)." Candidates 7…N are gone.

### 34.2 What is answerable for one ticket, and from where

| Question | Field | Endpoint |
|---|---|---|
| candidate count | `trace.candidatesTotal` | trace |
| candidates considered | `trace.chosen` + `trace.runnersUp[≤5]` | trace |
| filter results (per candidate) | `filterStates[]` | trace |
| drop reasons (per candidate) | `dropReason` | trace |
| drop counts (pool-wide) | `dropCounts{}` | trace |
| tier | `coverageType` per candidate; `chosen.tierEvaluated` | trace |
| scores | `chosen.score`, `runnersUp[].score` | trace |
| winner | `trace.seId` | trace |
| precedence | `precedenceRank` per candidate | trace |
| planner pin | `plannerPlanned` / `plannerBias` | trace |
| final recommendation | `recStatus`, `scoreBreakdown` | trace endpoint |
| assignment | batch + sortOrder | `GET /api/batches/:batchId` |
| override | the two `batch_assignment_tickets` legs | `GET /api/dispatch/changes-today` |
| timestamps | `dispatch_decision_traces.created_at` — ⚠ **not exposed** | — |
| actor | for the run: `actorUserId`/`actorRole`/`actorName` on run detail | run detail |
| run | `runId` | trace |
| zone | `zoneId` | `/decisions` rows |
| **processing rank** | ⚠ on the **recommendation**, not the trace | `/decisions` or `/batches/:id` |

### 34.3 Audit-log actions the scheduler writes

| Action | Entity | Written by |
|---|---|---|
| `DISPATCH_RUN_STARTED` / `DISPATCH_RUN_FINISHED` | `dispatch_run` | `execute` `:861`, `:951` |
| `DISPATCH_SCHEDULE_UPDATED` | `system_settings` | `setCron` `:128` — carries **both** `previous` and `next` |
| `SCHEDULER_HOLD_PLACED` / `SCHEDULER_HOLD_RELEASED` | `ticket` | `placeHold` / `releaseHold` |
| `BATCH_OVERRIDE_<ACTION>` | `plant_batch_assignment` | `auditEntry` `:1142` |
| `MANUAL_ZM_UPDATE` | ticket / batch | same-day path (re-tag) |
| `OVERRIDE_AFTER_ON_SITE` | `plant_batch_assignment` | `:176` |
| `OVERRIDE_DEFERRED_MOVE` | `plant_batch_assignment` | `:202` |
| `OVERRIDE_DEFERRED_ASSIGN` | `ticket` | `:473` |
| `CRITICAL_ASSIGN` | `ticket` | `assignTicket` default |
| `MANUAL_BATCH_ASSIGN` / `MANUAL_PLANT_ASSIGN` | `ticket` | `assignLane` |
| `ASSIGN_BATCH_COMMIT` | `assign_batch_lane` | `assignLane` `:851` — **one per lane**, even when nothing was assigned |
| `BULK_UNASSIGN_ZONE` | `zones` | `executeZone` (+ skip rows) |
| `SE_AVAILABILITY_SET` | `se_availability` | `setAvailability` |
| `CROSS_ZONE_*` (6 actions) | `cross_zone_escalation` | cross-zone service |
| `SE_COVERAGE_REMOVED` | — | org, on hard delete |

**`ASSIGN_BATCH_COMMIT` is written even for a lane that assigned nothing** (`:843-845`) — "so 'why
this plan was made' is recorded even for a lane that ended up assigning nothing."

**`withAudit` is transactional**: the audit row and the mutation commit together, so a rolled-back
override leaves no audit trace (`override.service.ts:262-264`).

### 34.4 Retrieval APIs — the complete evidence surface

```
GET /api/dispatch-runs                         run history
GET /api/dispatch-runs/:runId                  config in effect + zone cards
GET /api/dispatch-runs/:runId/zones/:zoneId    batches + unassignable + plant stats
GET /api/dispatch-runs/:runId/decisions        every decision, in processing order  ← Replay
GET /api/dispatch-runs/:runId/tickets/:tid/trace   the deep per-ticket view
GET /api/batches/:batchId                      the assignment rows with rank + score
GET /api/dispatch/changes-today                what humans did today
```

**No audit-log browse endpoint exists for scheduler actions.** `NOT FOUND IN CODEBASE` — only
`GET /api/schedules/bulk-unassign/history` (OH-only, `BULK_UNASSIGN_ZONE` rows) and the
`/intraday-updates` list (`MANUAL_ZM_UPDATE` rows, effectively empty). → §39.

---

## 35. Notification / Outbox

Covered in §22.3. Additional detail for the UI:

### 35.1 Notification types the scheduler emits

| Type | Recipient | Emitted by |
|---|---|---|
| `DAY_PLAN_DISPATCHED` | the SE | outbox, post-commit |
| `DAY_PLAN_OVERRIDDEN` | the SE | outbox, post-commit |
| `DAY_PLAN_REBALANCED` | each affected SE | `BulkUnassignService`, post-commit, **direct** (not outbox) |
| `INTRADAY_DIRECT_ASSIGNED` | the chosen SE | intraday sweep, **direct** |
| `INTRADAY_MANUAL_ASSIGNED` | the chosen SE | `manualAssign`, **direct** |
| `INTRADAY_ESCALATION_REQUIRED` | the zone's ZM | intraday escalate **and** stranded-work escalation |
| `CROSS_ZONE_AUTO_ESCALATION` / `_MANUAL_FLAG` | all CSM + OH | cross-zone |
| `CROSS_ZONE_DECISION` | the home ZM | cross-zone |
| `CROSS_ZONE_RE_ESCALATED` | all OH | cross-zone |

⚠ **Only the two day-plan events go through the outbox.** The other seven call
`NotificationService.notify` directly, post-commit but **unguarded** — a failure there is not retried
and (for the intraday sweep) would propagate. `IMPLEMENTED_DIFFERENTLY` relative to the outbox
discipline.

### 35.2 One alert per unavailability, not per ticket

`stranded-work-escalation.service.ts:107-115`: the ledger needs a row each — "that is what the queue
lists and what the guard keys on — but the *decision* is a single one: this engineer's day has to be
redistributed. Eight notifications for eight stops would be the storm the guard exists to prevent,
arriving by a different door."

`INTRADAY_ESCALATION_REQUIRED` is **reused rather than given a new type**: "a new type would land in
whatever a client's `default` branch does with an unknown one."

---

## 36. Recovery / Reaper / Retry

Four distinct mechanisms, each bounding a different failure. **They are not interchangeable.**

| | Reaper (#261) | Recovery collector (#286) | Patience (#260) | Outbox re-drain (#264) |
|---|---|---|---|---|
| Bounds | a **dead process** | a **lost field day** | a **transient lock** | a **lost notification** |
| Cadence | 3 min | 5 min | in-run, 60 s | 2 min |
| Bound | 10-min silence | 3 attempts + 18:00 IST | 15-min deadline | 5 attempts |
| Dispatches? | **no** | yes | yes | n/a |
| Record | claim → ERROR, run → ABORTED, mark PENDING | `dispatch_zone_recoveries` | CONTENDED rows | `attempts`, `last_error` |
| Off switch | `DISPATCH_STALE_RUN_MIN` | `DISPATCH_RECOVERY_MAX_ATTEMPTS=0` | `DISPATCH_RETRY_DEADLINE_MS=0` | — |

**Why 5 min for recovery against the reaper's 3** (`dispatch-cron.ts:41-45`): "the mark has to exist
before there is anything to collect, so a collector that ran faster than the reaper would mostly find
an empty table."

**Why recovery is never patient** (`dispatch-run.service.ts:620-622`): "#260's patience is for a run
that has one chance today; this one gets another chance in five minutes, and a fifteen-minute wait
inside a five-minute tick would simply hold the collector's own window shut."

**Why the reaper does not dispatch** (`dispatch-scheduler.service.ts:125-129`): "a reaper that also
ran the zones it freed would turn 'clean up after a crash' into an unscheduled dispatch run at an
arbitrary minute of the day, which is the schedule's decision to make, not the janitor's."

### 36.1 The `maxAttempts = 0` degradation

"Marks are still written (they are the evidence a zone lost its day) and the collector retires them
EXHAUSTED without dispatching, so turning this off degrades to exactly #261's behaviour plus a
record" (`dispatch-cron.ts:80-83`).

### 36.2 The schedule-closure recycle (#242) — the third lifecycle half

`ScheduleClosureScheduler.recycle` (`:252-300`). Before it existed, a ticket dispatched but not worked
was in **double limbo**: the recommender selects `OPEN` + `UNASSIGNED` so it could not see the ticket,
and every day-plan read requires a *live* schedule so neither could the SE. "**The ticket belonged to
nobody, permanently.** 4,983 OPEN tickets were sitting that way in the dev mirror when this was
measured, and the maximum assignment attempts any ticket had ever reached was 2 — every one of those
via a human bulk-unassign."

Two writes, both set-based, in order:
1. **Recycle** — unresolved live rows → `removed_at = now, removed_by = NULL, removal_reason =
   PLAN_EXPIRED`; then ticket → `UNASSIGNED` **scoped to tickets with no live row left**
   (`batchTickets: { none: { removedAt: null } }`) "so a ticket some concurrent path re-assigned is
   not dragged back to UNASSIGNED."
2. **Backstop** — live rows on **already-resolved** tickets → `RESOLVED_AT_CLOSURE`, ticket untouched.
   "Resolved work is never unassigned: returning finished tickets to the pool is the one thing a
   recycler must not do."

Returns the **statement's own count**, not `unresolved.length`: "they differ by exactly the rows a
concurrent writer closed first, and reporting a release that did not happen is the failure mode this
figure exists to prevent."

Schedule status: `PARTIAL` if any still-assigned ticket is unresolved, else `COMPLETED`. Removed
tickets never hold a day open.

### 36.3 The lock-contention trade-off, stated

`schedule-closure-scheduler.service.ts:92-99` names the cost explicitly:

> "Contention runs both ways, and the other direction is the costly one: a dispatch that finds the
> lock held records `LOCK_CONTENDED` and skips the zone for that run, leaving its SEs without a plan
> for the day. Two things keep that off the table rather than one — the crons are an hour apart **in
> the same timezone** (04:00 vs 05:00 IST) and each zone is closed in its own short transaction…
> Anything added here that widens that window (a per-schedule fan-out, an unbounded scan under one
> lock) trades a stale plan for a missing one."

### 36.4 Stranded work (#288) — escalate-only

`StrandedWorkEscalationService.escalateStrandedWork(seId, now)`.

Triggered from `SeAvailabilityService.setAvailability` (`:150`), **outside** the transaction: "the
availability window is the decision; the escalations are a consequence of it, and a failure to raise
them must not roll back the fact that the engineer is unavailable."

`strandsWork` (`:170-183`) — three things it deliberately is **not**:
- not "status ≠ AVAILABLE" alone — leave approved Monday for Friday strands nothing today;
- not "the window contains right now" — a window starting at 14:00 still takes the afternoon away;
- not a window that has already **ended** — the engineer is back.

So: **the window overlaps `[now, end of the IST operating day]`**, and `AVAILABLE` is excluded because
it is the clearing status.

Writes one `intraday_insertions` row per live remaining ticket, `insertion_type = 'SE_UNAVAILABLE'`,
`offered_se_id: null` — "the engineer named is the one it is being taken *from*. Writing them here
would say the opposite of what happened." Re-escalation is guarded by the existing
`intradayInsertions: { none: { status:'ESCALATION_REQUIRED' } }`.

**Nothing is reassigned** (#282 R4). "The plan history stays intact and auditable — a human
redistributes through the manual paths that already exist."

### 36.5 Escalation causes the UI must distinguish

`TodayEscalation.insertionType` (`dispatch-today-query.service.ts:111-118`):

| Value | Means | Resolves via |
|---|---|---|
| `SYSTEM_CRITICAL` | #268 — no capacity-eligible engineer for a CRITICAL ticket | the queue's **Assign** |
| `SE_UNAVAILABLE` | #288 — an engineer became unavailable with work committed | a **reassign** on that engineer's plan (the ticket is still assigned) |

"The strip above this list asserts a cause in words, so it has to be able to tell them apart — one
sentence over a mixed list would be wrong about half of it."

And `assignedSeId` decides which button works — §25.16.

---

## 37. Transaction / Concurrency Model

### 37.1 The primitives

| Primitive | Where | Purpose |
|---|---|---|
| `INSERT … ON CONFLICT DO NOTHING` | zone claims `:389`; tick claims | admission-as-a-test |
| `SELECT … FOR UPDATE OF r SKIP LOCKED` | recommendation claim `:175`; ticket re-verify `:769-771` | invisible-not-error |
| `pg_advisory_xact_lock` (blocking) + `SET LOCAL lock_timeout` | dispatch per SE `:161-162` | vs closure / bulk-unassign |
| `pg_try_advisory_xact_lock` | closure `:170`; bulk-unassign `:248` | skip, never wait |
| guarded `updateMany` (compare-and-set) | run finalize, zone finalize, heartbeat, retireMark, outbox claim, `flagOverridden` | no resurrection |
| `stampOnceOrLose` | `removeTicket`, `deferTicket`, `moveTickets` | no attribution overwrite |
| `transitionOrConflict` | outbox `drainRow` | exactly-once delivery |
| `retryOnceOnUniqueViolation` | `assignTicket`, `swapSe`, `moveTickets` | absorb a schedule race |
| partial unique indexes (×4) | DB | the real invariants |

### 37.2 The guarded-write discipline `IMPLEMENTED`

**Every** status write in the scheduler carries a predicate on the state it expects. This is #265's
finding, restated at each site:

| Write | Guard | Prevents |
|---|---|---|
| run finalize | `status:'RUNNING'` | overwriting a reaper's `ABORTED` with `SUCCESS` — "a ledger asserting two runs dispatched the same zone" |
| zone finalize | `status:'RUNNING'` | crediting this run's work to a claim it no longer holds |
| heartbeat | `status:'RUNNING'` | a terminal run beating its way back to looking alive |
| `retireMark` | `state:'PENDING'`, `attempts: seen` | a second collector's decision being overwritten |
| `flagOverridden` (schedule) | `liveScheduleFilter()` | **resurrecting a closed day plan** |
| `removeTicket` / `deferTicket` / `moveTickets` | `removedAt: null` | overwriting a concurrent remover's actor + reason (an operational reclassification, since #244 reads it as a predicate) |
| closure `recycle` | `removedAt: null` | same |
| `retireAssignmentOnClosure` | `removedAt: null` | same |
| outbox `drainRow` | `sentAt: null` | double delivery |
| `promoteContendedClaim` | `status:'CONTENDED'` + `NOT EXISTS(RUNNING)` | two runs promoting the same zone |
| `markZonesForRecovery` | `state: {in:['PENDING','RECOVERED']}` | resurrecting EXHAUSTED / EXPIRED |

### 37.3 The P2002 rule `IMPLEMENTED`

**A P2002 aborts its Postgres transaction.** This single fact drives four design choices, and the code
says so at each:

| Site | Choice | Why |
|---|---|---|
| zone claims | `ON CONFLICT DO NOTHING` | "catching one would leave nothing to continue with" `:337-341` |
| recommendation claim | `SKIP LOCKED` | "a P2002 nobody can recover from in place" `:164-166` |
| `assignLane` | `FOR UPDATE … SKIP LOCKED` per ticket | "this transaction is now shared across every ticket in the lane — one collision would silently roll back every sibling ticket already written in it" `override.service.ts:716-721` |
| `assignTicket` | the **recovery wraps the whole call**, not a `catch` inside | "It cannot be caught *inside* the block — a P2002 aborts the whole Postgres transaction — so the recovery wraps the call and lets the rollback do its work, which is also what stops `withAudit` leaving an audit row for an assignment that never happened" `:492-498` |
| `promoteContendedClaim` | `catch P2002 → false` is **safe here** | "this is a single statement with no interactive transaction to abort" `:1040-1042` |
| recommender per-ticket | `catch P2002 → continue` | guard-not-throw; each create autocommits individually |

⚠ **`uniqueViolationModel` uses `meta.modelName`, not `meta.target`** — `meta.target` "does not exist
under this repo's driver adapter; #265 measured its absence" (`se-skip.ts:284-289`). Exact only
because each table has exactly one unique constraint.

### 37.4 "What happens if…" — the complete answer set

| Scenario | Outcome |
|---|---|
| **two dispatch runs start** | first admits; second's claim insert returns 0 rows. Some free ⇒ CONTENDED rows on the loser; all held ⇒ 409 with holder details and **zero rows written** |
| **two CRON runs, all zones held** | the loser waits up to 15 min, reaping each minute, promoting as zones free |
| **scheduler and manager act simultaneously** | dispatch takes the advisory lock per SE; the manager's `assignTicket` takes **no lock** but re-verifies under `FOR UPDATE … SKIP LOCKED` in `assignLane`, or absorbs a P2002 as `ALREADY_ASSIGNED` in `assignTicket` |
| **two managers modify one assignment** | `batch_assignment_tickets_one_active_per_ticket` — the loser gets 409 `TICKET_ALREADY_ASSIGNED` (assign) or `LOST_RACE` in `skipped` (lane) or `LostRaceError → 404` (override) |
| **two managers remove one ticket** | `stampOnceOrLose` — the loser gets 404, and its **audit row rolls back** |
| **preview becomes stale** | nothing is enforced. `previewToken` proves it — but **`checkStaleness` is not exposed**, so the frontend cannot verify it today |
| **a worker crashes mid-run** | claims stay RUNNING under a RUNNING run → reaper (≤10 min silence + ≤3 min cadence) → run ABORTED, claims ERROR, zone marked PENDING → collector re-dispatches within 5 min, bounded 3× and 18:00 IST |
| **the reaper crashes between its two writes** | claims RUNNING under an ABORTED run; the next pass finds them **by predicate**, not by run-id list |
| **notification fails** | outbox row un-claimed with `last_error`; retried by the 2-min sweep up to 5 attempts; **never** propagates into the dispatch outcome |
| **the DB transaction fails** | per-SE containment — that SE's plan rolls back whole; a `describeSeSkip` row on the zone card; the zone and the other engineers continue |
| **a zone claim expires** | it does not expire — it is freed by the reaper or the `finally`, and both stamp a reason |
| **the process is killed with no unwind** | `finally` never runs; the reaper is the only recovery |
| **bulk-unassign during a run** | skipped with `DISPATCH_IN_PROGRESS`, audited per zone |
| **closure during a run** | try-lock fails → zone skipped, retried next tick |
| **two app instances both enabled** | `cron_tick_claims` — exactly one wins each `(job, minute)`; the loser logs at `log` level and no-ops |

---

## 38. Error and Empty States

### 38.1 Backend states with an exact shape

| State | HTTP | Code / value | Data |
|---|---|---|---|
| no tickets | 200 | `ticketsConsidered: 0`, `recommended: 0` | zone card of zeros, `outcome: 'DONE'` |
| no engineers cover the plant | 200 | `poolEmptyReason: 'NO_COVERAGE'` | `candidatesTotal: 0` |
| all candidates filtered | 200 | `poolEmptyReason: 'ALL_DROPPED'` | `dropCounts{}` |
| no ranking data (ticket) | — | **invisible** | only `bucketlessDropped` |
| stale eligibility MV | 200 | `config_snapshot.eligibilityMv.stale: true` | + a log warning |
| stale buckets | 200 | `bucketsAsOf` | **previews only** |
| capacity exceeded (automatic) | 200 | `dropCounts.OVER_CAPACITY` | candidate dropped |
| capacity exceeded (manual) | 200 | `overCapacity: true` | **never blocked** |
| run already active | 409 | `DISPATCH_ALREADY_RUNNING` | `inFlight[]` |
| zone locked (closure/bulk) | 200 | `skipReason: 'LOCK_CONTENDED'` | audit row |
| zone held by a run (bulk) | 200 | `skipReason: 'DISPATCH_IN_PROGRESS'` | audit row |
| zone contention (run) | 200 | `outcome: 'CONTENDED'` | `contendedWithRunId` |
| preview token stale | 409 | `PREVIEW_TOKEN_STALE` | `freshPreview` — **bulk-unassign only** |
| preview token missing/invalid | 409 | `PREVIEW_TOKEN_REQUIRED` / `_INVALID` | — |
| override conflict — on-site | 409 | `OVERRIDE_ON_SITE_CONFLICT` | `ticketIds[]` |
| override conflict — deferred | 409 | `CONFLICT_DEFERRED` | `ticketIds[]` or `{ticketId, deferredUntil, vuReport}` |
| deferral override, no reason | 400 | `DEFERRAL_OVERRIDE_REASON_REQUIRED` | — |
| not projectable | 400 | `NOT_PROJECTABLE` | `action` + message |
| ticket not holdable | 409 | `TICKET_NOT_HOLDABLE` | `status`, `assignmentState` |
| hold vs vehicle report | 409 | `CONFLICT_VEHICLE_UNAVAILABLE` | `expectedFrom`, `reportId` |
| ticket not held | **200** | `{ result: 'NOT_HELD' }` | ⚠ a 200 body |
| already assigned | 409 | `TICKET_ALREADY_ASSIGNED` | — |
| recovery pending / exhausted / expired | 200 | `recovery.state` | `attempts`, `lastError` |
| partial run | 200 | `status: 'PARTIAL'` | zone cards |
| failed run | 200 | `status: 'FAILED'` | every processed zone errored |
| unknown / crashed run | 200 | `status: 'ABORTED'` | reaper-written; `finishedAt` set |
| SE skipped | 200 | `seSkips[]` | `{seId, reason, constraint}` |
| notification failure | — | `last_error` on the outbox row | **not exposed** |
| tick claimed by another instance | — | `{ran:false, reason:'TICK_CLAIMED'}` | **not an error** |
| scheduler disabled | — | `{ran:false, reason:'DISABLED'}` | **not exposed** |
| invalid date | 400 | `INVALID_DATE` | message |
| invalid cron | 400 | `INVALID_CRON_EXPRESSION` | `reason` |
| zone required | 400 | `ZONE_REQUIRED` | `hint` |
| invalid zone filter | 400 | `INVALID_FILTER` | `hint` |
| cross-zone read | 403 or 404 | `ZONE_SCOPE_VIOLATION` / `*_NOT_FOUND` | see §38.4 |
| future-day dispatch | **500** | plain `Error` | ⚠ unmapped |
| timeout | — | **`NOT FOUND IN CODEBASE`** as a distinct state | only `ZONE_LOCK_TIMEOUT` inside `seSkips` |

### 38.2 Empty states a UI must render specifically

| Surface | Empty shape | Meaning |
|---|---|---|
| `GET /schedules/me` | `{dispatched:false, scheduleId:null, stops:[]}` | "your plan is being prepared" |
| `GET /dispatch/today` `engineers[]` | lanes present with `stops: []` | the engineer has nothing — **a fact, not an absence** |
| `assignable-work` | `{totals: all 0, companies: []}` | nothing outstanding |
| `candidates` `plants[].candidates` | `[]` | **NO_COVERAGE** for that plant |
| `preview.zones` | `[]` | no active zone in scope |
| `preview.holds` | `[]` | nothing held |
| `rails.policyWithheld` | `{count: 0, itemised:false}` | **never a list** |
| `seSkips` | `[]` or the field absent | both mean "no engineer skipped" |
| `runnersUp` | `[]` | a single-candidate pool |
| `recovery` | `null` | **nothing crashed** — not "unknown" |
| `build` | `null` | pre-#130 run, or no `runtime_lock` row |
| `rank` (override preview) | `null` | **unknown, never "unranked"** |

### 38.3 The `NOT_ENFORCED` render rule

Any `filterStates[]` entry with `state: 'NOT_ENFORCED'` — and every member of
`trace.notEnforcedFilters[]` — must render as **"not evaluated"**, visually distinct from PASSED.
Today that is always exactly `['VEHICLE_ON_TRIP', 'COMPONENT_UNAVAILABLE']`, but the field is
per-candidate so it stays correct when one feed goes live before the other.

### 38.4 Cross-zone refusal styles — **not uniform** ⚠

| Route | Style | Where |
|---|---|---|
| `GET /dispatch-runs/:runId/zones/:zoneId` | **403** `ZONE_SCOPE_VIOLATION` (global `ZoneScopeGuard`) | `dispatch-runs.controller.ts:33-34` |
| `GET /dispatch-runs/:runId/decisions?zoneId=` | **403** `ZONE_SCOPE_VIOLATION` (service-raised — camelCase, the guard doesn't see it) | `dispatch-transparency-query.service.ts:807-809` |
| `GET /dispatch-runs/:runId/tickets/:tid/trace` | **404** `DISPATCH_TRACE_NOT_FOUND` (service clamp) | `:743` |
| `GET /dispatch/today?zoneId=` | **403** `ZONE_SCOPE_VIOLATION` | `dispatch-today-query.service.ts:179-181` |
| `GET /dispatch/changes-today?zoneId=` | **403** `ZONE_SCOPE_VIOLATION` | `dispatch-changes-today.service.ts:59-61` |
| `GET /schedules/candidates?plantIds=` | **omitted from the response** | `candidate-query.service.ts:197-205` |
| `POST /schedules/distribute-preview` | out-of-scope ticket ids **dropped silently** | `distribute-projection.service.ts:240-244` |
| `POST /schedules/holds` | **404** `TICKET_NOT_FOUND` | `scheduler-preview.service.ts:173` |
| `POST /batches/:id/override` | **404** `BATCH_NOT_FOUND` | `override.service.ts:166` |
| `GET /schedules/:engineerId` | **404** `SCHEDULE_NOT_FOUND` | `schedules.controller.ts:570` |

The `decisions` choice is deliberate (`:804-806`): "**Refusing rather than substituting the ZM's own
zone: answering a question nobody asked is worse than saying no.**" The `candidates`/`distribute`
choice is equally deliberate — "one bad id cannot blank the projection for the rest."

**The frontend must handle 403, 404 and silent omission** on scheduler reads.
---

## 39. Frontend-Backend Gaps

**Identified only. No implementation, per §28 of the brief.** Ordered by impact on the Scheduler UI.

### G1 — `checkStaleness` is implemented but unreachable `HIGH`

```
What UI needs        To tell the operator "the plan you are looking at is no longer the plan",
                     and hand them the current one.
Why                  The scheduler preview mints a signed previewToken on every response and the
                     frontend has no way to verify it. The whole point of the token is unusable.
Current source       SchedulerPreviewService.checkStaleness  scheduler-preview.service.ts:135-150
Exists internally?   YES — fully implemented, returns FRESH | TOKEN_INVALID |
                     TOKEN_STALE + freshPreview
API exposes it?      NO — no controller route calls it. NOT FOUND IN CODEBASE as an endpoint.
Recommended          POST /api/schedules/preview/staleness { previewToken } → StalenessOutcome
                     (mirroring bulk-unassign's 409 TOKEN_STALE + freshPreview shape, which IS wired)
Risk                 Low — pure read, the service exists, and the token TTL/verification are shared.
```

### G2 — No fleet-wide scheduler dashboard read `HIGH`

```
What UI needs        One call for a pan-India scheduler health view.
Why                  /api/dispatch/today is single-zone and 400s ZONE_REQUIRED for a multi-zone role.
                     A dashboard must fan out N+4 requests and derive "last successful run" and
                     "utilization" client-side.
Current source       DispatchTodayQueryService (per zone) + DispatchTransparencyQueryService (runs)
Exists internally?   The parts do; no composition does.
API exposes it?      NO
Recommended          GET /api/dispatch/summary → per-zone situation rows + fleet totals + next
                     fire + in-flight, in one payload.
Risk                 Medium — a fan-out over every zone, and DispatchTodayQueryService already
                     issues ~11 queries per zone. Would need its own aggregation, not a loop.
```

### G3 — Role asymmetry blocks a ZM's scheduler view `HIGH`

```
What UI needs        A Zonal Manager needs "when is the next run" and "is a run in flight".
Why                  GET /schedules/dispatch-schedule is @Roles('OPERATIONS_HEAD') and
                     GET /schedules/dispatch-run/in-flight is OH+CSM. A ZM can see neither, so
                     their cockpit cannot explain why the deck is empty at 04:55.
Current source       DispatchScheduleService.current(); DispatchRunService.inFlightZones()
Exists internally?   YES
API exposes it?      Yes, but not to the role that needs it.
Recommended          A read-only GET /api/schedules/dispatch-schedule/next open to MANAGER_ROLES
                     (cron + nextFireAt only, no write), and widen in-flight to MANAGER_ROLES
                     clamped to the caller's zone.
Risk                 Low — both are read-only and carry no zone-sensitive data beyond zone ids.
```

### G4 — `bucketsAsOf` is invisible on real runs `HIGH`

```
What UI needs        "This run ranked on data computed at HH:MM" — the same honesty the preview gives.
Why                  bucketsAsOf is computed in runForZone (:442-445) and returned ONLY inside
                     `projection`, i.e. only on a dry run. A real run's zone card cannot say how
                     stale its ranking inputs were, though the figure was computed.
Current source       recommender.service.ts:442-445
Exists internally?   YES — computed on every run, discarded on the real path.
API exposes it?      NO for real runs.
Recommended          Add `bucketsAsOf` to RunSummary and persist it on dispatch_run_zones.
Risk                 Low-medium — one nullable column + one field. It is already computed.
```

### G5 — The P2002-skipped tickets are uncounted `HIGH`

```
What UI needs        The funnel to add up.
Why                  recommender.service.ts:809 `catch P2002 → continue` skips a ticket with no
                     counter, no recommendation and no trace. On a run where it fires,
                     recommended + unassignable < ticketsConsidered with nothing naming the gap.
Current source       the catch block
Exists internally?   NO counter exists.
API exposes it?      NO
Recommended          A `claimedElsewhere` counter on RunSummary + dispatch_run_zones, alongside the
                     other four "populations the engine did not decide on".
Risk                 Low — one counter.
```

### G6 — A silently-ignored planner pin is unrecorded `MEDIUM`

```
What UI needs        "Your pin for this plant was not used, because that engineer was over capacity."
Why                  The pin is searched among `passed`. A pinned SE dropped by a hard filter is
                     simply not found, and nothing records that a pin existed and was skipped.
                     `plannerPlanned` is only ever written for candidates in the trace's top 6.
Current source       tier-score-chooser.ts:63
Exists internally?   The information exists at the moment of the decision; it is discarded.
API exposes it?      NO
Recommended          Persist `plannerPinnedButDropped: [{ seId, dropReason }]` on the trace.
Risk                 Low — additive JSONB.
```

### G7 — `NOT_ENFORCED` and `TIER_NOT_REACHED` are absent from the candidate column `MEDIUM`

```
What UI needs        The Assign Console's candidate column to agree with the trace's vocabulary.
Why                  CandidateQueryService emits only PASSED | DROPPED. An operator comparing the
                     console against a decision trace sees two different vocabularies for the same
                     engine. The TIER_NOT_REACHED omission is deliberate and justified (#272 R6);
                     the NOT_ENFORCED omission is not discussed anywhere.
Current source       candidate-query.service.ts:27, 148-170
Exists internally?   evaluateAllFilters / notEnforcedFilters are pure and importable.
API exposes it?      NO
Recommended          Add `filterStates: {filter,state}[]` to CandidateRow.
Risk                 Low — pure function over data already loaded.
```

### G8 — No audit-log browse for scheduler actions `MEDIUM`

```
What UI needs        "Show me every override in this zone today / this week."
Why                  Only two audit reads exist: bulk-unassign history (OH-only) and the Intra-day
                     Queue (which reads MANUAL_ZM_UPDATE — a family no admin code writes).
                     BATCH_OVERRIDE_* rows, OVERRIDE_DEFERRED_ASSIGN, SCHEDULER_HOLD_*,
                     ASSIGN_BATCH_COMMIT are all unreadable through any API.
Current source       audit_logs
Exists internally?   The rows exist.
API exposes it?      NO
Recommended          GET /api/audit?entityType&action&zoneId&from&to, manager-roled + zone-clamped.
                     Note /dispatch/changes-today already covers "today, this zone, assignments" —
                     the gap is history and non-assignment actions.
Risk                 Medium — audit_logs is broad; needs careful scoping and paging.
```

### G9 — Run liveness is not exposed `MEDIUM`

```
What UI needs        "This run is alive" vs "this run may be dead" while status is RUNNING.
Why                  dispatch_runs.heartbeat_at advances per zone and is the reaper's own input, but
                     neither DispatchRunListRow nor DispatchRunDetail carries it. A UI cannot
                     distinguish a healthy long run from one about to be reaped.
Current source       dispatch_runs.heartbeat_at
Exists internally?   YES
API exposes it?      NO
Recommended          Add `heartbeatAt` + a derived `staleForMs` to the run row.
Risk                 Low.
```

### G10 — `dispatch_run_zones.finished_at` is not exposed `LOW`

```
What UI needs        Per-zone durations, to show which zone is slow.
Current source       the column exists and is written on every terminal path.
API exposes it?      NO — DispatchRunZoneCard omits both startedAt and finishedAt.
Recommended          Add both to the card.
Risk                 Low.
```

### G11 — `ZoneProjection` cannot report `bucketlessDropped` `LOW`

```
Why                  It is on RunSummary but not on ZoneProjection (recommender.service.ts:170-205),
                     so the preview cannot show the largest hidden population while the run can.
Recommended          Add it to ZoneProjection beside the other three.
Risk                 Low — one field; it is already computed on the dry path.
```

### G12 — The Intra-day Queue is structurally blind `LOW` (documented, superseded)

```
Why                  §5.10 — no admin code calls /intraday-updates/*, so listIntradayUpdates is
                     effectively always empty.
Recommended          Retire GET /api/intraday-updates in the UI in favour of
                     GET /api/dispatch/changes-today.  Backend change: none needed.
Risk                 None — a UI decision.
```

### G13 — `/schedules/:engineerId` has no date predicate `LOW`

```
Why                  getScheduleDetail (zm-schedule-query.service.ts:147-150) filters on live status
                     alone and orders by dispatchedAt desc. listSchedules gained ?date= (#284 §D);
                     the detail read did not. A ZM can be shown last week's plan as "today's".
Recommended          Accept ?date= on the detail route with the same additive posture.
Risk                 Low.
```

### G14 — MV freshness has no live endpoint `LOW`

```
Why                  config_snapshot.eligibilityMv is per-run and historical. A UI cannot say
                     "the floating pool is stale right now, before the 05:00 run."
Current source       PlantEligibleFloatingSeService.freshness()
Exists internally?   YES
API exposes it?      NOT FOUND IN CODEBASE on any scheduler controller.
Recommended          Fold it into G2's summary read.
Risk                 Low.
```

### G15 — Two definitions of "return due today" `LOW` (correctness, not exposure)

```
Why                  §9.4 — the recommender uses istDayStartInstant(now)+24h; the cockpit uses
                     istDate(now)+24h. They differ by 5h30m, so the RET chip and the sort key can
                     disagree for a report whose expected_from falls in that window.
Recommended          Have DispatchTodayQueryService.returnDueToday call returnDateArrivedBefore().
Risk                 Low — it is the shared definition's own job.
```

### G16 — `moveTickets` returns source ids, `swapSe` returns destination `LOW`

```
Why                  §32.3 — the OverrideOutcome shape is identical but its meaning is not. A client
                     that navigates to `result.seId` after a REASSIGN lands on the wrong engineer.
Recommended          Document it, or return both lanes.
Risk                 Low — but it will bite once.
```

---

## 40. SDS vs Implementation Gap Analysis

**Read §0.1 first.** The SDS is a *code-derived* document whose provenance claim (12,700 lines / 60
files) verified exactly (12,729 / 59). Agreement below therefore confirms the SDS is accurate; it is
not independent corroboration of the implementation. Disagreement is correspondingly significant.

### 40.1 The concept matrix

| SDS Concept | Expected Behaviour (SDS) | Actual Implementation | Status | Evidence |
|---|---|---|---|---|
| daily scheduler cadence | "every morning at 05:00 India time"; presented as fixed | `@Cron` re-pointed from `system_settings.dispatch_cron`; `'0 5 * * *'` is only a bootstrap default; validated with the parser that will run it; restart-free re-registration | **`IMPLEMENTED_DIFFERENTLY`** ⚠ **D3** | `dispatch-scheduler.service.ts:84`; `dispatch-schedule.service.ts:36-51,174-179` |
| the six intake gates | six gates, each holding work back for a different reason | all six exist, exactly as described, in one `where` | `IMPLEMENTED` | `recommender.service.ts:326-397` |
| …"counted separately on the run report" | implies six separate counts | **only three counters exist** — `withheldBelowThreshold`, `componentBlockedWithheld`, `bucketlessDropped`. Deferred / plant-deactivated / device-departed tickets are excluded with **no count anywhere** | **`PARTIALLY_IMPLEMENTED`** ⚠ **D2** | `:402-431, 439`; `schema.prisma:844-861` |
| the "three different people" rationale | policy vs coverage-gap vs data-fault must stay apart | exactly this, in the column comments and the read surfaces | `IMPLEMENTED` | `:83-115`; `dispatch-transparency-query.service.ts:57-71` |
| ticket ranking | 6 keys, Platinum→Silver, worst bucket first, return-date only below critical, rank, oldest, device id | 6 keys in that exact order, including the two-sided sub-CRITICAL gate | `IMPLEMENTED` | `canonical-sort.ts:83-116` |
| …determinism | "two runs on identical data always agree" | pure comparator, no SQL mirror, `deviceId` absolute tie-break | `IMPLEMENTED` | `canonical-sort.ts:6-13, 114` |
| install backlog | appended after troubleshoot in one mode, oldest first | appended in PREVENTIVE only; ordered tier → rank → oldest → ticketId (SDS simplifies to "oldest-first") | `IMPLEMENTED` | `:486-489`; `canonical-sort.ts:139-147` |
| priority-queue property | "an engineer filled up by ticket #3 is unavailable for ticket #40" | the in-run `assigned` counter is incremented on every win and gates `OVER_CAPACITY` | `IMPLEMENTED` | `:813`; `candidate-readiness.ts:59` |
| candidate tiers | 3 tiers, fixed precedence | `[...dedicated, ...multi, ...floating]`; first non-empty tier wins; score never crosses | `IMPLEMENTED` | `candidate-selection.service.ts:53`; `tier-score-chooser.ts:59` |
| floating live re-check | MV alone "can still name someone who was made dedicated or deactivated yesterday" | raw SQL joins `engineer_master` live on `coverage_type='FLOATING' AND is_active` | `IMPLEMENTED` | `candidate-selection.service.ts:41-50` |
| hard filters | 5, fixed order, first failure recorded, not traded off | `HARD_FILTER_ORDER` + `firstFailure`; `applyHardFilters` partitions, preserving order | `IMPLEMENTED` | `hard-filters.ts:48-118` |
| three-state honesty | passed / failed / **not enforced**; 2 of 5 have no feed | `type FilterState`; `vehicleReadinessEnforced` and `componentAvailabilityEnforced` both hardcoded `false` | `IMPLEMENTED` | `hard-filters.ts:45,64-79`; `candidate-readiness.ts:54-62` |
| planner pin ruling | overriding a pin "with no signal that it happened was judged the worse failure" | the pin is searched across **all** passing candidates, crossing tiers | `IMPLEMENTED` | `tier-score-chooser.ts:63`; `recommender.service.ts:655-661` |
| …pin silently dropped | *not addressed by the SDS* | a pinned SE who fails a hard filter is not in `passed`, the pin is ignored, **and nothing records it** | **`AMBIGUOUS`** — the SDS's stated principle is not fully met | §19.3, gap **G6** |
| unassignable tagging | "no coverage" vs "all dropped", with per-filter drop counts | `poolEmptyReason` + `dropCounts` on the trace, aggregated to `unassignableReasons` | `IMPLEMENTED` | `:701-733` |
| immediate counter update | day total and plants-for-today incremented at once | `assigned.set(...)`, `plantsBySe.add(...)`, `currentPos.set(...)` | `IMPLEMENTED` | `:813-825` |
| scoring formula | 6 weighted components, floored at zero, then × cluster | byte-for-byte the same expression | `IMPLEMENTED` | `scoring.ts:126-142` |
| component definitions | A=1.0/B=0.9; bucket position; `min(1,h÷168)`; `1÷(1+km)`; ×1.25 | `rankScore` `max(0,1−0.1i)`; `bucketRank/7`; `AGE_CAP_HOURS=168`; `1/(1+max(0,km))`; `DEFAULT_CLUSTER_MULTIPLIER=1.25` | `IMPLEMENTED` | `scoring.ts:89-105`; `canonical-sort.ts:77` |
| closed weight vocabulary | "a typo … can't create a lever that silently does nothing" | `SCORING_COMPONENTS` + `isScoringComponent`, validated by the admin API; 3 dead weights retired by migration | `IMPLEMENTED` | `scoring.ts:60-86`; `scoring-weights.controller.ts:28-31` |
| moving distance origin | "from where they'll be, not where they started" | `currentPos` seeded from last live stop → home base → null, advanced on each win | `IMPLEMENTED` | `:526-543, 820-825` |
| three trace verdicts | PASSED / DROPPED / never-scored-lower-tier | exactly three, with the same reasoning in the comment | `IMPLEMENTED` | `:917-921` |
| degeneracy flag | set when every winning-tier candidate scored identically | computed from the **score spread** (`< 1e-9`), not from distance | `IMPLEMENTED` | `:863-866` |
| retire-don't-delete | RETIRED, because deletion cascaded to the traces | `RETIRED_RECOMMENDATION_STATUS`; two sweeps changed from delete to `updateMany` | `IMPLEMENTED` | `recommendation-status.ts:1-27`; `:994-1004` |
| heartbeat | at admission and after every zone | `heartbeatAt: now` on create; `touchHeartbeat` after each `finalizeZoneClaim` | `IMPLEMENTED` | `:381, 1102, 756` |
| reaper 3 min / 10 min | and "deliberately below the 15-minute patience deadline" | `'*/3 * * * *'`, `DEFAULT_DISPATCH_STALE_RUN_MIN=10`, `DEFAULT_DISPATCH_RETRY_DEADLINE_MIN=15`, invariant stated in the same words | `IMPLEMENTED` | `dispatch-cron.ts:37,180,183,166-179` |
| wake-up refusal | a revived run "declines to overwrite" | `updateMany … status:'RUNNING'`; logs "finished after being reaped" | `IMPLEMENTED` | `:932-950` |
| preview writes nothing | implied throughout | count-pinned to zero writes across whole tables | `IMPLEMENTED` | `test/recommender-dry-run.e2e-spec.ts:130-135` |
| **staleness token round-trip** | "**re-submit the token** and the system answers FRESH or STALE — and if stale, hands back the current picture" | `checkStaleness` is fully implemented and **no controller route calls it**. The token is minted on every response and cannot be verified | **`EXPECTED_BUT_NOT_FOUND`** ⚠ **D1** | `scheduler-preview.service.ts:135-150`; no route in `schedules.controller.ts` |
| holds as the only pre-run lever | approval never required; inaction = the run proceeds | exactly; `placeHold` writes `deferred_until` only | `IMPLEMENTED` | `scheduler-preview.service.ts:14-29` |
| hold vs vehicle-return guard | refuses rather than overwriting; shows return context | 409 `CONFLICT_VEHICLE_UNAVAILABLE` with `expectedFrom` + `reportId`; confirm audits `overrodeVehicleReport` | `IMPLEMENTED` | `:182-193, 208-211` |
| override preview's four outputs | lanes, rank, route, conflicts | `OverrideImpact { from, to, rank, route, conflicts }` | `IMPLEMENTED` | `override-projection.service.ts:69-86` |
| …identical request body | preview and confirm cannot drift | both take `OverrideCommand` | `IMPLEMENTED` | `batches.controller.ts:76,104` |
| …three refusals | reports conflicts; states overload; refuses single-lane | all three, with the `>=` boundary matching the engine | `IMPLEMENTED` | `:189-192, 290-297`; `batches.controller.ts:89-94` |
| …unknown rank | "unknown, never unranked" | `rank: null`, with the rule in the docstring | `IMPLEMENTED` | `override-projection.service.ts:29-30` |
| distribute's 3 strategies | COVERAGE_TIER calls the real dry run; the other two allocate | exactly; `runForZone({dryRun,ticketIds,engineerIds})` vs `mostHeadroom` | `IMPLEMENTED` | `distribute-projection.service.ts:96-198` |
| …eligibility never re-derived | shared functions only | `CandidateQueryService` → `buildCandidateReadiness` + `applyHardFilters` | `IMPLEMENTED` | `:44-49, 143` |
| 6 override actions + two-lane column | 3 single-lane, 3 two-lane | the `OverrideCommand` union and `PROJECTABLE` set match exactly | `IMPLEMENTED` | `override.service.ts:29-35`; `override-projection.service.ts:88` |
| overrides commit immediately | no approval queue; reason code; OVERRIDDEN; audit in the same transaction; push | all five, via `withAudit` + `flagOverridden` + the outbox | `IMPLEMENTED` | `override.service.ts:151-232, 1099-1125` |
| two confirm gates | neither a refusal; deferred applies only to the 3 move actions | `MOVE_ACTIONS` set; both gates return a 409 then proceed on confirm | `IMPLEMENTED` | `:45, 168-214` |
| "nobody's decision gets overwritten" | conditional on the row still being live; audit rolls back | `stampOnceOrLose` + `LostRaceError` inside `withAudit` | `IMPLEMENTED` | `:259-270` |
| **"existing stops are never renumbered"** | stated as a section heading | true of every **move** — and **false for `REORDER`**, which renumbers all stops `1..n`, and for `insertAtTop`, used on every intraday CRITICAL assign | **`IMPLEMENTED_DIFFERENTLY`** ⚠ **D4** | `override.service.ts:383-388, 1078-1086` |
| rule 1 — never fabricate a default | not-enforced / not-available / unknown | `FilterState`, `NOT_AVAILABLE`, `rank: null`, `addSource: null` | `IMPLEMENTED` | `hard-filters.ts:45`; `distance.ts:12`; `add-source.ts:108-114` |
| rule 2 — one rule, one implementation | morning batch, critical sweep, console and all three previews share the functions | 15 shared-predicate modules, each with an agreement test | `IMPLEMENTED` | §3.3 |
| rule 3 — contain the blast radius | zone / engineer / notification boundaries | per-zone containment, per-SE transactions, outbox that never propagates | `IMPLEMENTED` | `:1085-1097`; `batch-assignment.service.ts:105-116`; `day-plan-notification-outbox.ts:121-130` |
| rule 4 — degrade loudly | stale MV logged and frozen; exhausted recovery surfaced | `warnIfEligibilityStale` + `config_snapshot.eligibilityMv`; `EXHAUSTED` + `lastError` on the rail | `IMPLEMENTED` | `:1270-1292, 1245-1259`; `dispatch-today-query.service.ts:98-105` |
| file reference table (19 paths) | — | **all 19 verified to exist** | `IMPLEMENTED` | §2.9 |
| "12,700 lines across 60 files" | — | **12,729 across 59** for the three named directories | `IMPLEMENTED` | §0.1 |

### 40.2 The four discrepancies, in full

#### D1 — The staleness round-trip is described as a working capability; no endpoint exists `HIGH`

```
SDS says      "Every preview comes back with a signed token capturing the numbers you were shown.
               Re-submit the token and the system answers [FRESH] or [STALE] — and if stale, hands
               back the current picture."
Code does     SchedulerPreviewService.preview MINTS the token on every response
                 (scheduler-preview.service.ts:123).
              SchedulerPreviewService.checkStaleness IS fully implemented (:135-150) — verifies,
                 re-previews, deep-compares countsByZone, returns
                 FRESH | TOKEN_INVALID | TOKEN_STALE + freshPreview.
              NO controller route calls it. NOT FOUND IN CODEBASE as an endpoint.
Status        EXPECTED_BUT_NOT_FOUND (the API) / IMPLEMENTED (the service)
Intentional?  Almost certainly NOT. The token is minted unconditionally, the verifier exists and is
              complete, and the sibling feature (bulk-unassign) wires the identical pattern
              end-to-end — its execute path verifies the token and returns 409 PREVIEW_TOKEN_STALE
              with freshPreview (bulk-unassign.service.ts:186-194). This reads as an unwired last
              mile, not a decision.
Impact        The SDS's stated purpose for the token — "to stop a manager acting on a plan that
              changed while they were reading it" — is unachievable through the API today.
Frontend      Do NOT build a staleness affordance on the scheduler preview. It cannot work.
              This is gap G1; the SDS confirmation raises its priority.
```

#### D2 — "Counted separately on the run report" is true of three gates, not six `MEDIUM`

```
SDS says      Presents all six intake gates in one table under "the tickets each one holds back are
              counted separately on the run report", each with a "whose problem is it?" value.
Code does     Three have counters and reach the ledger and the API:
                 withheldBelowThreshold      (#238)  dispatch_run_zones.withheld_below_threshold
                 componentBlockedWithheld    (#177)  .component_blocked_withheld  (nullable)
                 bucketlessDropped           (#242)  .bucketless_dropped          (nullable)
              Three do not. Deferred, plant-deactivated and device-departed tickets are removed by
              the `where` clause and counted NOWHERE — no column, no field, no log.
Status        PARTIALLY_IMPLEMENTED
Intentional?  Partly. The three that ARE counted were each added by a numbered issue with a written
              rationale; the other three were always simple exclusions. But the SDS's own principle
              ("three different people need to act on those three numbers") argues for the deferred
              count in particular, since a large held population is an operational fact a manager
              would want on the run report rather than only on today's cockpit.
Mitigation    "Held" IS visible elsewhere — /dispatch/today rails.held + situation.held, and
              /schedules/assignable-work totals.heldCount — just not per run, per zone.
Frontend      A UI built from the SDS's table will look for six figures on the zone card and find
              three. Deactivated-plant and departed-device exclusions are invisible everywhere.
```

#### D3 — 05:00 is operator-owned configuration, not a constant `MEDIUM`

```
SDS says      "Every morning at 05:00 India time…", "05:00 — 1ST DAILY RUN" as a headline stat,
              and "the 05:00 run" / "the 05:00 tick" throughout.
Code does     system_settings.dispatch_cron is the SOURCE OF TRUTH (#213).
              BUSINESS_SWEEP_DISPATCH_CRON is demoted to a bootstrap default, read once when no row
                 exists and never again (dispatch-cron.ts:98-105).
              The @Cron decorator argument is only a compile-time default; DispatchScheduleService
                 re-points the live job at boot (via main.ts, after listen()) and on every write.
              PUT /api/schedules/dispatch-schedule validates with the CronTime constructor taken off
                 the live job — "the parser that validates an operator's expression is byte-for-byte
                 the parser that will run it" — then persists, then re-registers. No restart.
              It accepts ANY valid expression, including sub-daily ones like '* * * * *'.
Status        IMPLEMENTED_DIFFERENTLY — the implementation is materially richer than described.
Intentional?  Yes — #213 is an explicit operator ruling ("changing the dispatch hour must not require
              a redeploy"). The SDS simply describes the default as though it were the design.
Impact        A frontend that hardcodes "05:00" will be wrong the first time an operator changes it,
              and silently so.
Frontend      Read GET /api/schedules/dispatch-schedule → { cron, timeZone, nextFireAt } and render
              nextFireAt. Never hardcode the hour. ⚠ Note this endpoint is OPERATIONS_HEAD-only —
              see gap G3, which this discrepancy makes materially worse for a ZM.
```

#### D4 — "Existing stops are never renumbered" holds for moves, not for REORDER `LOW`

```
SDS says      As a standalone claim under "Two safety properties in the write itself":
              "Existing stops are never renumbered. A move appends to the target's route, or joins
               their existing stop for that plant."
Code does     TRUE for moveTickets, swapSe and assignTicket — each appends at
                 max(stop_sequence) + 1 or joins the existing (schedule, plant) batch.
              FALSE for REORDER, which splices the target to the requested position and rewrites
                 EVERY stop on the schedule to 1..n (override.service.ts:383-388).
              FALSE for insertAtTop → moveBatchToTop, which renumbers all stops so the new work
                 leads the day (:1078-1086) — used on EVERY intraday CRITICAL direct assign.
Status        IMPLEMENTED_DIFFERENTLY — the sentence's body is exactly right; its heading
              over-generalises from moves to all writes.
Intentional?  The SDS is internally consistent: its own override table describes REORDER as "moves a
              stop's position in the engineer's route", so renumbering is clearly expected there.
              This is a scoping imprecision in the summary, not a contradiction of intent.
Frontend      After a REORDER or any intraday CRITICAL insertion, refetch the WHOLE schedule's stops.
              Do not patch a single stop's sequence locally.
```

### 40.3 Scope omissions — in the code, absent from the SDS

Not errors. The SDS's scope is `scheduling/` + `recommender/` + `planner/`; these live outside it or
were summarised to a phrase. They are listed because the SDS ends with a file table that reads as
complete, and a developer treating it as the full contract will be surprised.

| Absent from the SDS | Where it lives | Why it matters to the UI |
|---|---|---|
| **Bulk unassign** (OH-only, zone/pan-India, token-gated, 6 report classes, per-zone skip audit) | `scheduling/bulk-unassign.service.ts` (481 lines) | a whole admin surface with its own preview/execute contract |
| **Cross-zone escalation** (Platinum auto at 1 h CRITICAL+ / 4 h open; ZM manual flag; approve/deny/defer/re-escalate) | `cross-zone/` | a queue, a role ladder, and 6 audit actions |
| **Company tier overrides** (scoped, expiring, stacking, newest-wins) | `org/effective-tier.ts` + `company_tier_overrides` | they change **sort key #1**; frozen into every run's snapshot |
| **Stranded-work escalation (#288)** | `intraday/stranded-work-escalation.service.ts` | an engineer going unavailable now escalates their remaining work — a second cause of `ESCALATION_REQUIRED` the UI must distinguish |
| **The intraday CRITICAL sweep's own selection path** | `intraday/intraday-insertion.service.ts` (490 lines) | mentioned once as "the mid-day critical sweep"; it has its own weights rule, no planner pin, no kit filter, and escalates rather than bypassing capacity |
| **Nightly closure + recycling (#242)** | `scheduling/schedule-closure-scheduler.service.ts` | listed as a file path only; it is what returns unworked tickets to the pool |
| **Same-day recovery collector (#286)** | `dispatch-run.service.ts:624` | §10's "a zone that exhausts its recovery budget" is the only trace of it; the UI renders a 4-state rail |
| **Cross-instance tick claims (#263)** | `scheduling/cron-tick-claim*.ts` | `TICK_CLAIMED` is a no-op the UI must not render as an error |
| **Zone claims as durable rows** | `dispatch_run_zones` | "a crashed run still holds its zone claims" is the only mention; `CONTENDED` is a first-class zone outcome |
| **The transparency read APIs** | `dispatch-transparency-query.service.ts` (944 lines) | listed as a file path; it is five endpoints and the entire evidence surface |
| **The Crew Deck cockpit reads** | `dispatch-today-query.service.ts`, `dispatch-changes-today.service.ts` | not mentioned at all |
| **Shared Pool** | `shared-pool/` | the SE-facing secondary-work read |

### 40.4 What the SDS confirms

Worth stating positively, because it is most of the document. The SDS independently describes — and
the code implements — **every one** of: the 6 sort keys including the two-sided sub-CRITICAL
return-date gate; the 5 hard filters in exact order with 2 not-enforced; the tri-state honesty rule;
the 3 tiers with live re-validation of the floating leg; the full 6-component formula with
floor-then-multiply and every component's definition; the moving distance origin; the 3 trace
verdicts including the never-scored third; the degeneracy flag; retire-don't-delete and its cascade
rationale; heartbeat / 3-min reaper / 10-min threshold / 15-min patience **and the invariant between
them**; the revived-run refusal; holds as the only pre-run lever plus the vehicle-return guard; the
override preview's four outputs and three refusals; the 6 override actions with their two-lane
column; both confirm gates and why remove/defer/reorder sit outside the second; the
lost-race-aborts-with-its-audit-row property; and all four standing rules.

**No algorithmic discrepancy was found.** All four discrepancies are about *exposure* (D1, D2),
*configurability* (D3), or *scope of a summary sentence* (D4).

### 40.5 Known ADR supersessions found in code

Older written designs the code deliberately diverges from. **The SDS describes the post-supersession
behaviour in every case** — it does not carry the retired designs forward, which is further evidence
it was written from current source.

| Superseded | By | Where the code says so |
|---|---|---|
| ADR-0007 / ADR-0019 — the **approval gate** | Decision §7 — dispatch is immediate, ZM overrides post-hoc | `batch-assignment.service.ts:52-54`; `schema.prisma:620-621` |
| ADR-0016 / ADR-0024 — the **15-min heartbeat filter** | CONTEXT §3/§16 rev. 2026-06-09 — pings never gate | `hard-filters.ts:9-13` |
| Issues 29/30 — the **SE Acceptance offer/timeout** | #268 / #258 Q3 — CRITICAL is assigned directly, no SE veto | `intraday-insertion.service.ts:128-145` |
| ADR-0006 floating **distance/capacity tie-break** | applied via the hard-filter pass + score, not a separate step | `candidate-selection.service.ts:12-18` |
| D1 (bulk-unassign, today-only) | **reversed 2026-07-29 by the operator** — no date predicate | `bulk-unassign.service.ts:405-413` |
| "the live query mirrors the comparator as a stable SQL ORDER BY" | **it does not and never did** | `canonical-sort.ts:6-13` |

---

## 41. Code Reference Map

### 41.1 Decision path

| Behaviour | File · Function · Line |
|---|---|
| run orchestration | `scheduling/dispatch-run.service.ts` · `runForActiveZones` · 231 |
| admission + claims | ↑ · `admit` · 343 |
| config snapshot | ↑ · `captureConfigSnapshot` · 1183 |
| one zone | ↑ · `processZone` · 1075 |
| zone finalize | ↑ · `finalizeZoneClaim` · 1123 |
| patience | ↑ · `waitOutContention` · 992 |
| reaper | ↑ · `reapStaleDispatchRuns` · 506 |
| recovery mark | ↑ · `markZonesForRecovery` · 566 |
| recovery collect | ↑ · `recoverMarkedZones` · 624 |
| preview orchestration | ↑ · `previewActiveZones` · 800 |
| **the engine** | `recommender/recommender.service.ts` · `runForZone` · 268 |
| ticket selection | ↑ · 345 |
| rankability filter | ↑ · 434 |
| features | ↑ · `featuresFor` · 555 |
| the per-ticket loop | ↑ · 590 |
| unassignable branch | ↑ · 679 |
| assignable branch | ↑ · 764 |
| trace build | ↑ · 869 |
| weight resolution | ↑ · `activeWeights` · 1138 |
| planner read | ↑ · `plannerForDate` · 1111 |
| install backlog | ↑ · `installBacklog` · 1051 |
| return-due read | ↑ · `returnDueTickets` · 1041 |
| orphan retire | ↑ · `clearFinalizedOrphans` · 994 |
| canonical sort | `recommender/canonical-sort.ts` · `compareCandidates` · 83 |
| urgency | ↑ · `urgencyFromBucket` · 77 |
| install sort | ↑ · `compareInstallCandidates` · 139 |
| hard filters | `recommender/hard-filters.ts` · `applyHardFilters` · 107 |
| filter order | ↑ · `HARD_FILTER_ORDER` · 48 |
| tri-state | ↑ · `evaluateFilter` · 64 · `evaluateAllFilters` · 83 |
| readiness build | `recommender/candidate-readiness.ts` · `buildCandidateReadiness` · 46 |
| candidate discovery | `recommender/candidate-selection.service.ts` · `orderedCandidatesForPlant` · 23 |
| tier + score + pin | `recommender/tier-score-chooser.ts` · `chooseWithinTier` · 55 |
| scoring | `recommender/scoring.ts` · `scoreCandidate` · 107 |
| component vocabulary | ↑ · `SCORING_COMPONENTS` · 74 |
| weight reads | `recommender/scoring-config.ts` · `readBaseActiveWeights` · 25 |
| distance | `recommender/distance.ts` · `haversineKm` · 22 |
| plant geometry | `recommender/plant-geometry.ts` · `plantCoordinatesForZone` · 19 |
| rec status vocabulary | `recommender/recommendation-status.ts` · 17, 27 |

### 41.2 Commit + mutation path

| Behaviour | File · Function · Line |
|---|---|
| zone commit | `scheduling/batch-assignment.service.ts` · `dispatchForZone` · 85 |
| per-SE commit | ↑ · `dispatchForSe` · 147 |
| stop ordering seam | ↑ · `orderPlantStops` · 330 |
| per-SE skip labels | `scheduling/se-skip.ts` · `describeSeSkip` · 291 |
| overrides | `scheduling/override.service.ts` · `override` · 151 |
| single assign | ↑ · `assignTicket` · 404 |
| lane assign | ↑ · `assignLane` · 723 |
| move | ↑ · `moveTickets` · 924 |
| schedule ensure | ↑ · `ensureSchedule` · 1037 |
| overridden stamp | ↑ · `flagOverridden` · 1099 |
| closure + recycle | `scheduling/schedule-closure-scheduler.service.ts` · `closeZone` · 167 · `recycle` · 252 |
| bulk unassign | `scheduling/bulk-unassign.service.ts` · `executeZone` · 216 · `classifyZone` · 415 |
| intraday CRITICAL | `intraday/intraday-insertion.service.ts` · `assignCriticalForZone` · 172 |
| stranded work | `intraday/stranded-work-escalation.service.ts` · `escalateStrandedWork` · 57 |
| terminal closure | `scheduling/close-assignment.ts` · `retireAssignmentOnClosure` · 607 |

### 41.3 Read surfaces

| Surface | File · Function |
|---|---|
| runs / detail / zone / decisions / trace / batch | `scheduling/dispatch-transparency-query.service.ts` · 302 / 366 / 478 / 794 / 740 / 647 |
| cockpit | `scheduling/dispatch-today-query.service.ts` · `today` · 172 |
| changes ledger | `scheduling/dispatch-changes-today.service.ts` · `changesToday` · 56 |
| ZM schedules | `scheduling/zm-schedule-query.service.ts` · 114 / 146 / 209 |
| SE day plan | `scheduling/day-plan-query.service.ts` · `getDayPlan` · 26 |
| work pool | `scheduling/assignable-work-query.service.ts` · `listForScope` · 67 |
| candidate column | `scheduling/candidate-query.service.ts` · `listForPlants` · 94 |
| scheduler preview | `scheduling/scheduler-preview.service.ts` · `preview` · 100 |
| override preview | `scheduling/override-projection.service.ts` · `projectOverride` · 113 |
| distribute preview | `scheduling/distribute-projection.service.ts` · `project` · 64 |
| shared pool | `shared-pool/shared-pool.service.ts` · `getSharedPool` · 39 |

### 41.4 Shared predicates

`scheduling/committed-day-load.ts` · `scheduling/schedule-status.ts` ·
`scheduling/dispatch-zone-lock.ts` · `scheduling/zone-claim.ts` · `scheduling/add-source.ts` ·
`scheduling/removal-reason.ts` · `scheduling/coverage-at-assign.ts` · `scheduling/preview-token.ts` ·
`ticketing/deferral.ts` · `ticketing/assignable-work.ts` · `ticketing/component-blocked.ts` ·
`device-state/sla-bucket.ts` · `common/ist-day.ts` · `settings/assignment-threshold.ts` ·
`org/effective-tier.ts`

### 41.5 Test evidence index

| Claim | Test |
|---|---|
| canonical order is exact | `canonical-sort.spec.ts:26-35` |
| scoring shape + multiplier | `scoring.spec.ts` |
| tri-state filters + no PASSED for a stub | `hard-filters.spec.ts:76-115` |
| no heartbeat filter | `hard-filters.spec.ts:57-66` |
| dry run writes nothing | `recommender-dry-run.e2e-spec.ts:130-135` |
| **dry run == real run for today** | `recommender-dry-run.e2e-spec.ts:184-210` |
| preview holds no slot | `dispatch-preview.e2e-spec.ts:162-167` |
| real path refuses a future day | `dispatch-preview.e2e-spec.ts:175-180` |
| cluster multiplier decides | `recommender-score-selection.e2e-spec.ts:197-211` |
| precedence beats a clustered floater | `recommender-score-selection.e2e-spec.ts:215-226` |
| scoring never reorders tickets | `recommender-score-selection.e2e-spec.ts:229-252` |
| capacity counter follows the scored winner | `recommender-score-selection.e2e-spec.ts:257-275` |
| override preview writes nothing | `override-impact-preview.e2e-spec.ts:237-259` |
| override preview reports overload and still projects | `override-impact-preview.e2e-spec.ts:282-300` |
| display == enforcement for capacity | `capacity-overload-visibility.e2e-spec.ts` |
| planner bias crosses tiers | `recommender-planner-bias.e2e-spec.ts` |
| route ordering | `schedules-route-conflicts.e2e-spec.ts` |
| cron wiring / job names | `scheduler-wiring.e2e-spec.ts`, `business-sweep-scheduler-wiring.e2e-spec.ts` |
| cross-instance claims | `cron-tick-claims.e2e-spec.ts`, `cron-tick-window.spec.ts` |
| reaper | `dispatch-run-reaper.e2e-spec.ts`, `stale-run-reaper.e2e-spec.ts` |
| same-day recovery | `dispatch-crashed-zone-recovery.e2e-spec.ts`, `dispatch-recovery-guarantees.e2e-spec.ts` |
| bounded retry | `dispatch-cron-bounded-retry.e2e-spec.ts` |
| zone claim admission | `dispatch-zone-claim-admission.e2e-spec.ts` |
| per-SE isolation | `dispatch-per-se-isolation.e2e-spec.ts` |
| idempotency | `dispatch-idempotent.e2e-spec.ts`, `dispatch-uniques.e2e-spec.ts` |
| outbox exactly-once | `day-plan-notification-outbox.e2e-spec.ts` |
| aborted-run evidence survives | `dispatch-aborted-run-evidence.e2e-spec.ts` |
| IST boundaries | `ist-day-boundary-scheduling.e2e-spec.ts` |
| closure recycling | `schedule-closure-recycling.e2e-spec.ts` |
| the read predicts the write | `assignable-work.e2e-spec.ts` |
| cron config write path | `dispatch-schedule-config.e2e-spec.ts`, `dispatch-schedule-boot.e2e-spec.ts` |

---

## 42. Recommended Frontend Data Consumption Model

### 42.1 The complete frontend data map

| UI Feature | Data Needed | API | Backend Service | DB Source | Calculation | Refresh |
|---|---|---|---|---|---|---|
| Run history list | run rows + status + totals | `GET /dispatch-runs?limit=` | `DispatchTransparencyQueryService.listRuns` | `dispatch_runs` ⋈ `dispatch_run_zones` | ZM totals = their zone row; `durationMs`, `errorCount` at read time | poll while any `RUNNING` |
| Run detail header | actor, reason, duration, build | `GET /dispatch-runs/:runId` | `.getRunDetail` | `dispatch_runs`, `users`, `runtime_lock` | `staleBuild` compare | once per run |
| Config in effect | weights, capacity map, settings, tier overrides, MV freshness | ↑ `configSnapshot` | `captureConfigSnapshot` | frozen JSONB | none — historical | never |
| Zone cards | the funnel + outcome + skips + live counters | ↑ `zones[]` | `.getRunDetail` | `dispatch_run_zones` + live batch rows | `ticketsStillAssigned`/`RemovedSince` at read time | on run finalize |
| Zone drill-down | batches, unassignable, plant stats | `GET /dispatch-runs/:runId/zones/:zoneId` | `.getZoneDetail` | batches, traces, `device_states`, tickets | `capacityUsed` = live used / frozen cap | on demand |
| **Replay stream** | every decision in processing order | `GET /dispatch-runs/:runId/decisions` | `.getRunDecisions` | `dispatch_decision_traces` ⋈ recs ⋈ tickets | ordered by `processing_rank`, `traceId` | cache per page |
| **Why this SE** | full trace + names + identity | `GET /dispatch-runs/:runId/tickets/:tid/trace` | `.getTicketTrace` | trace + rec + ticket | none | cache forever |
| Batch table | rows with rank, score, degeneracy, device context | `GET /batches/:batchId` | `.getBatchDetail` | batch ⋈ tickets ⋈ recs ⋈ traces | `score` from breakdown; `scoreDegenerate` from trace | after any override |
| **Crew Deck (cockpit)** | lanes, stops, tickets, rails, situation, recovery | `GET /dispatch/today?zoneId=` | `DispatchTodayQueryService.today` | schedules, batches, tickets, traces, insertions, recoveries | `committedDayPlan`; `overCapacity` `>=`; `situation` counts | after every mutation |
| Change ledger | human adds/removes/swaps | `GET /dispatch/changes-today?zoneId=` | `DispatchChangesTodayService` | `batch_assignment_tickets` both legs | swap pairing by `REASSIGNED` + destination `addSource` | with the cockpit |
| **Scheduler Preview** | projected plan for any IST day | `GET /schedules/preview?date=` | `SchedulerPreviewService.preview` | the whole engine, dry | `runForZone({dryRun})` | on demand |
| Holds panel | held tickets | ↑ `holds[]` | `.holdsInForce` | `tickets.deferred_until` | `deferredUntil > day` | after a hold write |
| Place / release hold | — | `POST /schedules/holds`, `/holds/release` | `.placeHold` / `.releaseHold` | `tickets`, `audit_logs` | — | invalidate preview + today |
| **Work pool** | company → plant counts | `GET /schedules/assignable-work` | `AssignableWorkQueryService` | tickets + `device_states` | `assignableTickets` / `heldTickets`, counted in memory | after a commit |
| **Candidate column** | engine-ordered candidates + verdicts | `GET /schedules/candidates?plantIds=` | `CandidateQueryService` | `se_coverage`, MV, `engineer_master`, availability, van stock | `buildCandidateReadiness` + `applyHardFilters` | on plant change |
| Resolve draft → ids | ticket ids per plant | `GET /schedules/assignable-tickets?plantIds=` | `.ticketIdsForPlants` | tickets | same predicate | before review |
| **Distribute** | lanes + unplaced + overload | `POST /schedules/distribute-preview` | `DistributeProjectionService` | engine (COVERAGE_TIER) or candidates | 3 strategies | on strategy change |
| **Commit a plan** | — | `POST /schedules/assign-batch` | `OverrideService.assignBatch` | everything | per-lane transaction | invalidate all |
| **Override preview** | two-lane capacity, rank, route, conflicts | `POST /batches/:id/override/preview` | `OverrideProjectionService` | `committedDayPlan`, trace, schedules | arithmetic only | on proposal change |
| **Override commit** | — | `POST /batches/:id/override` | `OverrideService.override` | everything | — | invalidate both lanes |
| Engineer picker | committed / capacity / coverage | `GET /schedules/engineers` | `ZmScheduleQueryService.listZoneEngineers` | `engineer_master` + `committedDayLoad` | load **not** zone-filtered | after a commit |
| Schedules list | live plans | `GET /schedules?date=` | `.listSchedules` | `work_schedules` | **pass `?date=`** | after dispatch |
| Schedule detail | stops + reasoning chips | `GET /schedules/:engineerId` | `.getScheduleDetail` | schedule ⋈ batches ⋈ tickets ⋈ recs | latest non-RETIRED rec | after an override |
| Escalation queue | insertions + current assignee | `GET /intraday-insertions` | `IntradayInsertionService.listForScope` | `intraday_insertions` + live batch rows | `currentAssigneesFor` | poll (2-min sweep) |
| Escalation candidates | AVAILABLE candidate rows | `GET /intraday-insertions/:id/available-ses` | `.availableSesForManualAssign` | via `CandidateQueryService` | filtered on `availabilityStatus` only | on open |
| Resolve escalation | — | `POST /intraday-insertions/:id/manual-assign` | `.manualAssign` | everything | — | invalidate queue + today |
| Dispatch schedule | cron + next fire | `GET/PUT /schedules/dispatch-schedule` | `DispatchScheduleService` | `system_settings` + the live job | `nextFireAt` from the registry | on write |
| Run now | — | `POST /schedules/dispatch-run` | `DispatchRunService` | everything | — | invalidate all |
| In-flight guard | which zones are held | `GET /schedules/dispatch-run/in-flight` | `.inFlightZones` | `dispatch_run_zones` | live claims | poll while visible |
| Bulk unassign | class counts, then execute | `POST /schedules/bulk-unassign` | `BulkUnassignService` | batches + tickets | 6 classes, token-signed | invalidate all |
| Bulk history | past operations | `GET /schedules/bulk-unassign/history` | `.history` | `audit_logs` | metadata reshaping | on demand |
| Scoring weights | weights + vocabulary | `GET/POST /org/scoring-weights[/components]` | `ScoringWeightsService` | `priority_rule_config` | validated against `SCORING_COMPONENTS` | on write |
| SE Planner grid | pins + plants | `GET/POST/DELETE /planner[...]` | `SePlannerService` | `se_planner` | idempotent upsert | on write |
| SE Day Plan (mobile) | ordered stops | `GET /schedules/me` | `DayPlanQueryService` | schedule ⋈ batches ⋈ tickets | hollow stops omitted | on notification |
| SE Shared Pool | covered-plant open work | `GET /me/shared-pool` | `SharedPoolService` | tickets at covered plants | `coveredPlantIds` ∪ MV | on demand |

### 42.2 Suggested page compositions

**Scheduler Overview (fleet)** — the composition that works today:
```
GET /dispatch-runs?limit=30                    → history + current + last SUCCESS (client-derived)
GET /dispatch-runs/{latest}                    → per-zone funnel
GET /schedules/dispatch-schedule               → next fire        [OH only — G3]
GET /schedules/dispatch-run/in-flight          → live zones       [OH/CSM — G3]
```

**Run Detail → Replay → Why-this-SE** — three levels, three calls:
```
GET /dispatch-runs/:runId
GET /dispatch-runs/:runId/decisions?zoneId&limit=100&offset=
GET /dispatch-runs/:runId/tickets/:ticketId/trace          (on row click)
```

**Crew Deck (per zone)**:
```
GET /dispatch/today?zoneId=N
GET /dispatch/changes-today?zoneId=N
  writes → POST /batches/:id/override/preview → POST /batches/:id/override
        → POST /intraday-insertions/:id/manual-assign
```

**Assign Work Console**:
```
GET /schedules/assignable-work                             → the pool
GET /schedules/candidates?plantIds=…                       → the column
POST /schedules/distribute-preview                         → optional spreading
GET /schedules/assignable-tickets?plantIds=…               → resolve to ids
POST /schedules/assign-batch                               → commit
```

**Scheduler Preview**:
```
GET /schedules/preview?date=YYYY-MM-DD
  → render zones[].decisions, zones[].plan, holds[]
  → ALWAYS display bucketsAsOf for a future date
  → previewToken cannot currently be verified (G1)
POST /schedules/holds | /schedules/holds/release
```

### 42.3 Cross-cutting rules

- **Poll only while something is live.** `dispatch_runs.status === 'RUNNING'` or a visible Run-now
  button. Nothing else has a server-push channel.
- **Do not cache anything zone-scoped across an acting-zone switch** — the server's answer changes,
  and the `X-Acting-As-Zone` header is honoured on only some routes (§24.1).
- **Treat every id as an opaque string.**
- **Render the four funnel populations separately.** Merging them is the single most likely way to
  make a healthy system look broken.

---

## 43. Unknowns / Ambiguities

Everything this investigation could not settle from code alone.

| # | Unknown | Why it could not be settled | Impact |
|---|---|---|---|
| U1 | Whether the OCR reconstruction of the SDS's hard-filter table is exactly right | The pasted text lost row 1's filter name and shifted the rest up one row (§0.1). Row 1's *description* ("their van is mid-trip") maps unambiguously to `VEHICLE_ON_TRIP`, and the resulting order matches `HARD_FILTER_ORDER` exactly, so the reconstruction is near-certain — but it is a reconstruction. | None material. Both readings agree that 2 of 5 filters are not enforced and that the order is fixed. |
| U1b | Whether the SDS's PDF contained material the pasted text lost | The PDF is destroyed; the text was supplied separately, and any figure rendered as an image is absent. Traceable headings in the paste are: the unnumbered opener, **§3** Recommender, **§4** Maths, an unlabelled block on trace verdicts (almost certainly §6), **§7** Resilience, the three previews (§8), **§9** Human control, **§10** Character, and the Reference table. | **SDS §1, §2 and §5 were never seen.** By position they likely cover the run's own lifecycle and the modes/zone processing — areas §§4–8 of this document cover from code, but which could contain SDS claims this comparison never tested. |
| U2 | Whether the `/api` prefix survives deployment | `app.config.ts:18` sets it, and every admin client hardcodes `.../api`. No reverse-proxy config was inspected. | Routes are documented as `/api/...`; verify against the deployment. |
| U3 | Whether `dispatch_run_zones.se_skips` is ever populated on a real run | `LOCK_CONTENDED` has no live writer in `BatchAssignmentService` post-#262 (§21.6); the lock timeout surfaces as a `seSkip`. Not reproduced against a live DB. | The UI should handle both, and treat a non-null zone `error` as authoritative. |
| U4 | The real cost of `orderedCandidatesForPlant` per ticket | 2 queries × N tickets per zone-run; no benchmark exists in-repo. `candidate-query.service.ts:65-72` flags the fan-out for Distribute but measures nothing. | A large zone's run time is unknown; the 10-min reap threshold assumes it is well under that. |
| U5 | `assignedSeId` on `tickets` | The column exists (`schema.prisma:2528`, RECOVERY workflow) and is **not** read by any scheduler path — assignment lives in `batch_assignment_tickets`. Whether the two can disagree was not traced. | Do not read `tickets.assigned_se_id` for scheduler purposes. |
| U6 | `intraday_insertions.retry_count` / `retry_chain` | Persisted, defaulted, surfaced on `IntradayInsertionRow` — but the offer machinery that incremented them was deleted by #268. | Almost certainly always 0 / `[]`. `DEAD/UNUSED`. |
| U7 | `priority_rule_config.effective_from` | Column exists; no reader found. | `DEAD/UNUSED` — weights take effect immediately on `active`. |
| U8 | `engineer_master.shift_start` / `shift_end` | Persisted; no scheduler read found. | `DEAD/UNUSED` — availability windows are the real mechanism. |
| U9 | Whether `BatchesController`'s hardcoded `actedAsRole: null` (`:110`) is intentional | Every sibling controller resolves `CurrentActor`. No comment explains it. | An acting CSM's override audits without the acting role. |
| U10 | The `plannerBias` baseline (`passed[0]` vs the score winner) | §18.4 — the expression is deliberate in the trace, but whether "differed from precedence" is the intended semantics is not stated. | The flag may over-report. |
| U11 | Whether the 2-min `business-critical-assign` sweep can starve the 05:00 run | Both take zone-level resources; the CRITICAL sweep takes **no** zone claim and **no** advisory lock, so it can write assignments mid-dispatch. | Not analysed in code or tests. Possible interleaving worth measuring. |
| U12 | What the SLA `sla_rule_config` table is for, dispatch-side | It exists with `submit/verify/escalate` windows; **no scheduler read**. | Not a dispatch input today. |
| U13 | Whether `ZoneScopeGuard` covers routes beyond `:zoneId`/`?zone_id` | Referenced (`dispatch-runs.controller.ts:33`) but its source was not read. | §38.4's refusal styles were derived from the services, which is the authoritative layer. |
| U14 | Live behaviour under a stale MV | `isMvStale` degrades to "stale" and the run proceeds. Whether floating candidates are then materially wrong depends on how often territory changes. | Unmeasured. |

---

## 44. Final Findings

### 44.1 The ten things that most shape the frontend

1. **Tier is inviolable; the score decides only within a tier; only a human pin crosses.**
2. **`recommended + unassignable` is not the funnel.** Four populations sit outside it, three of them
   nullable, each sending a different team. Merging them misreports a healthy system.
3. **Previews are the real engine with writes suppressed**, count-pinned and decision-pinned by tests
   — but only the scheduler preview drives the engine; two of Distribute's three strategies are
   allocation *policy*, not prediction.
4. **Overload is blocked on automatic paths and only *shown* on manual ones.** No manual assign
   endpoint consults capacity at all.
5. **`null` is never zero.** Four separate sentinels (`null`, `NOT_AVAILABLE`, `NOT_ENFORCED`, absent
   map entry) each carry an explicit contract the code forbids rendering as a value.
6. **Zone scoping is server-side and its refusal style is not uniform** — 403, 404, and silent
   omission all occur.
7. **The decision trace is bounded at 5 runners-up.** Beyond that only counts survive; the rows never
   existed.
8. **`GET /api/schedules` returns stale plans unless you pass `?date=`**, and the detail route cannot
   take one at all.
9. **The Intra-day Queue is structurally blind** to the overrides the product actually performs;
   `/api/dispatch/changes-today` is the replacement.
10. **There is no fleet-wide scheduler dashboard read, and a ZM cannot see the next run time.**
11. **05:00 is a default, not a constant.** The schedule is operator-owned config, changeable without
    a restart. Never hardcode it. (D3)

### 44.1b The SDS comparison, in one paragraph

The SDS is a **code-derived** document — its own provenance claim (12,700 lines / 60 files) verified
exactly (12,729 / 59), and it describes post-supersession behaviour throughout. It is accurate:
**no algorithmic discrepancy was found** across the sort keys, the five filters, the tri-state rule,
the tier precedence, the full scoring formula, the three verdicts, the degeneracy flag,
retire-don't-delete, the heartbeat/reaper/patience invariant, the hold semantics, the override
preview's outputs and refusals, the six override actions, both confirm gates, and all four standing
rules. The four discrepancies that do exist are about **exposure**, not logic: a documented manager
capability with no endpoint (**D1** — the preview staleness round-trip), a "counted separately" claim
true of three gates out of six (**D2**), a configurable schedule presented as a fixed hour (**D3**),
and a safety property whose heading over-generalises from moves to all writes (**D4**). Because the
SDS was written *from* this code, agreement confirms the SDS rather than corroborating the
implementation — and D1 is therefore the most interesting finding in the comparison, since it is the
one place the document describes something an operator cannot do.

### 44.2 Investigation quality notes

- **Code comment density is exceptionally high and unusually reliable.** Comments repeatedly state
  what a thing *used to* do, why it changed, and what was *measured* rather than reasoned about
  (Prisma's negated to-one filter, `meta.target`'s absence under the driver adapter, the double-`OR`
  spread). Several corrected their own stale docstrings in place (`canonical-sort.ts:6-13`). They
  were treated as strong evidence and, where checkable against code, were correct every time.
- **Test coverage of the algorithm is genuine**, not incidental: pure specs pin the sort order, the
  scoring shape and the tri-state filters; e2e specs pin the preview-vs-real equivalence, the
  zero-write guarantees (by whole-table count), the capacity display/enforcement agreement, and every
  concurrency mechanism.
- **The anti-drift discipline is real and enforced** — 15 shared-predicate modules, each with at
  least one test asserting two callers agree.

### 44.3 What was not verified

- Nothing was executed. The working tree does not compile (§0.2), so no test was run and no endpoint
  was exercised. Every claim is from source reading.
- No database was inspected. Row counts quoted (5,127 bucketless; 4,983 double-limbo; 1,092
  auto-recovery; 351 closure-residue; 190 accreted schedules) are **quoted from in-repo comments**,
  which name them as measurements taken at the time of writing — not re-measured here.
- The `plant_eligible_floating_se` MV definition lives in a migration that was not read; its
  composition is taken from the service docstring.

### 44.4 Immediate recommendations

1. **Revert the stray edit** at `scheduler-preview.service.ts:221` — the tree does not build.
2. **Wire the staleness endpoint (D1 / G1).** The SDS documents "re-submit the token" as a working
   manager capability; `checkStaleness` is complete and has no route. This is the only place the SDS
   describes something an operator cannot actually do.
3. **Stop treating 05:00 as a constant (D3).** The frontend must read
   `GET /api/schedules/dispatch-schedule` → `nextFireAt`. This makes G3 urgent rather than cosmetic:
   the endpoint is `OPERATIONS_HEAD`-only, so a Zonal Manager currently has no way to learn when the
   run fires.
4. **Widen `dispatch-schedule` / `in-flight` to `MANAGER_ROLES`** (G3) — see above.
5. **Surface `bucketsAsOf` on real runs** (G4) — it is already computed and thrown away.
6. **Decide whether the three uncounted intake gates should be counted (D2)** — deferred in
   particular. The SDS's own "three different people" principle argues for it; the code counts three
   of six.

---

*End of walkthrough.*
