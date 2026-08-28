# Scheduler Console — Feasibility & Build-Strategy Review

> **Status: validation report. Nothing was implemented and no source file was modified.**
>
> **Date:** 2026-08-27 · **Branch:** `feat/autoplant-integration` · **HEAD:** `56f5aec`
>
> **Question asked:** can the Scheduler Console we are envisioning actually be built, and what is the
> best way to build it given the current system?
>
> **Evidence hierarchy used, as instructed:** CODE → technical walkthrough (**W**) → UI specification
> (**UI**) → product vision analysis (**A**) → earlier business/design records. Where sources
> disagree the conflict is **stated in §1, not silently reconciled.**
>
> Tags: `[CODE]` read from source this pass · `[DOC]` from a repo document · `[INFER]` reasoned ·
> `[OPEN]` unresolved.

---

## 0. The verdict

**Yes — but not as one surface, and the word "console" is doing two different jobs in the brief.**

Three findings drive everything below.

**Finding 1 — the console is a composition problem, not an engine problem, and that is why it is
feasible.** The scheduler is a five-layer pipeline. Layer 4 — every query, override and projection
service — *decides nothing*; the code says so in its own words: *"This service decides nothing"*
`[CODE — dispatch-today-query.service.ts:156]`. **Every screen a console would contain is an L4
surface.** There is no engine change anywhere in this brief. `[DOC — W§3.2, A§5]`

**Finding 2 — the primary read already carries almost everything, including every id the actions
need.** `GET /dispatch/today` returns run, recovery, six counters, crew lanes, ordered stops, tickets
with provenance, four rails and escalations **in one call** — and `batchId`, `ticketId`, `seId`,
`plantId`, `stopSequence` and `insertionId` are all in it. The cockpit is **one screen away from
being commandable and zero endpoints away.** `[CODE — dispatch-today-query.service.ts:10-51, 126-150,
cross-checked against override.service.ts:29-35]`

**Finding 3 — and here is the bound.** That read is keyed on **(zone × today)**. It has no `date`
parameter and it refuses to serve "all zones" *on purpose*: *"'all zones' is not a cockpit, it is a
different product."* `[CODE — dispatch-today.controller.ts:53-58]`

So:

> **Everything in the brief that lives inside one zone's operating day is buildable, most of it with
> zero backend work. Everything that does not — other dates, other zones, immutable history — is not
> a panel that was left out of the console. It is a different surface, and forcing it into the same
> frame is the one way to make this worse than what exists.**

**The recommendation is therefore three surfaces, not one and not six** (§3). That is a deliberate
challenge to *both* the brief ("one workspace") and the UI specification ("six, and none may merge").

---

## 1. Where the sources disagree

Five real conflicts. Each is stated, then a recommendation with its reason.

### C1 — UI§37 says six surfaces and that **none** may be merged. The product direction says one.

UI§37.1 tabulates six engine concepts and answers *"Could it be merged?"* with **"No"** six times,
concluding *"six surfaces for six concepts."* `[DOC — UI§37.1]` It sits **above** the vision analysis
in the hierarchy, so this is not a conflict I may wave away.

**Recommendation: the UI spec is right about the *properties* and over-reaches in the *conclusion*.**

Its six "No"s are each argued from a genuine, code-verified property — date-addressable, immutable,
separately deep-linkable, spans zones. Those properties are real. But a property that forbids two
things sharing **one frame** does not automatically forbid them sharing **one workspace**. Read the
six reasons carefully and they collapse into exactly **two** hard separations:

| UI§37's reason | Is it a hard separation? |
|---|---|
| Preview — *"date-addressable and must never read as a commitment"* | **Yes.** Different key, different mutability, different mood |
| Dispatch Runs — *"evidence is immutable and separately addressable"* | **Yes.** Its own object, its own lifetime, deep links must survive |
| Today's Dispatch — *"the only surface that answers now"* | No — that is the console itself |
| Schedule Detail — *"where the six override actions live"* | **No.** The actions need `batchId`/`seId`/`stopSequence`, all of which the cockpit payload already carries `[CODE]` |
| Assign Work — *"a multi-step drafting workflow"* | No — that argues for a distinct *mode*, not a distinct route (§3.2) |
| SE Planner — *"a grid over dates × plants"* | It is date-addressable, so it falls under the Preview separation |

**Two hard separations, not six.** Notably, UI§37 also states the merges it *does* make — zone view,
capacity and holds are "a panel, rail, drawer or badge inside one of them… none of them is a
destination an operator navigates *to*." That is the exact test this review applies; applying it one
level further is a continuation of the spec's own reasoning, not a departure from it. `[INFER]`

### C2 — `#280 R7` forbids merging `/assign` with the dispatch timeline. The direction requires it.

> *"`/assign` is a **write** surface for human decisions; the dispatch timeline is largely a **read**
> surface for the engine's decisions. They are adjacent and must not be merged."*
> `[CODE — 280-decision-dispatch-timeline-ia.md:127-133]`

Reaffirmed by `#282 R1` and by the 2026-08-25 forensics report. **Critically: `#280 R2` carries an
explicit escape clause — *"unless the operator later rules otherwise"*, *"revisit with evidence, not
preference"*. R7 carries none.** `[CODE — verified verbatim this pass]`

**Recommendation: overturn R7 in a written decision record — but do not merge the way R7 fears.**

R7's actual concern is not *adjacency*, it is *blurring*: a lane that holds both a chip which writes
nothing and a chip whose every move writes immediately. That hazard is real and technical, not
aesthetic. It can be honoured while still delivering the product goal:

> **Assign is a *mode* of the console with its own board region — sharing the frame (zone, engineer
> roster, attention, capacity) but never sharing a lane object with committed work.**

The operator stops leaving the workspace, which is what the brief asks for. Draft and committed never
occupy one shape, which is what R7 protects. `[INFER]`

If the operator will not overturn R7, the console is still worth building — it simply excludes the
work pool, and `/assign` remains one link away.

### C3 — `INDEX.md` marks `#285` **DONE** including *"Run-dispatch relocated"*. The code disagrees.

`TodaysDispatchPage.tsx:422-424` renders:

```tsx
<Link to="/bulk-unassign">
  <Button variant="secondary">Run dispatch</Button>
</Link>
```

and the only caller of `POST /schedules/dispatch-run` in the entire admin app is
`api/bulkUnassign.ts:136`. `[CODE — verified this pass, grep across apps/admin/src]`

**Two tracking sources also disagree with each other:** `INDEX.md:548` says *"✅ DONE 2026-08-25"*;
the issue file's own header says `Status: **ready-for-agent** (after #284, #283)`.
`[CODE — 285-todays-dispatch-cockpit.md:3]`

**Recommendation: code wins. Treat the Run-dispatch relocation as NOT done**, and correct both
records rather than only one. This matters directly to D4 — anyone scoping from INDEX would believe
the work is already delivered. The rest of `#285` (Plan/Live/Replay, deck, rails, interception strip)
**is** genuinely built and verified. `[CODE — TodaysDispatchPage.tsx, 553 lines]`

### C4 — UI§7.1 / G-UI-16 say there is no zone-list endpoint. There is.

`GET /api/org/zones` exists and is roled `CENTRAL_SERVICE_MANAGER, OPERATIONS_HEAD` — exactly the two
roles that need the picker — and the admin client already wraps it as `listZones()`.
`[CODE — org/zones.controller.ts:26-30; apps/admin/src/api/org.ts:82]`

**Recommendation: code wins; the spec's proposed workaround is unnecessary.** This was flagged in A
and is re-verified here. The cockpit currently reads its zone from a URL query parameter only
(`params.get('zoneId')`) with no picker and no zone fetch, so a CSM or OH opening `/dispatch/today`
without a hand-crafted URL gets `400 ZONE_REQUIRED`. `[CODE — TodaysDispatchPage.tsx:48]`

### C5 — `RepeatEscalationService`'s docstring says its cron is deferred. It is wired.

*"Scheduling (cron) is deferred, same posture as Issue 04's BullMQ"* — but the job is registered at
`business-sweep-scheduler.service.ts:240-243` under `BUSINESS_SWEEP_REPEAT_ESCALATION_CRON`.
`[CODE]`

**Recommendation: code wins.** The stale docstring matters because it makes the D1a defect look
dormant when it is running daily.

---

## 2. Feasibility, requirement by requirement

The brief's §5 and §7, scored against the backend. **Green = buildable now with no backend change.**

### Buildable today, zero backend work

| Requirement | Served by |
|---|---|
| Today's scheduler result — engineers, plants, devices, tickets, status | `GET /dispatch/today` (one call) |
| Unresolved work, exceptions, capacity, attention (scheduler-internal) | same payload — rails, counters, escalations, recovery, `seSkips` |
| **All six override actions** — reassign, remove, defer, reorder, swap SE, split batch | ids already in the payload; endpoints already exist |
| **Override impact preview** (3 of 6 actions) | `POST /batches/:id/override/preview` (`#289`, done) |
| Assign a ticket · place / release a hold | `ticketId` already in both rails |
| Candidates for a plant — the engine's own eligibility, drops included | `GET /schedules/candidates?plantIds=` |
| Resolve a critical escalation | `insertionId` in payload + existing modal |
| Decision stream + per-ticket trace | `GET /dispatch-runs/:runId/decisions`, `…/trace` |
| **Score breakdown + per-candidate filter states** | **served today and discarded by the client** |
| Tier-grouped candidate ranking | data present; only a flat list is rendered |
| Zone picker for CSM/OH | `GET /org/zones` (C4) |
| Run Now + in-flight guard | `POST /schedules/dispatch-run`, `GET …/in-flight` |
| Ticket journey — created → assigned → reached → troubleshooted → verified → resolved | `GET /tickets/:id` (`lifecycle[]`), `/attempts`, `/forms` |
| Zone → company → plant → device drill-down with telemetry | `dashboard/zone-overview` → `company-plant-overview` → `GET /devices` |
| Repeated Inactive list (D1) | derived from `failure_cycles`; no new table |

### Buildable after small, named backend work

| Requirement | Gap | Shape of the fix |
|---|---|---|
| A ZM knowing **when the run fires** | `dispatch-schedule` is OH-only | read-only `nextFireAt` for manager roles |
| All six funnel populations on the live screen | `componentBlockedWithheld`, `bucketlessDropped` are per-run only | add two counts to `TodaySituation` |
| **ZM Run Now, safely** (D5) | `zoneId` is taken from the request body **unclamped** | force zone from token claims for `ZONAL_MANAGER` (§4.4) |
| "Why is this ticket here?" from a ticket | a trace needs its `runId` first | `GET /tickets/:id/decision` |
| Actor **names** on the change ledger and ticket history | bare UUIDs | one name lookup |
| Attention counts co-scoped with the deck | Special / Repeated Inactive / return-dates are separate reads | one `GET /attention?zoneId=` **or** extend the cockpit payload |
| Two panes on one screen scoped identically | acting-zone honoured on ~half the `/schedules` routes | finish `#239` |

**That acting-zone item changes severity when the console lands.** Across separate pages it is
confusing; on one screen showing two panes at once it is **incorrect**. `[DOC — A§26 B3]`

### NOT buildable — must be designed around, never promised

| Wanted | Reality |
|---|---|
| A **fleet-wide / pan-India scheduler view** | No aggregate read exists. The backend refuses to guess a zone deliberately |
| A **date picker on the live console** | `GET /dispatch/today` is `istDate(now)`, always |
| *"What the Scheduler decided for tomorrow"* | **Nothing is decided for tomorrow.** Only a projection exists (§3.3) |
| A **staleness badge on the projection** | `checkStaleness()` is implemented at `scheduler-preview.service.ts:135` and **no route calls it** `[CODE — grep across every scheduling controller]` |
| **Cancel / pause / retry a run** | No API. `ABORTED` is reaper-only and means *"the process stopped existing"* |
| **Run progress %** | The engine has no stage concept and no total-zone count while running |
| **Live GPS / ETA / route line / map** | Ruled out (`#258 Q6`, `#272 R7`). Distance exists only as a scoring term |
| One atomic **"Commit all changes"** | No backend construct; `#272 R8` rules per-item commit and per-item results |
| **Per-ticket priority / "promote this"** | No mechanism at any level (§4.3) |
| **Preview of a configuration change** | The projection takes no weight or threshold parameters |

**Every item in that table is a place where a plausible wireframe would create a promise the engine
cannot keep.** They are listed so the design phase can refuse them once, on the record.

### The honest overall score

| | Share of the brief |
|---|---|
| Buildable now, no backend | **~65%** |
| Small named backend work | **~20%** |
| Not buildable — design around | **~15%** |

`[INFER — proportion of brief §5/§7 line items]`

---

## 3. The best way to build it: three surfaces

### 3.1 The architecture

```
┌─ CONSOLE ─────────────────────────────── (zone × operating day) · MUTABLE · indicative ──┐
│                                                                                          │
│  FRAME     zone ▾ · today · run pill · [Run now] · find ticket/SE                        │
│            ── fleet band (distinct): devices · silent · critical  → drill out            │
│  HEALTH    recovery · stale eligibility view · stale build · SE skips     (conditional)  │
│  SITUATION six funnel counters — never summed                                            │
│                                                                                          │
│  BOARD                            │  INSPECTOR  (one selected object)                    │
│   crew lanes · ordered stops      │   identity + provenance                              │
│   rails: unassignable · held ·    │   WHY  tier → precedence → score → pin               │
│          policy-withheld · changes│   ALTERNATIVES  candidates, grouped by tier          │
│                                   │   HISTORY  attempts · lifecycle · Special            │
│  ▸ ASSIGN MODE — own board region │   ACTIONS  legal set for (object × state × role)     │
│    pool → draft lanes → review    │   IMPACT   only where projectable                    │
│    never shares a lane with       │                                                      │
│    committed work        (§3.2)   │                                                      │
│                                                                                          │
│  ATTENTION  ranked · each item names its owner and its one action                        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
        │                                          │
        ▼                                          ▼
┌─ PROJECTION ──────────────────┐   ┌─ LEDGER ─────────────────────────┐
│ any IST date · zones in scope │   │ run → zone → batch → trace       │
│ READ-ONLY · conditional mood  │   │ IMMUTABLE · past tense           │
│ "would be assigned"           │   │ "decided, 05:02"                 │
│ holds are the only pre-run    │   │ deep links must survive          │
│ lever · bucketsAsOf shown     │   │                                  │
└───────────────────────────────┘   └──────────────────────────────────┘
```

**Why three and not one:** the two outward surfaces have a different *key* (a date; a run id), a
different *mutability* (none; none), and a different *mood*. Pulling them inside means either losing
the date range or making "today" mean two things on one screen — the precise error `#280 R2` names as
*"a worse error than the present fragmentation."*

**Why three and not six:** the other four "surfaces" in UI§37 share the console's key exactly. Schedule
Detail's six override actions need `batchId`, `seId` and `stopSequence` — **all already in the cockpit
payload** `[CODE]`. Zone view, capacity and holds were already ruled panels by the UI spec itself.

**What this delivers against the brief:** understand, identify, inspect, explore, act and verify all
happen without leaving the console. Only *"what would happen on another date"* and *"what happened in
run #4182"* are deliberate navigations — and they are navigations to a **different question**, which
is the one kind the brief's own §14 accepts.

### 3.2 The mixed-commitment hazard, and the one rule that resolves it

This is the single largest design risk in the whole programme.

| | `/assign` chips | Console lane chips |
|---|---|---|
| On drag | Nothing is written (`#272 R2`) | **Every move writes immediately** (M6–M11) |
| On leaving the page | Draft is lost, and the page says so (`#272 Q2`) | Nothing to lose |
| Scope | **Pan-India** for CSM/OH | **One zone**, always |
| Selection unit | Plant-shaped `(companyId, plantId)` | Ticket-shaped |

The shared visual grammar's own first rule is *"never the same shape for two meanings"*
`[CODE — approved-designs/README.md]`.

> **Rule: draft work and committed work may share a screen, a frame and a grammar. They may never
> share a lane object.** Assign mode owns its own board region with its own lanes, its own review
> step and its own commit. Crossing from one region to the other is an explicit act with a result,
> not a drag.

This also resolves the scope mismatch: **the console's Assign mode is zone-scoped like the rest of the
console.** That is a deliberate narrowing of today's pan-India pool for CSM/OH, and it is the correct
trade — two panes on one screen that disagree about scope is a correctness bug, not a feature.
`[INFER]` The pan-India pool remains available on the standalone `/assign` route if it is kept.

### 3.3 The tense problem, and why five badges is the wrong answer

The brief's §10 requires five states never to visually collapse. **They are not five independent
tokens — they are two axes**, and treating them as five is how you end up with a legend nobody reads:

```
                  COMMITTED          PROJECTED         PROPOSED
  system      "is assigned"      "would be assigned"      —
  human       "was reassigned    "would be assigned"   "will move to
               by Priya, 09:14"                          Ravi"
  unknown     "assigned —              —                  —
               source not recorded"
```

**The provenance axis already exists in code and is already ruled.** `#282 R2` binds it; `#290`
landed the tokens on `/assign` — solid + dot = system, dashed = a human crossed or overrode, violet =
tier-crossing, amber = over capacity, heavy crimson = critical, *and it must survive grayscale*.
`[CODE — INDEX #290 DONE; approved-designs/README.md]`

**Only the tense axis is missing, and it should be carried by mood and surface, not by a sixth
colour** — indicative on the console, conditional on the projection, past tense on the ledger.
Because the three surfaces are already separated by tense (§3.1), **the tense axis is mostly free.**
The one place both axes must coexist in one view is a proposed action inside the console — and that is
a transient state inside a dialog, which is a different rendering context anyway. `[INFER]`

`null` provenance stays *unknown*, never *system*: *"drawing it solid would be the single lie this
whole grammar exists to prevent."* `[DOC — #282 R2]`

### 3.4 One thing the console needs that no page needs today

**The admin app has no query cache.** Fetching is `useApiResource` per component; a mutation refetches
one or two reads by hand. `[DOC — UI§29.1]` Six panes over overlapping reads will drift out of sync
after the first override.

`UI§27` already specifies a mutation → refresh contract per action. **The console makes that contract
mandatory rather than advisory**, and the cheapest correct shape is a single lifted fetch of
`GET /dispatch/today` owned by the console shell, which every pane reads from and every mutation
invalidates. That is one hook, not a caching library. `[INFER]`

---

## 4. The five decisions, validated against code

### D1 — Repeated Inactive: **feasible, no new page, no new table**

The rule (3+ episodes, each >24h, opened in a rolling 7 days) is computable from `failure_cycles`
(`opened_at`, `closed_at`) `[CODE — schema.prisma:2385-2410]`.

**Validated as stated, including the constraint the brief adds** — *"must NOT silently alter normal
Scheduler ranking."* That is automatically true and needs no guard: the list is a **read-side derived
predicate**, and nothing in the recommender consults it. `[INFER, from CODE]`

**Compute it, never store it** — the same reasoning `#244` recorded for Special: a rolling window
means devices fall off, an open episode's duration changes with no writer, and a tuned threshold must
reclassify retroactively. No writer, no drift. `[CODE — special-ticket.query.ts:16-22]`

Full design, migration impact and assessment: `docs/audits/scheduler-console-decisions-design-report.md`.

### D1a — remove repeat-failure escalation: **feasible, and the discriminator is reliable**

**Exact writers** (both verified this pass):

| Writer | Sets | Records |
|---|---|---|
| `repeat-escalation.service.ts:58-68` | cycle → `ESCALATED`, ticket → `ESCALATED` | `ticket_events.reasonCode = 'REPEAT_ESCALATION'` |
| `verification.service.ts:91-99` | ticket → `ESCALATED` | `ticket_events.reasonCode = 'VERIFICATION_FRAUD_ESCALATED'` |

**The two causes are distinguishable by a recorded reason code**, so "release the repeat ones, keep
the fraud ones" is an exact query. This was the main thing that could have made D1a risky. `[CODE]`

**Exact readers** (all verified):

| Reader | Predicate | Effect on an ESCALATED ticket |
|---|---|---|
| Recommender ticket selection | `status: 'OPEN'` | **never dispatched** `[CODE — recommender.service.ts:326-328]` |
| Auto-recovery sweep | `status: 'OPEN'` | **never auto-closed, even after the device recovers** `[CODE — auto-recovery.service.ts:126-129]` |
| Vehicle-return resume sweep | `status: 'OPEN'` | never resumed `[CODE — vehicle-return-resume.service.ts:62]` |
| Troubleshoot submit gate | `status: 'OPEN'` | an SE cannot submit `[CODE — troubleshoot-submission.service.ts:167]` |
| Non-Operational marking | `IN_FLIGHT_TICKET_STATES` **includes** `ESCALATED` | the only exit that exists `[CODE — non-operational.service.ts:47-53]` |
| `/tickets` list + badges | display only | red `ESCALATED` badge |

**And there is no transition out of `ESCALATED` back to `OPEN` anywhere in the codebase** — a grep for
writers returns only the two above. `[CODE]`

**Reporting impact: none, and for an unexpected reason.** `system-efficiency-aggregation.service.ts:219`
carries the comment *"Auto-escalations per zone — cross-zone AUTO_PLATINUM + intra-day
ESCALATION_REQUIRED + **cycle ESCALATED**"* — but the SQL below it inserts from
`cross_zone_escalations` and `intraday_insertions` **only**. There is no third insert. Failure-cycle
escalations were **never counted** in `auto_escalations`. `[CODE — verified this pass]` Removing the
behaviour therefore changes no report. *(The stale comment is a small pre-existing defect worth
correcting in the same change.)*

**Migration impact — two effects to plan for, not discover:**

1. **A burst of auto-closures.** Devices that recovered weeks ago have tickets stuck unable to close.
   The next auto-recovery sweep will close them as self-healed — correct, but it lands in Fleet Uptime
   and the monthly cubes on one day.
2. **A burst of dispatchable work** competing for the same engineer capacity on the next run.

**Audit requirement:** one `ticket_events` row per released ticket with its own reason code, so the
change reads as a deliberate act in every ticket's history rather than an unexplained state change.

**Blocking unknown: nobody has counted the affected rows in either database.** That count decides
whether this is one pass or a zone-by-zone stagger. It is a database question, not a design one.

### D2 — leave `repeat_failure_penalty` alone: **recorded, and the brief's caveat is correct**

The brief asks to *"call out clearly if the code means this setting is currently ineffective or
misleading."* It does. Three independent reasons:

1. It **subtracts** — in DEFICIT (Catch-up) mode a repeatedly-failing device scores *lower*.
   `repeat_failure_bonus` is PREVENTIVE-only and defaults to 0 in the DEFICIT set.
   `[CODE — scoring.ts:52-55, 114, 121-128]`
2. **It cancels out entirely.** The score picks an *engineer* for a ticket; `repeatFailure` is a
   *ticket* property, so it shifts every candidate identically. The code states this itself: *"Every
   field but `distanceFromPrevStopKm` comes from the TICKET… candidates for one ticket share an
   identical `baseScore`."* `[CODE — recommender.service.ts:548-552]` Only `distance` and the
   per-candidate cluster multiplier discriminate.
3. **The queue order never consults it.** `compareCandidates` is tier → bucket → return-due →
   priority rank → oldest inactive → device id. No repeat term. `[CODE — canonical-sort.ts:82-113]`

**So it is a live, Operations-Head-editable weight, stamped into every persisted `score_breakdown`,
that changes no decision.** Decision taken: leave it. **Consequence to accept on the record:** it stays
visible in Settings as a lever that does nothing, and a future operator will tune it expecting effect.

**Console consequence:** do not surface `repeat_failure_penalty` as a control in any console
configuration panel while this is true. Exposing a dead lever on the screen whose stated purpose is
teaching would actively mis-teach. `[INFER]`

### D4 — Run Now: **feasible, and mostly a relocation**

**The working implementation already exists** — on the Bulk Unassign page. It has the zone selector,
the reason box, in-flight polling that disables the button *with the reason shown before anyone
presses it*, and a result summary. `[CODE — BulkUnassignPage.tsx:53-59, 75-79, 160-180]`

**It is not on the scheduler screen despite `#285` being marked done** (C3).

**Every UI requirement in the brief is satisfiable today**, including the two that matter most:

- *"explain if it produces zero new assignments"* — **required, not optional.** The engine only looks
  at work that is `OPEN` **and** `UNASSIGNED`, so with inputs unchanged a re-run places nothing. Without
  an explicit zero-result state, this control teaches managers the scheduler is broken.
- *"Run Now adds newly eligible work; it does not rebuild or reorder existing committed plans"* — and
  this is **true in code**, which is why it is safe to say. New work is *appended*; stop numbering
  continues from the schedule's current last stop, so a route already being driven is never
  reordered. `[CODE — batch-assignment.service.ts:205-240]`

**One behaviour the brief does not mention and the UI should:** a manual run notifies engineers.
Day-plan notifications ride the same commit path as the 05:00 run, so a mid-day run can push work onto
a phone mid-shift. `[CODE — batch-assignment.service.ts:65-81]` That is correct behaviour; it is not a
silent operation and the confirm should say so.

**Where it genuinely earns its place:** a zone whose recovery is `EXHAUSTED`. There is no
"retry this zone" API anywhere — **a manual run is the only human lever for a zone whose day plan
never got built.** `[DOC — W§5.11/5.12]`

### D5 — all three manager roles, ZM clamped: **feasible, and the clamp is load-bearing**

**The exact change required, and the hole if it is skipped:**

`POST /schedules/dispatch-run` reads the zone straight from the request body and **never checks it
against the caller**:

```ts
zoneId: body.zoneId != null ? BigInt(body.zoneId) : undefined,
```
`[CODE — schedules.controller.ts:196-205]`

That is safe today only because `@Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')` are both
global-scope. `[CODE — schedules.controller.ts:192]` **Widen the role list without a clamp and any
Zonal Manager can rebuild another manager's day plans — or omit `zoneId` entirely and trigger a run
across every zone in the country.**

Required changes, all four together in one change:

1. Widen `@Roles` on `POST /schedules/dispatch-run` to the three manager roles.
2. **Clamp:** when the caller's role is `ZONAL_MANAGER`, take the zone from token claims and **ignore**
   the body value. *Ignore, not validate* — a client that simply stops sending the field must not be
   able to reach the pan-India path.
3. Widen **and clamp** `GET /schedules/dispatch-run/in-flight`, which today returns every zone
   globally. `[CODE — schedules.controller.ts:227-232]`
4. Hide the zone picker entirely for a ZM. A picker with one unchangeable option teaches nothing
   (`UI§4.4` — *hide, don't disable*).

**This widens the RBAC ladder that `#272`/`#282` deliberately held closed.** That is a legitimate
operator call, now taken — but it must be **recorded as an explicit reversal in a decision record**,
not slipped in as a role-list edit, so the next reader of those rulings finds the reason.
`[DOC — A§14 C10]`

---

## 5. Three roles, three consoles

Treating these as one UI with disabled buttons fails the brief's own §9. From the authorization model:

| | **ZONAL_MANAGER** | **CENTRAL_SERVICE_MANAGER** | **OPERATIONS_HEAD** |
|---|---|---|---|
| **Lands on** | Their zone's deck, immediately | **"Choose a zone"** — the backend refuses to guess | Same as CSM |
| First question | *"Is my day intact, what needs me?"* | *"Which zone is in trouble?"* | *"Is the engine behaving, is policy right?"* |
| Zone picker | **Hidden** | Required | Required |
| Run Now | ✓ own zone, forced (D5) | ✓ any zone / all | ✓ any zone / all |
| Sees `nextFireAt` | ✗ — **gap** | ✗ — **gap** | ✓ |
| Overrides · holds · assign · escalations | ✓ | ✓ | ✓ |
| Bulk unassign · scoring weights · cron | ✗ | ✗ | ✓ |
| Assignment threshold | ✗ | ✓ | ✓ |
| Acting-as-zone | n/a | ✓ (inconsistently honoured) | ✓ (same) |

`[CODE — controller `@Roles` decorators; settings/setting-authority.ts]`

**Three consequences the design must absorb:**

1. **The ZM console is genuinely simpler, and should look it** — no zone picker, no engine config,
   no cross-zone anything. Rendering the union of three roles' controls greyed out fails "easy to
   learn" on the screen whose purpose is teaching.
2. **CSM/OH have a first-run problem the ZM does not.** Their opening state is a picker, not a
   dashboard. **Do not fabricate a fleet summary to fill it** — no aggregate read exists. A remembered
   last zone plus an explicit chooser is the honest answer.
3. **A ZM cannot answer *"why is my deck empty at 04:55?"*** — `dispatch-schedule` is OH-only and the
   hour is configurable, so it cannot be inferred. This is a hole in the ZM's own primary screen and it
   is a backend gap, not a layout problem.

---

## 6. Attention Required — yes, `dashboard/action-required` should be the common source

**Recommendation: extend it. Do not build a second queue.**

It already exists with nine urgency-ordered cards — and **seven return `{count: 0, available: false}`
and render as "coming soon"** to your managers today.
`[CODE — dashboard.service.ts:291-303, 876-884; ActionRequiredPanel.tsx:44-48]`

| Card | Wired? | Note |
|---|---|---|
| Auto-dispatched batches awaiting review | ✗ | |
| **Vehicle Unavailability / readiness conflicts** | ✗ | **Data already served and already rendered** on `/readiness/vehicle-unavailability` |
| CRITICAL insertions awaiting SE acceptance | ✗ | rows exist |
| **Failed Verification** | ✗ | `/verification` renders them |
| Component-Blocked | ✗ | queue table exists |
| WAITING_COMPONENT 7+ days | **✓** | |
| Non-Op awaiting confirmation | ✗ | |
| Manual assignment required | ✗ | |
| Recovery stalled 14+ days | **✓** | |

Two of the seven stubs are a `COUNT(*)` each over data that already ships. Adding **Repeated Inactive**
and **Special** as further cards gives the console its attention band *and* repairs the dashboard from
one definition. `[INFER, from CODE]`

**Three conditions on doing it this way:**

1. **Scope must match the deck.** `action-required` is zone-scoped for a ZM and global for CSM/OH.
   Rendered beside a single-zone deck for a CSM, the two will disagree. The console must request it
   zone-scoped explicitly.
2. **Scheduler-run exceptions stay in the payload that owns them.** Recovery state, `seSkips`, stale
   eligibility MV and contention are properties of *this run of this zone* and belong in the console's
   Health line, not in a cross-cutting card list. Two sources, one band, clearly grouped.
3. **`policyWithheld` must never become a card.** It is a count of policy working correctly, and it is
   **deliberately never itemised** — those tickets get no recommendation, no row and no trace, so there
   is nothing to list. `[DOC — A§10.5]`

---

## 7. Recommended build strategy

Ordered by dependency, with the reason each step precedes the next.

```
PHASE 0 — unblock                                                        hours
  0.1  Delete the stray character in scheduler-preview.service.ts:221.
       `tsc` reports one error; nothing can be built or verified until it is gone.
  0.2  Correct #285's record (C3) so scoping starts from reality.
  0.3  COUNT: ESCALATED tickets by age/zone; devices matching D1 today.

PHASE 1 — make the existing cockpit whole                                days
       No backend change. No ruling overturned. Required by every option below.
  1.1  Zone picker (GET /org/zones) — unblocks two of three roles.
  1.2  Run Now relocated + wired, with the zero-result state.   ← D4
  1.3  Commandable lanes: the six overrides, impact preview, assign, hold,
       release, candidates, escalation-resolve — on ids already in the payload.
  1.4  Render the score breakdown and per-candidate filter states.
       Tier-GROUP the candidate list; a flat list teaches a false model.
  1.5  Three links out: ticket → journey, ticket → attempts, plant → devices.

PHASE 2 — safety + policy                                                days
  2.1  D5's clamp, all four parts, in ONE change.               ← D5
  2.2  Decision record overturning the RBAC ladder (D5) and R7 (C2), or not.
  2.3  Finish #239 acting-zone — "confusing" becomes "incorrect" once panes share a screen.

PHASE 3 — the attention band                                             days
  3.1  Light the two nearly-free cards (vehicle unavailability, failed verification).
  3.2  D1's derived predicate + settings + card + filter/badge.  ← D1
  3.3  D1a release migration, staged by zone if 0.3 says so.     ← D1a
  3.4  Press Run Now. Its first real job is placing what 3.3 freed.

PHASE 4 — the console proper                                             weeks
  4.1  Lift one shared fetch into a console shell (§3.4).
  4.2  Inspector column: why · alternatives · history · actions · impact.
  4.3  Assign mode as its own board region (§3.2) — only if R7 is overturned.
  4.4  Backend gaps in priority order: cockpit counters · ZM next-run ·
       ticket→decision · actor names.
```

**Why Phase 1 comes before any architecture decision.** Every item in it is required by the merged
console, by the grouped alternative, and by doing nothing at all. It overturns no ruling and needs no
backend change. **And it makes the architecture question empirically answerable rather than
speculative** — afterwards the cockpit *is* the console for everything except handing out work, and the
only question left is C2: does the pool come inside, and how does a draft chip avoid looking committed?

---

## 8. What must not be built

Refuse these once, here, so they do not reappear in a wireframe:

- A **date picker on the live console** · a **pan-India cockpit** · a **staleness badge on the
  projection** · a **retry-this-zone or cancel-run control** · a **run progress bar** · an
  **"Approve the plan"** step (*"inaction means the 05:00 run proceeds exactly as if nobody looked"*)
  · an **atomic Commit-All** · a **capacity page** (there is no capacity endpoint) · a **map, ETA or
  route line** · **`TIER_NOT_REACHED` in the assign console** (a human may cross tiers) · a **flat
  score-sorted candidate list** · **one combined "not dispatched" number** · **`DEFICIT`/`PREVENTIVE`
  in user-facing copy** (map to "Catch-up"/"Steady") · **`repeat_failure_penalty` as a console control**
  while D2 stands.

---

## 9. What still needs a decision

| # | Decision | Blocks |
|---|---|---|
| **1** | **Overturn `#280 R7`?** §3.2 proposes overturning it *while honouring its actual concern* — assign as a mode with its own board region, never a shared lane. Needs a written record either way | Phase 4.3 |
| **2** | **Console Assign mode is zone-scoped** — a deliberate narrowing of today's pan-India pool for CSM/OH (§3.2). Accept, or keep `/assign` standalone for the pan-India case? | Phase 4.3 |
| **3** | **Record the RBAC widening (D5) as an explicit reversal** of `#272`/`#282`'s closed ladder | Phase 2.2 |
| **4** | **D1: 3 failures, or 3 *repeat* failures?** The existing predicate counts only repeats, making "3" mean the 4th failure or later. I have assumed the plainer reading | The predicate |
| **5** | **Is Repeated Inactive a replace-or-investigate queue, or is a faster visit expected?** Under D2 no visit gets faster. Changes the copy and the placement, not the code | Framing |
| **6** | **Naming: "Repeated Inactive" vs "Special"** — one is about the equipment, one about failed visits; a device can be both. Two similar red badges with no explainer and one gets ignored | Phase 3.2 |
| **7** | **Do `/schedules/:engineerId`, `/schedules`, `/intraday`, `/schedules/preview` survive as routes?** Retire, redirect, or keep as deep-link targets. `/intraday` is structurally dead — its ledger reads an audit action no admin code writes — but its escalation modal is live and must be relocated first | Phase 4 |

---

## 10. Note on this review's inputs

The brief supplied to this review **ends mid-sentence inside its section 11** (the historical ticket
journey diagram). Sections 11+ were not received. §11's requirement is nonetheless covered — the
journey is mapped stage by stage against real rows in `A§12`, and its three genuine holes are named
there. If sections 12 onward contained further requirements, they have not been assessed here.

---

*End of review. Nothing was implemented. The two counts in Phase 0.3 are the next action, and they are
database questions, not design ones.*
