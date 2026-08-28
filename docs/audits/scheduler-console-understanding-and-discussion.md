# Scheduler Console — Understanding & Design Discussion

> **This is not a UI specification.** It is a shared understanding document, written to prepare an
> extended design discussion about whether — and how — the Scheduler's operator surfaces should
> collapse into a single Operational Scheduler Console.
>
> **Nothing here was implemented.** No component was created, no page merged, no route changed, no
> API touched.
>
> **Date:** 2026-08-27 · **Branch:** `feat/autoplant-integration` · **HEAD:** `56f5aec`
>
> **Companion documents** (both untracked working-tree files dated 2026-08-26):
> - `docs/audits/scheduler-engine-technical-walkthrough.md` (5,474 lines) — cited as **W§n**
> - `docs/audits/scheduler-engine-ui-specification.md` (2,712 lines) — cited as **UI§n**
>
> **Evidence discipline.** Every non-obvious claim carries one of four tags:
>
> | Tag | Means |
> |---|---|
> | `[CODE]` | Read directly out of `apps/backend/src` or `apps/admin/src` during this investigation, at the cited path |
> | `[DOC]` | Established by an existing repo document (walkthrough, UI spec, decision record, forensics) and not independently re-verified here |
> | `[INFER]` | A reasoned conclusion drawn from `[CODE]`/`[DOC]` facts. Not an implementation fact. |
> | `[OPEN]` | Genuinely unresolved; nobody has decided, or nobody has looked |
>
> Where the four authorities disagree, the disagreement is **marked, not reconciled**. Authority
> order, as instructed: **CODE → walkthrough → UI specification → business/conceptual PDF.**

---

## 0. Two things to know before reading

### 0.1 The conceptual PDF could not be read, and the console concept is not in it

`docs/audits/sds.pdf` (11.8 MB) is destroyed — passed through a lossy UTF-8 round trip; 2.7 million
bytes replaced with U+FFFD; zero streams inflate; `pdftotext` extracts nothing. `[DOC — W§0.1]`. Its
*text* was recovered separately and is quoted throughout the walkthrough's §2, and that text is a
faithful layman rendering **of this same code**, written from it — not a design document written
before it. `[DOC — W§0.1]`

**Consequence for this task:** there is no PDF in this repository that shows a "unified Assign Work /
Console concept". What does exist, and carries operator approval, is a pair of committed HTML
wireframes:

| Artifact | Covers | Approved | Owning record |
|---|---|---|---|
| `docs/ui/desktop/approved-designs/assign-work-console.html` | `/assign` — work pool, draft lanes, candidate column, commit review | 2026-08-20 | `#272` |
| `docs/ui/desktop/approved-designs/todays-dispatch-crew-deck.html` | `/dispatch/today` — Plan / Live / Replay, crew deck, rails, interception | 2026-08-25 | `#282` |

`[CODE — docs/ui/desktop/approved-designs/README.md]`. **These two are the "console concept" the
brief is reaching for.** They already share one visual grammar by explicit ruling — *"the two boards
read as one product"* (`#272:64`). The open question this task raises is whether they should also
share one **screen**.

### 0.2 The working tree does not compile

`apps/backend/src/scheduling/scheduler-preview.service.ts:221` still carries an uncommitted stray edit
— the `*/` closes the docblock and a trailing `'` opens a never-closed string literal. `tsc --noEmit`
reports `TS1002: Unterminated string literal`. HEAD is clean; the working tree is not.
`[CODE — verified 2026-08-27, still present]`

This was flagged in the walkthrough on 2026-08-26 (W§0.2) and has not been fixed since. It makes the
Scheduler Preview and holds surface unbuildable. **It is a prerequisite to any console work and is not
part of the design discussion.**

---

## 1. Why We Are Reconsidering the Current Scheduler UI

### 1.1 The stated reason

Scheduler capability is distributed across seven routes, three nested detail routes, one
retired-but-still-linked page, two admin pages and one settings section. Individual screens work. The
**operational experience** is fragmented: a manager who wants to understand today, find the thing that
needs attention, understand why the engine did what it did, explore an alternative, and commit a change
must move between four or five destinations and lose context at each hop.

### 1.2 The reason the repository already records

This is not a new observation in this codebase. It is the third time the same finding has been filed:

| Date | Record | Finding |
|---|---|---|
| 2026-08-19 | `audit/navigation-ia-audit-2026-08-19.md` F6 | *"Four dispatch nouns; a new ZM cannot rank them."* `[DOC]` |
| 2026-08-24 | `#280` (DECISION RECORD) | The four surfaces are **one concept**, the dispatch timeline. Navigation expresses only insertion order. `[CODE — issue file]` |
| 2026-08-25 | `#282` + `audit/scheduler-engine-forensics-2026-08-25.md` §F | *"No cockpit. One screen where a zone's whole day is visible and commandable has no counterpart."* `[CODE]` |

**The forensics report reached the unification conclusion and then stopped one step short of it:**

> *"This deliberately does not preserve the current sidebar as-is: the four tense-rows collapse into
> the cockpit + the historical ledger, which is what the Aug-19 IA audit's F6 was asking for before
> the concept was lost."* — `audit/scheduler-engine-forensics-2026-08-25.md` §J `[CODE]`

### 1.3 The two standing rulings this task reopens

**This is the single most important thing in this document.** The unified-console direction is not a
blank sheet — it contradicts two live operator rulings, and the operator is the only person who can
overturn them. They are stated here in full rather than quietly worked around.

**Ruling A — `#280 R2`: grouping and cross-linking, NOT merging.**
`[CODE — 280-decision-dispatch-timeline-ia.md:96-103]`

> *"These are three genuinely different operator questions with different data, different mutability
> and different authority… A single merged page that blurs a projection into a result would be a worse
> error than the present fragmentation, because it would make an operator believe a preview is a
> commitment. **Grouping and cross-linking, not merging, unless the operator later rules otherwise.**"*

And in its own consequences section:

> *"**Risk being taken deliberately:** a future operator may prefer one merged page. R2 rules against
> that for now on the grounds that merging is irreversible in the operator's mental model, while
> grouping is not. **Revisit with evidence, not preference.**"*

**Ruling B — `#280 R7`: `/assign` and the dispatch timeline must not be merged.** `[CODE — :127-133]`

> *"`/assign` is a **write** surface for human decisions; the dispatch timeline is largely a **read**
> surface for the engine's decisions. They are adjacent and must not be merged."*

Reaffirmed on 2026-08-25: *"`/assign` stays separate (#280 R7 stands)"* — `#282 R1` `[CODE]`. And again
independently by the forensics report: *"**Assign Work Console — kept, separate.** #280 R7 is right."*
`[CODE — forensics §J]`

**Status:** `#280 R2` explicitly reserves the merge decision for the operator, on evidence. **This task
is that reservation being exercised.** `#280 R7` does not carry the same escape clause and would have
to be overturned outright. Both must be settled before implementation — see §21 Q1/Q2.

### 1.4 One thing that is NOT the reason

The unification is **not** needed to make the engine legible. Two of the three highest-value
explainability improvements available today require **no** architectural change at all — the data
already ships and the client throws it away (§11.3). A console is an *operational workflow* argument,
not an explainability argument. Conflating the two would justify a large restructure with evidence that
supports a small one. `[INFER]`

---

## 2. What the Scheduler Actually Does

### 2.1 One sentence

At 05:00 IST a program decides which field engineer drives to which plant, in what order, and why. A
manager cannot approve it, cannot block it, and can change anything afterwards. `[DOC — UI§3.1]`

### 2.2 It is not one service

It is a five-layer pipeline plus five satellite subsystems across seven Nest modules — ~14,762 lines.
`[DOC — W§1.1]`

```
recommender/     the decision engine     who gets which ticket, and why
scheduling/      orchestration + commit  when it runs, zone claims, commit, overrides,
                 + read surfaces         previews, transparency reads, closure, recovery
intraday/        the CRITICAL fast path  2-min direct-assign sweep + escalations
planner/         the SE Planner pin      soft bias into the morning batch
cross-zone/      Platinum overflow       escalation to CSM — NOT a scheduling path
shared-pool/     the SE's secondary work read-only, not dispatch
soft-state/      the ON_SITE gate        conflict detection for overrides
```

### 2.3 The layers, and what each is allowed to decide `[DOC — W§3.2]`

| Layer | Service | Decides | Never decides |
|---|---|---|---|
| **L0 Trigger** | `DispatchSchedulerService` (@Cron) / `SchedulesController` | nothing — claims a window | anything |
| **L1 Orchestration** | `DispatchRunService` | which zones, who holds them, when to give up, the run's status | which SE gets a ticket |
| **L2 Decision** | `RecommenderService` | ticket order, candidate pool, filters, tier, score, winner, the recorded explanation | how it becomes rows |
| **L3 Commit** | `BatchAssignmentService` | only how the chosen set becomes rows: schedules, stops, sort order | anything about WHO |
| **L4 Read / Mutate** | the ~11 query, override and projection services | **nothing** — *"This service decides nothing"* (`dispatch-today-query.service.ts:156`) | — |

**Why this matters to a console:** L4 is the console's entire world. Every screen a console would
contain is an L4 surface. This is why the whole thing is a *composition* problem and not an engine
problem — and why `#282 R5` ("reuse first; no duplicate scheduler logic anywhere") binds any console
design. `[INFER]`

### 2.4 The execution path, end to end `[DOC — W§1.4, W§4]`

```
 1  CRON TICK 05:00 IST (settings-backed) ── or MANUAL API ── or RECOVERY COLLECTOR
 2  TICK CLAIM               cross-instance, DB-backed, per (job, UTC minute)
 3  FUTURE-DAY REFUSAL       the only validation on the real path
 4  REAPER PASS              runs FIRST, not last
 5  ZONE DISCOVERY           zones with >=1 plant
 6  ZONE CLAIM + RUN ROW     ONE transaction; all-held => nothing written at all
 7  CONFIG SNAPSHOT          frozen BEFORE the run row
 8  PATIENCE LOOP            CRON only — 15-min deadline, 60-s interval. MANUAL is never patient.
 9  -- per zone --
10  FETCH TICKETS            OPEN + UNASSIGNED + TROUBLESHOOT, 6 exclusions
11  RANKABILITY FILTER       null sla_bucket dropped -> bucketlessDropped
12  TICKET SORT              canonicalSort, 6 keys [+ installSort in PREVENTIVE mode]
13  RUN-LEVEL READS          weights, cluster multiplier, capacity, committed day plan,
                             planner pins, plant coords, home bases
14  -- per ticket --
15  FETCH ENGINEERS          coverage tiers + floating MV (re-validated live)
16  READINESS BUILD          availability, capacity, kit — memoised
17  HARD FILTERS             5 filters, TRI-STATE, first-FAILED wins
18  TIER SELECTION           the FIRST NON-EMPTY tier of passing candidates
19  SCORING                  ONLY within the winning tier
20  WINNER SELECTION         planner pin > top score > se_id asc
21  PERSIST RECOMMENDATION   SUGGESTED | UNASSIGNABLE
22  UPDATE IN-RUN STATE      capacity++, plants+=, route position advances
23  BUILD TRACE ROW          in memory
24  -- end per ticket --
25  BULK INSERT TRACES       one createMany
26  DAY-PLAN COMMIT          per SE: advisory lock -> claim recs (SKIP LOCKED) -> schedule ->
                             stops -> tickets -> outbox row -> consume recs
27  OUTBOX DRAIN             POST-COMMIT, outside the transaction
28  ZONE CLAIM FINALIZE      DONE | ERROR + all zone-card totals
29  HEARTBEAT
30  -- end per zone --
31  RETRY CONTENDED ZONES
32  RUN FINALIZE             SUCCESS | PARTIAL | FAILED  (never ABORTED — reaper only)
33  AUDIT + RELEASE STRANDED CLAIMS
34  -- asynchronously --
35  REAPER every 3 min       -> marks dispatch_zone_recoveries PENDING
36  RECOVERY COLLECTOR /5min -> re-enters at step 1, bounded 3 attempts / 18:00 IST cutoff
```

### 2.5 The four structural facts a console cannot get wrong

**Fact 1 — Coverage tier is inviolable; score only decides *within* one tier.**
`[DOC — W§1.2; tier-score-chooser.ts:55-72]` A FLOATING engineer can never out-score an eligible
DEDICATED one. The one thing that crosses tiers is a human's SE-Planner pin. **Consequence:** a flat,
score-sorted candidate list is forbidden anywhere in the console — it would teach a false model.

**Fact 2 — `recommended + unassignable` is not the funnel.** Four further populations sit outside it,
each sending a *different team*: `[DOC — W§1.3]`

```
tickets in the zone
   |- recommended                 -> placed on a plan
   |- unassignable                -> OPS: nobody could take it
   |- withheldBelowThreshold      -> NOBODY: policy working as intended
   |- componentBlockedWithheld    -> WAREHOUSE: part on order, SLA paused
   |- bucketlessDropped           -> ENGINEERING: no ranking data
   |- deferred / held             -> nobody: a decision already taken   [no run-level count]
   |- plant deactivated           -> nobody                             [NO COUNT ANYWHERE]
   |- device departed             -> nobody                             [NO COUNT ANYWHERE]
```

**Consequence:** any console header that collapses these into one "not dispatched" number turns a
supplier delay into what looks like a fleet-wide outage. This is the easiest way to make a unified
console *worse* than the fragmented screens. `[INFER]`

**Fact 3 — Overload is always *visible*, never *blocked*, on manual paths; always *blocking* on
automatic ones.** `[DOC — W§17.4, UI§11.3]` *"Overload is an administrative right, so it is a seen
decision rather than a refused one."*

**Fact 4 — `null` never means zero.** `NOT_ENFORCED != passed`, `NOT_AVAILABLE != 0`, `null` rank
`!= unranked`, `null` provenance `!= system`. The backend's first standing rule is *"never fabricate a
default."* `[DOC — W§1.5]` This is a correctness contract, not a style guide, and it binds a Copilot
layer harder than it binds any static screen (§13.5).

---

## 3. The Actual Operational Workflow

### 3.1 What the brief proposes

```
UNDERSTAND -> IDENTIFY ATTENTION -> SELECT -> UNDERSTAND WHY -> EXPLORE OPTIONS
   -> MAKE OR PREVIEW A CHANGE -> UNDERSTAND IMPACT -> COMMIT -> SEE RESULT
```

### 3.2 What the backend can actually support today, step by step

| Step | Supported? | By what | Where it breaks |
|---|:--:|---|---|
| **Understand** | **Yes, per zone** | `GET /dispatch/today` — run badge, recovery, 6 counters, crew lanes, 4 rails, escalations | **Zone-scoped only.** A multi-zone role gets `400 ZONE_REQUIRED`; there is *no* fleet-wide aggregate read anywhere `[CODE — dispatch-today.controller.ts:53-58; W-G2]` |
| **Identify attention** | **Yes** | `situation.criticalNeedsYou`, `escalations[]` with cause, `recovery.state`, `rails.unassignable[]` with reason, `overCapacity`, zone `seSkips[]`, MV staleness | Two of six funnel populations (`componentBlockedWithheld`, `bucketlessDropped`) are **invisible** on the live surface — they exist only per-run `[DOC — UI§7.4, G-UI-2]` |
| **Select work** | **Yes** | rails carry `ticketId`; lanes carry `seId`/`batchId`/`ticketId`; pool carries `(companyId, plantId)` | Two different selection shapes coexist: ticket-shaped (cockpit) and plant-shaped (pool). See §7.3 |
| **Understand why** | **Yes, inside a run** | `GET /dispatch-runs/:runId/tickets/:ticketId/trace` — the richest surface in the product | **A trace is not addressable without its run.** No `GET /tickets/:id/decision` exists `[DOC — G-UI-5]` |
| **Explore options** | **Yes** | `GET /schedules/candidates?plantIds=` — the *engine's own* eligibility answer, dropped candidates included with reasons | Candidates 7..N are **never stored** in a trace (top-5 bound). Live candidates are unbounded but carry no score. |
| **Preview a change** | **Partially — 3 of 6 override actions** | `POST /batches/:id/override/preview`; `POST /schedules/distribute-preview`; `GET /schedules/preview` | `REMOVE_TICKET`, `DEFER_TICKET`, `REORDER` are **refused with `400 NOT_PROJECTABLE`, deliberately** — *"zeros would read as 'this move costs nothing'"* `[CODE — override-projection.service.ts:88; batches.controller.ts:66-68]` |
| **Understand impact** | **Yes, for the 3** | two capacity lanes (`committed -> after`), rank context, route effect, conflicts | **No staleness signal on this preview at all.** The confirm's own 409 is the only defence `[DOC — UI§17.2]` |
| **Commit** | **Yes** | 6 override actions, assign, assign-plants, assign-batch, holds, release, manual-assign, bulk-unassign | **Every one commits immediately and individually.** There is no change-set, no basket, no two-phase commit outside bulk-unassign. See §12. |
| **See result** | **Yes** | per-lane / per-ticket results, changes-today ledger, refetch contract | The app has **no query cache** — "refresh" means calling `refetch()` on each affected read `[DOC — UI§27, §29]` |

### 3.3 The one-line verdict

**The workflow is supportable end-to-end today for a single zone and a single change at a time.** It is
*not* supportable pan-India, and it is *not* supportable as an accumulated multi-change commit. Both
are backend work, and both are things a console UI could easily *imply* it does. `[INFER]`

---

## 4. Complete Scheduler Capability Inventory

Organised by **what a user can do or inspect**, not by page. Compiled from the 32-endpoint API
inventory (W§24), verified against the controllers `[CODE]`, and cross-checked against the admin `api/`
modules `[CODE — apps/admin/src/api/]`.

Legend — **Mut**: mutates · **Prev**: has a preview/impact endpoint · **Class**: `P` primary
operational · `A` advanced/rare · `D` diagnostic/historical.

### 4.1 Situation and inspection (read)

| # | Capability | Purpose | Roles | API | Frontend home | Mut | Prev | Class |
|---|---|---|---|---|---|:--:|:--:|:--:|
| R1 | **Today's plan for a zone** (crew lanes, ordered stops, provenance) | "what is happening now" | ZM own / CSM+OH must name a zone | `GET /dispatch/today?zoneId=` | `/dispatch/today` Live | ✗ | — | P |
| R2 | **Situation counters** (placed · unassignable · held · critical · over-capacity · changes) | triage header | ↑ | ↑ `situation` | ↑ | ✗ | — | P |
| R3 | **Unassignable rail**, itemised with `poolEmptyReason` | ops gap | ↑ | ↑ `rails.unassignable[]` | ↑ | ✗ | — | P |
| R4 | **Held / deferred rail** with return date + approver | a decision already taken | ↑ | ↑ `rails.held[]` | ↑ | ✗ | — | P |
| R5 | **Policy-withheld count** (never itemised — a contract) | policy working | ↑ | ↑ `rails.policyWithheld` | ↑ | ✗ | — | P |
| R6 | **Escalations / critical interception**, with cause and current assignee | needs a human now | MANAGER | ↑ `escalations[]` + `GET /intraday-insertions` | ↑ strip + `/intraday` | ✗ | — | P |
| R7 | **Recovery state of the zone's day** | is the day intact | ↑ | ↑ `recovery` | ↑ notice | ✗ | — | P |
| R8 | **Changes-today ledger** (adds · removes · swaps, paired) | operator-facing audit | MANAGER | `GET /dispatch/changes-today` | ↑ Changes rail | ✗ | — | P |
| R9 | **Next-run projection** (real recommender, writes suppressed) | "what would happen" | MANAGER | `GET /schedules/preview?date=` | `/schedules/preview` | ✗ | — | P |
| R10 | **Holds in force** | pre-run levers set | MANAGER | ↑ `holds[]` | ↑ | ✗ | — | P |
| R11 | **Committed day plans, all engineers** | today's committed result | MANAGER | `GET /schedules?date=` | `/schedules` | ✗ | — | P |
| R12 | **One engineer's whole day plan** | the override context | MANAGER | `GET /schedules/:engineerId` | `/schedules/:engineerId` | ✗ | — | P |
| R13 | **Engineer roster + load + coverage** | the picker everywhere | MANAGER | `GET /schedules/engineers` | 5 surfaces | ✗ | — | P |
| R14 | **Work pool** (company → plant; open / critical / held / oldest) | "how much is left" | MANAGER, acting-zone aware | `GET /schedules/assignable-work` | `/assign` | ✗ | — | P |
| R15 | **Candidate column** — the engine's own eligibility, dropped included | "why not them" | MANAGER | `GET /schedules/candidates?plantIds=` | `/assign` | ✗ | — | P |
| R16 | **Resolve plants → ticket ids** (late binding at review) | the commit's payload | MANAGER | `GET /schedules/assignable-tickets` | `/assign` | ✗ | — | A |
| R17 | **Run ledger** | "what past runs did" | MANAGER (ZM totals are zone-scoped) | `GET /dispatch-runs?limit=` | `/dispatch-runs` | ✗ | — | D |
| R18 | **Run detail + frozen config-in-effect + build stamp** | what config was in force | MANAGER | `GET /dispatch-runs/:runId` | `/dispatch-runs/:runId` | ✗ | — | D |
| R19 | **Zone card** (the full funnel + `seSkips` + live-vs-historical) | per-zone outcome | MANAGER | ↑ `zones[]` | ↑ | ✗ | — | D |
| R20 | **Zone detail** — batches, unassignable, plant stats | drill-down | MANAGER (403 cross-zone) | `GET /dispatch-runs/:runId/zones/:zoneId` | `/dispatch-runs/:runId/zones/:zoneId` | ✗ | — | D |
| R21 | **Batch detail** — per-ticket rank / score / degeneracy / `hasTrace` | one stop | MANAGER | `GET /batches/:batchId` | `/batches/:batchId` | ✗ | — | D |
| R22 | **Run decision stream** in `processing_rank` order | "what did the run decide, in its order" | MANAGER (403 cross-zone) | `GET /dispatch-runs/:runId/decisions` | `/dispatch/today` Replay | ✗ | — | P/D |
| R23 | **Per-ticket decision trace** — winner, 5 runners-up, verdicts, drop counts, filter states, score breakdown | the explainability surface | MANAGER (404 cross-zone) | `GET /dispatch-runs/:runId/tickets/:ticketId/trace` | inline `TracePanel` | ✗ | — | P |
| R24 | **In-flight runs** | is a run holding this zone | **CSM + OH only** | `GET /schedules/dispatch-run/in-flight` | (unused today) | ✗ | — | P |
| R25 | **Dispatch schedule** (cron · tz · `nextFireAt`) | when it fires | **OH only** | `GET /schedules/dispatch-schedule` | `/settings` | ✗ | — | A |
| R26 | **Bulk-unassign history** | rebalance audit | **OH only** | `GET /schedules/bulk-unassign/history` | `/bulk-unassign` | ✗ | — | D |
| R27 | **SE Planner pins** (dates × plants × engineers) | the soft bias | MANAGER | `GET /planner`, `GET /planner/plants` | `/engineers/planner` | ✗ | — | A |
| R28 | **Scoring weights + the closed component vocabulary** | the engine's tuning | **OH only** | `GET /org/scoring-weights[/components]` | `/settings` | ✗ | — | A |
| R29 | **Available SEs for one escalation** (AVAILABLE only) | resolve an escalation | MANAGER | `GET /intraday-insertions/:id/available-ses` | modal | ✗ | — | P |
| R30 | **Zone list** | the picker CSM/OH need | **CSM + OH** | `GET /org/zones` | `api/org.ts:82` (used elsewhere) | ✗ | — | P |
| R31 | ~~Intra-day updates queue~~ | ~~"what changed today"~~ | MANAGER | `GET /intraday-updates` | `/intraday` | ✗ | — | **DEAD** |
| R32 | **SE's own day plan** | the mobile app | SERVICE_ENGINEER | `GET /schedules/me` | (mobile) | ✗ | — | — |

> **R30 corrects UI§7.1 and G-UI-16.** The UI spec says *"`NOT AVAILABLE FROM CURRENT API` — no
> zone-list endpoint on this controller"* and proposes deriving zones from `/planner/plants` or
> `/schedules/engineers`. **`GET /api/org/zones` exists and is roled `CENTRAL_SERVICE_MANAGER,
> OPERATIONS_HEAD`** — exactly the two roles that need the picker — and the admin client already wraps
> it as `listZones()`. `[CODE — apps/backend/src/org/zones.controller.ts:26-30;
> apps/admin/src/api/org.ts:82]` **The workaround is unnecessary.** This is a documentation defect in
> the UI spec, not a backend gap.

> **R31 is structurally blind.** `GET /api/intraday-updates` selects `audit_logs WHERE action =
> 'MANUAL_ZM_UPDATE'`. Those rows are written **only** by `POST /intraday-updates/*`, and no admin code
> calls those endpoints — every override the product performs audits as `BATCH_OVERRIDE_*`.
> `[CODE — same-day-update.service.ts:28,105; dispatch-changes-today.service.ts:34-39; grep confirms
> zero admin callers]` The page is a permanent empty state. `R8` is its replacement and is already
> wired into the cockpit's Changes rail.

### 4.2 Preview / projection (read-only, zero writes)

| # | Capability | Scope | API | Frontend | Writes | Staleness proof |
|---|---|---|---|---|:--:|---|
| V1 | **Scheduler preview** — the real recommender, dry-run | any IST day, all zones in scope | `GET /schedules/preview?date=` | `/schedules/preview` | **0** (count-pinned by 2 e2e suites) | mints `previewToken` — **no verifier exists** |
| V2 | **Override impact** — two capacity lanes, rank context, route effect, conflicts | one batch, today | `POST /batches/:id/override/preview` | `OverrideImpactPanel` | **0** (pinned across every table a real move touches) | **none** |
| V3 | **Distribute** — 3 strategies over a selection | today | `POST /schedules/distribute-preview` | `DistributePanel` | **0** | **none** |
| V4 | **Bulk-unassign preview** — per-zone classification + a signed token | pan-India or one zone | `POST /schedules/bulk-unassign` mode `PREVIEW` | `/bulk-unassign` | **0** | **token IS verified → `409 TOKEN_STALE` + `freshPreview`** |

`[CODE — scheduler-preview.service.ts:123,135; override-projection.service.ts:88; distribute-projection.service.ts:10; bulk-unassign.service.ts:137,187,208]`

**V1 vs V4 is the most consequential asymmetry in the product for a console.** `V4` is the only
staged-commit pattern in the backend that actually *verifies* its own token. `V1` mints a token and
`SchedulerPreviewService.checkStaleness()` is fully implemented at `scheduler-preview.service.ts:135` —
and **no controller route calls it.** `[CODE — grep across every scheduling controller returns nothing]`
The SDS documents "re-submit the token, get FRESH or STALE" as a working capability. **It is not.** This
is walkthrough gap G1 / UI gap G-UI-1, and it is the clearest instance of "the business PDF describes a
capability the code does not expose."

**V2 and V3 are only projectable for a subset.** `V2` refuses `REMOVE_TICKET`, `DEFER_TICKET`, `REORDER`
with `400 NOT_PROJECTABLE` — *"`<ACTION>` moves no work between engineers"*. `[CODE —
override-projection.service.ts:88]` This is a **deliberate refusal, not a gap**: answering with zeros
would read as "this move costs nothing".

### 4.3 Mutation (write)

| # | Capability | Roles | API | Frontend home | Preview? | Confirm gates | Class |
|---|---|---|---|---|:--:|---|:--:|
| M1 | **Run dispatch now** (optional zone + reason) | **CSM + OH** | `POST /schedules/dispatch-run` | **`/bulk-unassign` only** (defect F2) | ✗ | in-flight → `409 DISPATCH_ALREADY_RUNNING` | P |
| M2 | **Edit the dispatch cron** | **OH only** | `PUT /schedules/dispatch-schedule` | `/settings` | ✗ | the validator is the parser that will run it | A |
| M3 | **Assign one ticket** | MANAGER | `POST /schedules/assign` | ticket drawer, escalation queue | ✗ | `409 CONFLICT_DEFERRED` → confirm + reason | P |
| M4 | **Assign a plant's work** (legacy shorthand over M5) | MANAGER | `POST /schedules/assign-plants` | `/assign` | via V3 | ↑ | P |
| M5 | **Assign a multi-engineer plan** (lanes) | MANAGER | `POST /schedules/assign-batch` | `/assign` review+commit | via V3 | mandatory `reasonCode` | P |
| M6 | **Override: `REMOVE_TICKET`** | MANAGER | `POST /batches/:id/override` | `/schedules/:engineerId` | **✗ refused** | reason | P |
| M7 | **Override: `DEFER_TICKET`** | MANAGER | ↑ | ↑ | **✗ refused** | reason + date | P |
| M8 | **Override: `REORDER`** | MANAGER | ↑ | ↑ | **✗ refused** | reason + position; **renumbers every stop** | P |
| M9 | **Override: `SWAP_SE`** (whole stop) | MANAGER | ↑ | ↑ | **✓ V2** | ON_SITE + DEFERRED gates | P |
| M10 | **Override: `REASSIGN`** (one ticket) | MANAGER | ↑ | ↑ | **✓ V2** | ↑ | P |
| M11 | **Override: `SPLIT_BATCH`** (subset) | MANAGER | ↑ | ↑ | **✓ V2** | ↑ | P |
| M12 | **Place a hold** (a date on a ticket) | MANAGER | `POST /schedules/holds` | `/schedules/preview`, pool | ✗ | `409 CONFLICT_VEHICLE_UNAVAILABLE` → confirm | P |
| M13 | **Release a hold** | MANAGER | `POST /schedules/holds/release` | ↑ | ✗ | `NOT_HELD` returns as a **200 body**, not a 4xx | P |
| M14 | **Bulk unassign / rebalance** | **OH only** | `POST /schedules/bulk-unassign` mode `EXECUTE` | `/bulk-unassign` | **✓ V4 + verified token** | `409 TOKEN_STALE` | A |
| M15 | **Fire the intraday CRITICAL sweep** | MANAGER | `POST /intraday-insertions/fire` | (no UI) | ✗ | `400 ZONE_REQUIRED` for broad roles | A |
| M16 | **Manually assign an escalation** | MANAGER | `POST /intraday-insertions/:id/manual-assign` | modal from `/intraday` | ✗ | deliberately offers over-capacity and kit-short SEs | P |
| M17 | ~~Same-day add / remove / reorder~~ | MANAGER | `POST /intraday-updates/*` | **no caller** | ✗ | — | **DEAD** |
| M18 | **Create / delete a planner pin** | MANAGER | `POST` / `DELETE /planner` | `/engineers/planner` | ✗ | affects the **next** run only | A |
| M19 | **Edit scoring weights** | **OH only** | `POST /org/scoring-weights` | `/settings` | ✗ | validated against the closed `SCORING_COMPONENTS` set | A |
| M20 | **Edit the SE assignment threshold** | **CSM + OH** | `PUT /settings/assignment-threshold` | `/assignment-threshold` | ✗ | specialised writer; generic `/settings/:key` refuses this key | A |

`[CODE — schedules.controller.ts route decorators lines 163-564; batches.controller.ts; intraday-insertion.controller.ts; se-planner.controller.ts; override.service.ts:29-35 — the six-member `OverrideCommand` union]`

### 4.4 Capabilities the brief named that **do not exist**

| Named | Reality | Evidence |
|---|---|---|
| **"Recover now"** / manual recovery trigger | `NOT FOUND IN CODEBASE`. Recovery is a 5-minute cron only. | `[DOC — W§5.11]` |
| **"Cancel / pause a run"** | No API. `ABORTED` is reaper-only and means *"the process stopped existing"*, not "somebody cancelled it". | `[DOC — W§5.12, UI§8.1]` |
| **"Approve the plan"** | Deliberately absent. *"Approval is never required — inaction means the 05:00 run proceeds exactly as if nobody looked."* No screen may show an Approve button. | `[DOC — UI§3.1]` |
| **"Commit all changes"** / multi-action transaction | No backend construct exists. See §12. | `[CODE]` |
| **Fleet-wide scheduler dashboard** | No aggregate read. The closest is `GET /dispatch/today`, which is single-zone and **refuses to guess**. | `[DOC — W-G2; CODE — dispatch-today.controller.ts:53-58]` |
| **"Split batch"** | Exists — `SPLIT_BATCH` (M11). ✓ | `[CODE]` |
| **"Swap" / "reorder" / "defer" / "hold"** | All exist (M9 / M8 / M7 / M12). ✓ | `[CODE]` |
| **"Distribute work"** | Exists as a **preview only** (V3). There is **no endpoint that commits a Distribute result** — it feeds the client draft, which commits through `assign-batch`. | `[CODE — distribute-projection.service.ts; UI§17.3]` |
| **Live GPS / ETA / route line / map** | `NOT AVAILABLE`. No live GPS in Phase 1; ruled out by `#258 Q6` and `#272 R7`. Distance exists **only** as a scoring term. | `[DOC — UI§11.5; CODE — #272:57]` |
| **Standing engineer ranking / productivity** | Scores exist only per (ticket, candidate) inside a run. There is no engineer-level score. | `[DOC — UI§11.5]` |
| **Run progress %** / current zone / current stage | The engine has no stage concept and no total-zone count while running. Heartbeat is not exposed. | `[DOC — UI§8.2; W-G9]` |

---

## 5. Current UI and Navigation Map

### 5.1 What is built, verified

| Surface | Route | Lines | Verified |
|---|---|---:|---|
| Today's Dispatch (Plan / Live / Replay) | `/dispatch/today` | 553 | `[CODE]` |
| — `CrewCard` (lanes, chips, provenance) | — | 166 | `[CODE]` |
| — `DecisionTrace` / `TracePanel` | — | 160 | `[CODE]` |
| — `ConfigInEffectPanel` | — | 152 | `[CODE]` |
| Assign Work Console | `/assign` | 1,037 | `[CODE]` |
| — `ReviewCommitScreen` | — | 287 | `[CODE]` |
| — `DistributePanel` | — | 204 | `[CODE]` |
| — `CandidateColumn` | — | 154 | `[CODE]` |
| — `LaneCoverage` / `grammar.tsx` | — | 119 / 95 | `[CODE]` |
| **Schedule Detail — the override surface** | `/schedules/:engineerId` | 591 | `[CODE]` — impact panel wired at `:317, :334, :479` |
| Scheduler Preview | `/schedules/preview` | 493 | `[CODE]` |
| Zone Dispatch Table | — | 420 | `[CODE]` |
| Intra-day Queue (**dead**) | `/intraday` | 345 | `[CODE]` |
| Bulk Unassign (OH) | `/bulk-unassign` | 343 | `[CODE]` |
| SE Planner | `/engineers/planner` | 288 | `[CODE]` |
| Schedules list | `/schedules` | 274 | `[CODE]` |
| Batch Detail | `/batches/:batchId` | 258 | `[CODE]` |
| Run Detail | `/dispatch-runs/:runId` | 195 | `[CODE]` |
| `ZoneUnassignableTable` | — | 119 | `[CODE]` |
| `IntradayManualAssignModal` | — | 117 | `[CODE]` |
| Zone Detail | `/dispatch-runs/:runId/zones/:zoneId` | 93 | `[CODE]` |
| Runs ledger | `/dispatch-runs` | 89 | `[CODE]` |

**Total ≈ 6,552 lines of scheduler UI already exists.** `[CODE — wc -l]` This is a brownfield problem,
not a greenfield one.

### 5.2 The navigation as it stands `[CODE — components/shell/nav.ts]`

```
Operations                                (18 rows for a manager)
  ├── Zone Dashboard          /
  ├── Tickets                 /tickets
  ├── Assign Work             /assign            ◄── the manual write surface
  ├── Create Install          /install
  ├── SE Activity             /engineers
  ├── Manage SEs              /engineers/manage
  ├── SE Planner              /engineers/planner ◄── the soft-bias pin
  ├── Verification Review · Readiness · Non-Operational · Cross-Zone
  ├── Tier Overrides · Recovery Decisions · Leave Requests · Expense Vouchers
  └── …

Dispatch                                  ◄── the scheduler cluster (#281)
  ├── Today's Dispatch        /dispatch/today    "What is happening now"       [PRIMARY]
  │     Scheduler Preview     /schedules/preview "What the next run would do"  [indent]
  │     Schedules             /schedules         "Committed day plans"         [indent]
  │     Intra-day Queue       /intraday          "Changes to today's plan"     [indent, DEAD]
  └──   Dispatch Runs         /dispatch-runs     "What past runs did"          [indent]

Components & Warehouse · Analytics
Policy   (CSM + OH)     SE Assignment Threshold  /assignment-threshold
Admin    (OH only)      Bulk Unassign · Settings · Plant Zones · Build Health · …
Support
```

**The nav already carries the tense model as visible copy** — each Dispatch row has a `hint` naming the
operator question it answers. `[CODE — nav.ts:130-160]` This is `#281`'s delivered work and is the
scaffolding any console would sit on.

### 5.3 Page → capability map

| Page | Capabilities inside | Why a user goes there | The related capability that lives elsewhere |
|---|---|---|---|
| **`/dispatch/today` Live** | R1 R2 R3 R4 R5 R6 R7 R8 | "what is happening now; what needs me" | **Every action.** The page is read-only by controller contract (`dispatch-today.controller.ts:19-22`) |
| **`/dispatch/today` Plan** | link out to R9; a **broken** M1 link | "what will the next run do" | The projection itself (`/schedules/preview`); the real M1 trigger (`/bulk-unassign`) |
| **`/dispatch/today` Replay** | R22 R23 | "what did the run decide, in its order" | The run header, config and zone cards (`/dispatch-runs/:runId`) |
| **`/schedules/preview`** | R9 R10 M12 M13 | "what would happen; hold something back" | The committed twin (`/schedules`); everything else |
| **`/schedules`** | R11 | "the committed plans" | Every action (they are on the detail page) |
| **`/schedules/:engineerId`** | R12 **M6–M11** V2 | "change this engineer's day" | The whole situation; the pool; the candidates; the trace |
| **`/assign`** | R14 R15 R16 V3 M4 M5 | "hand out unassigned work" | The committed plans it will land on; the cockpit |
| **`/dispatch-runs`** | R17 | "the ledger" | — |
| **`/dispatch-runs/:runId`** | R18 R19 | "what config was in force; per-zone outcome" | The decision stream (reached via cockpit Replay **or** here) |
| **`/dispatch-runs/:runId/zones/:zoneId`** | R20 | "this zone's batches and unassignable" | The live version of the same zone (the cockpit) |
| **`/batches/:batchId`** | R21 R23 | "one stop's rows and why" | The override actions on the same batch (`/schedules/:engineerId`) |
| **`/intraday`** | R6 R29 M16 · R31 **dead** | "resolve an escalation" | The interception strip on the cockpit that names the same escalations |
| **`/engineers/planner`** | R27 M18 | "pin an engineer to a plant for a date" | The `plannerBias` badge in the trace that says whether it mattered |
| **`/bulk-unassign`** | V4 M14 · **and M1** | "rebalance" | **M1 belongs on the cockpit** |
| **`/settings`, `/assignment-threshold`** | R25 R28 M2 M19 M20 | "tune the engine" | The frozen `configSnapshot` on a run that shows what was in force |

---

## 6. Where the Current Experience Is Fragmented

Ranked by operational cost, not aesthetics.

### F1 — The situation and the actions on it are on different pages

**The cockpit is read-only by controller contract.** `dispatch-today.controller.ts:19-22`: *"the
cockpit's writes go to the endpoints that already own them… because #282 R5 forbids a second
implementation of anything the engine already does."* `[CODE]`

The **intent** of that contract is correct — no second implementation. But the *consequence* as
shipped is that a manager who sees "Ravi is over capacity and has 6 stops" on the cockpit must navigate
to `/schedules/:seId` to move one, losing the whole situation view. Then to see whether the move fixed
the *zone*, they navigate back.

**And it is unnecessary.** `GET /dispatch/today` already returns every identifier the six override
commands need:

| Override command needs | Present in the cockpit payload? |
|---|---|
| `batchId` (the path param) | ✓ `engineers[].stops[].batchId` |
| `ticketId` / `ticketIds[]` | ✓ `engineers[].stops[].tickets[].ticketId` |
| `newSeId` | ✓ `engineers[].seId` (and `GET /schedules/engineers`) |
| `stopSequence` | ✓ `engineers[].stops[].stopSequence` |
| `deferredToDate`, `reasonCode` | user input |

`[CODE — dispatch-today-query.service.ts:10-51 (`TodayTicket`, `TodayStop`, `TodayEngineer`) vs
override.service.ts:29-35]`

**The same is true of five more capabilities:**

| Capability | Ids needed | In the cockpit payload today |
|---|---|---|
| Override impact preview (V2) | `batchId` + the same command body | ✓ |
| Assign one ticket (M3) | `ticketId` + `seId` | ✓ (`rails.unassignable[].ticketId`, lanes' `seId`) |
| Place / release a hold (M12/M13) | `ticketId` | ✓ (both rails) |
| Candidate column (R15) | `plantIds` | ✓ (`stops[].plantId`, `rails.unassignable[].plantId`) |
| Resolve an escalation (M16) | `insertionId` + `seId` | ✓ (`escalations[].insertionId`) |

> **CONFIRMED FROM CODE: the cockpit is one screen away from being commandable, and zero endpoints
> away.** Nothing in `#282 R5` forbids *calling* the owning endpoint from the cockpit — it forbids
> *reimplementing* it. **This is the single largest fragmentation win available and it needs no backend
> change.** `[INFER, from CODE]`

### F2 — The run trigger is on the wrong page, and its link is broken

Plan mode renders a **"Run dispatch"** button that navigates to `/bulk-unassign`.
`[CODE — TodaysDispatchPage.tsx:424-426]` The only caller of `POST /schedules/dispatch-run` in the whole
admin app is `api/bulkUnassign.ts:136`. `[CODE — grep]`

So the engine's own trigger lives inside an **Operations-Head-only rebalance page**, which a CSM (who
*has* the role for the trigger) cannot open, disconnected from the projection that says what it would
do and from the run it creates. `#282 R1` explicitly listed *"the **Run dispatch** action… relocated —
not a new trigger"* as in-scope for `#285`; `#285` was marked done and the relocation did not land.
`[CODE — issue #282:20-24 vs TodaysDispatchPage.tsx:424]` **This is a delivery gap against an approved
ruling, not a new design question.**

### F3 — Two of three roles cannot open the primary screen at all

`GET /dispatch/today` returns `400 ZONE_REQUIRED` when a multi-zone role does not name a zone —
deliberately: *"there is no honest default — 'all zones' is not a cockpit, it is a different product."*
`[CODE — dispatch-today.controller.ts:53-58]`

`TodaysDispatchPage` has **no zone picker**; it renders an `EmptyState` with a **Try again** button that
re-issues the identical failing request. `[CODE — TodaysDispatchPage.tsx:48, 100-110]` A CSM or
Operations Head clicking "Today's Dispatch" in the sidebar gets an unrecoverable error. The behaviour is
even *tested as an error state* (`test/todays-dispatch.test.tsx:372-378`). `[DOC — UI§1.4 F1]`

The fix is trivial and needs no backend work — `GET /api/org/zones` exists and is roled for exactly
those two roles (§4.1 R30).

### F4 — The engine's own explanation is served and thrown away

The backend persists on every trace:
- `chosen.breakdown` — six components, their weights, `baseScore`, `clusterMultiplier`, `distanceKm`
- `filterStates[]` — a tri-state verdict for **all five** hard filters, on the **chosen row and every
  runner-up**, in evaluation order

`[CODE — recommender.service.ts:727, 897, 903, 924; scoring.ts:143-153]`

The client types `TraceChosen` and `TraceRunnerUp` in `api/dispatch-runs.ts:219-259` **omit both
fields**, and no component reads them. `[CODE]` The UI shows only the trace-level `notEnforcedFilters`
array.

**This is not fragmentation — it is unrendered data.** It matters here because it is the strongest
available answer to "why did the engine do this", and it is *already in the payload of a panel that is
already inline*. It does not need a console.

### F5 — The work pool and the day plan are different shapes with different scope rules

| | Work pool (`/assign`) | Cockpit (`/dispatch/today`) |
|---|---|---|
| Shape | company → plant → counts | engineer → stop → ticket |
| Selection unit | a **(company, plant)** pair | a **ticket** or a **stop** |
| Per-ticket rows | **none** — resolved late via `/assignable-tickets` | ✓ every ticket |
| Zone scope for CSM/OH | **global** (`zoneClamp` returns null) | **one zone, mandatory** |
| Acting-zone honoured | ✓ | ✓ |

`[CODE — assignable-work-query.service.ts:66-70 `zoneClamp`; dispatch-today.controller.ts:53-58]`

**The scope mismatch is real and would bite a merged console immediately.** A CSM on a merged screen
would see a pan-India pool beside a single-zone deck, and the two counts would not reconcile.

### F6 — Acting-zone is honoured inconsistently across `/schedules`

`scopeFor(user, actor)` collapses an acting CSM/OH into `{role:'ZONAL_MANAGER', zoneId: actingZone}`.
It is applied on 10 of the 20 `/schedules` routes and **not** on `preview`, `list`, `engineers` or
`:engineerId`. `[DOC — W§24.1; #239 owns the sweep]`

> **An Operations Head acting in a zone sees that zone's work pool but a pan-India preview.**

On today's fragmented pages this is confusing. **On one merged console it becomes a correctness
problem**, because two panes on the same screen would silently be scoped differently.

### F7 — Explaining a ticket requires already knowing its run

There is no `GET /tickets/:id/decision`. A trace is addressable only as
`/dispatch-runs/:runId/tickets/:ticketId/trace`. `[DOC — G-UI-5]` So "why is this ticket here?" asked
from a ticket drawer, from the pool, or from an unassignable rail has **no direct answer** — the
operator must first find the run.

### F8 — A dead page occupies a nav row and promises the one thing it cannot do

`/intraday` is indented under Schedules with the hint *"Changes to today's plan"* `[CODE — nav.ts:154]`,
reads an audit action no admin code writes, and is a permanent empty state. Its replacement
(`/dispatch/today` Changes rail) is already built and wired. `[CODE]`

Note: the page is **not** entirely dead — it also hosts the escalation manual-assign modal (M16, R29),
which is live and useful. `[CODE — IntradayQueuePage.tsx, IntradayManualAssignModal.tsx]` Retiring the
route without relocating that modal would remove a working capability.

### F9 — Duplicated concepts across surfaces

| Concept | Appears as | Risk |
|---|---|---|
| "Unassignable" | cockpit rail (today, live) · zone card `unassignable` + `unassignableReasons` (per run) · distribute `unplaced[]` | Three populations with three scopes and two vocabularies |
| "Capacity" | `LoadBadge` on six different reads | Correctly one definition (`committedDayLoad`), but no single place to *ask* about an engineer |
| "A zone's state" | cockpit (live) · zone card (per run) | Two genuinely different questions — correctly separate (UI§9.1) |
| "Candidates" | `/candidates` (`PASSED`/`DROPPED`, no score) · trace runners-up (`PASSED`/`DROPPED`/`TIER_NOT_REACHED`, with scores) | **Two vocabularies for one engine** — deliberate, but a console puts them side by side (§21 Q9) |
| "Changes today" | `/dispatch/changes-today` (works) · `/intraday-updates` (blind) | One right, one wrong, both linked |

---

## 7. Which Capabilities Belong in One Operational Workflow

### 7.1 The test used

A capability belongs in the console when **it is something an operator does or needs *while* looking at
one operating day of one zone**, and its identifiers are already in scope. It belongs outside when it is
**a destination the operator navigates *to* deliberately**, on its own object (a run, a date range, a
config value).

### 7.2 Belongs in the console (evidence-backed)

| Capability | Why | Ids already in scope? |
|---|---|---|
| R1–R8 the whole situation payload | It *is* the operating day | — |
| **M6–M11 the six overrides** | The operator's next act after reading a lane | **✓ all** `[CODE]` |
| **V2 override impact** | Exists only in the context of a proposal | **✓** |
| **M3 assign one ticket** | The unassignable rail's only useful action | **✓** |
| **M12 / M13 hold + release** | The held rail's only useful actions | **✓** |
| **R15 candidates** | "why not them" for a plant already on screen | **✓** `plantId` |
| **M16 / R29 resolve an escalation** | The interception strip's action | **✓** `insertionId` |
| **M1 run dispatch** (CSM/OH) | Approved as in-scope by `#282 R1`; the trigger's context is a zone's day | ✓ `zoneId` |
| **R24 in-flight** | Exists precisely so M1 can be disabled *before* the click | ✓ |
| **R22 / R23 decision stream + trace** | Already inline in Replay | ✓ |
| **R14 the work pool** | Contentious — see §7.3 | ✓ but different shape/scope |

### 7.3 The hard question: does `/assign` belong inside?

**Arguments it does (the "single workspace" reading):**
- `#272`'s own design is already a three-column board (pool · draft lanes · candidates) with a ledger
  header — structurally the same object as the crew deck.
- The two boards share one visual grammar by ruling — *"the two boards read as one product"*.
- An operator's real loop is *"this ticket is unassignable → who could take it → put it on Ravi"*, which
  today crosses two routes.
- The engineer lane is the same object in both: a row with load, coverage and work chips.

**Arguments it does not (and these are load-bearing):**
- **`#280 R7`** rules them separate: write surface vs read surface. Reaffirmed twice. `[CODE]`
- **Different commitment semantics in the same visual object.** `/assign` chips are a **client-side
  draft that writes nothing until commit** (`#272 R2`). Cockpit chips are **committed rows whose every
  move writes immediately** (M6–M11). Putting draft chips and committed chips in one lane means one
  visual object with two meanings — precisely what the shared grammar forbids ("never the same shape
  for two meanings"). `[CODE — #272:62-74]`
- **Different scope rules** (F5) — pool is pan-India for CSM/OH; the deck refuses to be.
- **Different selection unit** — plant-shaped vs ticket-shaped.
- **`/assign`'s draft is session-local by ruling** (`#272 Q2`): *"Leaving the page loses it, and the page
  says so."* A console that a manager keeps open all day would make that loss much more expensive.

**`[OPEN]` — this is the central design decision of the whole exercise.** See §21 Q2.

### 7.4 Belongs outside — as supporting, historical or diagnostic

| Capability | Why it stays out |
|---|---|
| R17–R21 the run ledger and its drill-down | Evidence is **immutable and separately addressable**. A run is its own object with its own lifetime. |
| R9 / R10 the scheduler preview | **Date-addressable** (any IST day) and must never read as a commitment (`#280 R2/R3`). Reachable *from* the console; not a pane *inside* today. |
| R26 bulk-unassign history + M14 | OH-only rebalance with its own verified token flow. A genuinely different, rarer act. |
| R27 / M18 SE Planner | A grid over **dates × plants**, not over one day. Affects the **next** run only. |
| R25 / R28 / M2 / M19 / M20 config | Changing the engine's tuning is not operating it. The console shows what *was* in force (frozen `configSnapshot`); `/settings` changes what *will be*. |
| R11 the schedules list | Arguably absorbed: the cockpit's lanes are the same information for one zone. But the list is not date-scoped by default and spans zones. See §18. |

---

## 8. Controls That Must Remain Accessible

The brief's principle — **single workspace ≠ fewer capabilities** — is correct and is also already this
repository's own rule (`#282 R5`, `#272 R1`). Below, the brief's proposed A–G taxonomy is **validated
against the implementation**, and corrected where the code disagrees.

### A. Global controls (the console's context)

| Proposed | Reality |
|---|---|
| **Date** | ⚠ **Partly wrong.** `GET /dispatch/today` has **no date parameter** — it is *today*, `istDate(now)`, always. `[CODE — dispatch-today-query.service.ts]` Only `/schedules/preview` (`?date=`) and `/schedules` (`?date=`) are date-addressable. **A date picker on a live console would be a lie.** |
| **Zone** | ✓ Correct and **mandatory** for CSM/OH. `GET /org/zones` supplies the list. |
| **Run** | ✓ For Replay only. The run is discovered from `today.run`, or chosen from `/dispatch-runs`. |
| **Preview** | ✓ As a *mode*, not a toggle over live data — it is a different endpoint with different trust. |
| **Refresh** | ✓ Manual `refetch`. **No websocket, no SSE, no event stream exists** — do not invent one. `[DOC — UI§8.3]` |
| **Distribution** | ✗ **Not global.** `distribute-preview` takes explicit `ticketIds` + `engineerIds` — it is a *selection-scoped* control, i.e. category D. |
| **Schedule context** (cron, `nextFireAt`) | ⚠ **OH-only today.** A ZM cannot learn when the run fires and cannot infer it (the hour is configurable). Gap **G-UI-3**. |

### B. Contextual ticket controls (a ticket is selected)

`Assign` (M3) · `Reassign` (M10) · `Remove from plan` (M6) · `Defer to a date` (M7) · `Hold` (M12) ·
`Release hold` (M13) · `Open the trace` (R23) · `Open the ticket drawer` · `See candidates for its
plant` (R15).

**All addressable from ids already in the cockpit payload.** `[CODE]` Which subset is valid depends on
one thing: **is the ticket on a plan or not?** `POST /holds` returns `409 TICKET_NOT_HOLDABLE` for an
assigned ticket; `assignTicket` refuses an already-assigned ticket. `[DOC — UI§20.2, §7.6]`

### C. Contextual engineer controls (an engineer is selected)

`Swap a whole stop to someone else` (M9) · `Reorder their stops` (M8) · `Split a stop` (M11) ·
`Open their day plan` (R12) · `See their load across all zones` (R13).

**Caveat the console must carry:** `committed` is **not zone-filtered** — *"a floating SE's work in a
neighbouring zone is still work they have to do."* `[DOC — W§25.20]` So a lane showing 5/6 with three
stops visible is correct, and the console must explain it or it looks like a bug.

**Not available:** live position, ETA, route geometry, shift start/end (persisted, read by nothing),
utilization history, standing ranking. `[DOC — UI§11.5]`

### D. Bulk / selection controls (several tickets or engineers)

`Distribute` across chosen engineers (V3, three strategies) · `Assign a batch of lanes` (M5) ·
`Split a stop` (M11) · `Assign a plant's work` (M4).

**All of these live in `/assign` today.** They are the strongest argument for §7.3's merge — and the
`COVERAGE_TIER` strategy must be labelled differently from the other two, because one *is* the engine's
answer and two are allocation policy. `[DOC — UI§17.3]`

### E. Exception / recovery controls

`Resolve an escalation` (M16) · `Reassign stranded work` (M10, when `assignedSeId` is non-null) ·
`Run dispatch for an EXHAUSTED zone` (M1) · **inspect** `seSkips`, zone `error`, `contendedWithRunId`,
MV staleness.

**There is no "recover now" and no "retry this zone" API.** `[DOC — W§5.11/5.12]` The only recovery
lever a human has is M1, and only when the recovery state is `EXHAUSTED`. **A console must not render a
retry affordance that does not exist.**

**Two states with no UI at all today:** notification-delivery failure (G-UI-14) and "the scheduler is
switched off" (G-UI-15). `[DOC — UI§22.2]`

### F. Explainability / intelligence

`trace.chosen` + 5 runners-up · verdicts (`PASSED`/`DROPPED`/`TIER_NOT_REACHED`) · `dropCounts` ·
`scoreDegenerate` · `notEnforcedFilters` · **`filterStates` (unrendered)** · **`breakdown`
(unrendered)** · `plannerPlanned` vs `plannerBias` · `poolEmptyReason` · `configSnapshot` ·
`bucketsAsOf` (preview only).

### G. Advanced / diagnostic

`runId`, `batchId`, `scheduleId`, `weightSetRef`, raw `configSnapshot`, `buildVersion`/`fingerprint`,
`contendedWithRunId`, `seSkips[].constraint`, `eligibilityMv.lastError`, `assignmentThresholdHours`.
**Behind an expander, Operations-Head-first.** `[DOC — UI§34]`

**Never render:** `traceId`, `heartbeatAt`, advisory-lock keys, `cron_tick_claims`, `previewToken`,
`P2002` codes, `retryChain`, `RecPath`. `[DOC — UI§34]`

**One vocabulary rule that outranks all of the above:** `DEFICIT` / `PREVENTIVE` must **never** reach a
user — map through `utils/operatingModeCopy.ts` ("Catch-up" / "Steady"). This is the backend's own
instruction. `[DOC — UI§34.1]`

---

## 9. User Roles and Their Operational Needs

| | Zonal Manager | Central Service Manager | Operations Head |
|---|---|---|---|
| **Zone scope** | Own zone, clamped **server-side at every read** | Global; **must name a zone** for the cockpit | Global; **must name a zone** for the cockpit |
| **Primary question** | "Is my zone's day intact, and what needs me?" | "Which zone is in trouble, and can I intervene?" | "Is the engine behaving, and is the policy right?" |
| **Can trigger a run** | ✗ | ✓ | ✓ |
| **Can see in-flight runs** | ✗ | ✓ | ✓ |
| **Can see when the run fires** | ✗ (**G-UI-3**) | ✗ (**G-UI-3**) | ✓ |
| **Overrides, holds, assign, escalations** | ✓ | ✓ | ✓ |
| **Bulk unassign** | ✗ | ✗ | ✓ |
| **Scoring weights** | ✗ | ✗ | ✓ |
| **Assignment threshold** | ✗ | ✓ | ✓ |
| **Acting-as-zone** | n/a | ✓ (inconsistently honoured — F6) | ✓ (same) |

`[CODE — controller `@Roles` decorators; DOC — UI§4.1]`

**Three consequences for a console:**

1. **The ZM's console is genuinely simpler** — no zone picker, no run trigger, no config. Hiding rather
   than disabling is the repo's stated rule: *"showing a permanently-disabled control teaches nothing."*
   `[DOC — UI§4.4]`
2. **The CSM/OH console has a first-run problem no ZM console has.** Their landing state is *"choose a
   zone"*, not a dashboard. The backend refuses to guess on purpose. `[CODE]`
3. **A ZM cannot answer "why is my deck empty at 04:55?"** because `dispatch-schedule` is OH-only and
   `in-flight` is OH/CSM. This is a real hole in the ZM's primary screen and it is a backend gap
   (**G-UI-3**), not a layout problem.

---

## 10. Current Backend Capabilities Relevant to a Unified Console

### 10.1 What genuinely supports the vision

| Capability | Why it matters | Evidence |
|---|---|---|
| **One zone-day read that carries almost everything** | `GET /dispatch/today` returns run, recovery, lanes, stops, tickets, provenance, 6 counters, 4 rails and escalations in **one** call | `[CODE — dispatch-today-query.service.ts:126-150]` |
| **Every action id is already in that payload** | §6 F1 — six overrides, impact preview, assign, hold, release, candidates, escalation resolve | `[CODE]` |
| **Previews are the real engine with writes suppressed** | Not a re-implementation; count-pinned to zero writes by e2e | `[DOC — W§5.3, W§31.5]` |
| **Ten shared-definition seams** | `committedDayLoad`, `candidateReadiness`, `tierScoreChooser`, `scheduleStatus`, `deferral`, `assignableWork`, `componentBlocked`, `scoringConfig`, `slaBucket`, `istDay` — each with an e2e asserting two callers agree | `[DOC — W§3.3]` |
| **The engine's own eligibility is published** | `/candidates` calls the *identical* functions the run calls, dropped candidates included | `[DOC — W§25.15]` |
| **Blast radius is contained by design** | A zone fails, not a run; an engineer fails, not a zone; a notification fails, not a dispatch | `[DOC — SDS §10 R3]` |
| **Provenance is persisted, not derived** | `addSource` / `addedBy` / `addReason` / `coverageTypeAtAssign` on every ticket row (#283) | `[CODE — dispatch-today-query.service.ts:10-25]` |
| **Recovery is a first-class state** | `dispatch_zone_recoveries` with `PENDING`/`RECOVERED`/`EXHAUSTED`/`EXPIRED` + attempts + `lastError` | `[CODE]` |
| **A zone list exists for the picker** | `GET /org/zones`, roled CSM+OH | `[CODE — zones.controller.ts:26-30]` |

### 10.2 What actively limits it

| Limit | Consequence for a console |
|---|---|
| **No fleet-wide aggregate read** (W-G2) | A pan-India console cannot be built. The backend refuses to guess a default zone *on purpose*. |
| **`GET /dispatch/today` has no date parameter** | The console is *today*, or it is a different endpoint. No "yesterday's console". `[CODE]` |
| **No websocket / SSE / event stream** | Everything is polling. `[DOC — UI§8.3]` |
| **No run progress, no current zone, no heartbeat exposure** | No progress bar can be honest. Only "running · elapsed". `[DOC — UI§8.2; W-G9]` |
| **No cancel / pause / retry-zone API** | Exception controls are limited to escalation resolve + a full re-run. |
| **No multi-action transaction** | See §12. |
| **`checkStaleness` has no route** | A preview cannot tell the operator it went stale. `[CODE]` |
| **Acting-zone inconsistency (F6)** | Two panes on one screen could silently differ in scope. |
| **Two funnel populations absent from the live read** | `componentBlockedWithheld` and `bucketlessDropped` exist only per-run. Scraping the run detail onto the console would mix per-run with per-day figures and they would disagree the moment a zone re-dispatches. `[DOC — UI§7.4]` |
| **Cross-zone refusal styles are not uniform** | 403 on one route, 404 on another, silent omission on a third. A console showing several panes must handle three failure shapes. `[DOC — W§38.4]` |

---

## 11. Current Frontend Capabilities Relevant to a Unified Console

### 11.1 The stack, as it is

| Concern | Convention | Location |
|---|---|---|
| HTTP | `fetch` + `authHeaders()`, one module per domain | `api/*.ts` (44 modules) |
| 401 handling | global rotating-refresh interceptor over `window.fetch` | `api/http.ts` |
| Fetching | `useApiResource<T>(fetcher, deps, errorMsg)` → `{data, loading, error, refetch}` | `hooks/index.ts` |
| Mutating | `useAsyncAction<A>(fn, onError)` → `{run, pending, error}` | ↑ |
| Routing | `react-router-dom` v6 + `RoleRoute` | `AppRoutes.tsx` |
| **Caching** | **none** | — |

`[DOC — UI§29.1; CODE — AppRoutes.tsx]`

**The absence of a query cache is a first-order constraint on a console.** With today's page-per-concern
split, each page owns its reads and a mutation refetches one or two. **A console holding six panes over
overlapping reads would need either a lifted shared fetch or a cache.** Today's `useApiResource` calls
are per-component and independent; six panes would issue six independent requests and drift out of sync
after any mutation. `[INFER, from CODE]` `UI§27` already specifies a mutation → refetch contract per
action; a console makes that contract mandatory rather than advisory.

### 11.2 Components that already exist and are correct

`CrewCard` · `TicketChip` · `ProvenanceLegend` · `LoadBadge` · `Rail` · `PolicyWithheldCard` ·
`RecoveryNotice` · `CriticalInterceptionStrip` · `DecisionStreamRow` · `TracePanel` ·
`DecisionTraceView` · `ZoneStatusCard` · `ConfigInEffectPanel` · `CandidateColumn` · `DistributePanel` ·
`ReviewCommitScreen` · `OverrideDialog` · **`OverrideImpactPanel`** · `DeferralConfirm` ·
`DispatchTimelineNote` · `MetricStrip` · `EmptyState`. `[DOC — UI§32; CODE — components/domain/]`

> **A console is largely a re-composition of components that exist.** The override dialog, the impact
> panel, the deferral confirm, the candidate column and the crew card would all move as-is.

### 11.3 What is missing on the client only (no backend work)

| # | Missing | Effect | Cost |
|---|---|---|---|
| **F3-a** | `ScoreBreakdownTable` — `trace.chosen.breakdown` | The engine's own arithmetic is served and discarded | client type + one table |
| **F3-b** | `FilterStateStrip` — per-candidate `filterStates[]` | 5 tri-state dots per candidate; today only one drop reason shows | client type + one strip |
| **F3-c** | `CandidateTierGroup` — tier-grouped ranking | A flat list implies a floating SE out-scored a dedicated one | one component |
| **F1-a** | `ZoneSwitcher` (CSM/OH) | Two of three roles cannot open the primary screen | one select + `GET /org/zones` |
| **F2-a** | `RunDispatchButton` + in-flight guard | The trigger is on the wrong page | one button + one poll |
| **C4** | Pass `?date=` from every surface that says "today" to `GET /schedules` | Without it the list returns never-closed plans from last week | one query param |

`[DOC — UI§38.2; CODE — verified F3-a/b/c and F1-a/F2-a still absent 2026-08-27]`

---

## 12. Preview, Impact, Draft, and Commit Reality

**This section exists so the console does not promise a "Commit All Changes" workflow the backend
cannot safely support.**

### 12.1 Every mutation, classified as the brief asks

Classes: **(1)** immediate only · **(2)** has a preview/impact endpoint · **(3)** could be a UI draft
before *individual* commit · **(4)** could join a future backend change-set · **(5)** unknown / needs
backend work.

| Mutation | 1 | 2 | 3 | 4 | Notes |
|---|:--:|:--:|:--:|:--:|---|
| M1 run dispatch | ✓ | ✗ | ✗ | ✗ | It *is* the engine. A draft of a run is a preview (V1). |
| M2 edit cron | ✓ | ✗ | ✗ | ✗ | Config, not an operation. The validator is the parser that will run it. |
| M3 assign one ticket | ✓ | ✗ | **✓** | **plausible** | Idempotent-ish: `409 TICKET_ALREADY_ASSIGNED` is a clean loss. |
| M4 assign-plants | ✓ | via V3 | **✓** | **plausible** | Already a shorthand over M5. |
| M5 assign-batch | ✓ | via V3 | **✓ already is** | **plausible** | **The existing draft precedent.** Client-side lanes; commit is one tx *per lane*. |
| M6 `REMOVE_TICKET` | ✓ | **✗ refused** | ✓ | **plausible** | Preview refused deliberately. |
| M7 `DEFER_TICKET` | ✓ | **✗ refused** | ✓ | **plausible** | ↑ |
| M8 `REORDER` | ✓ | **✗ refused** | ⚠ | **hard** | **Renumbers every stop.** Two drafted reorders on one schedule are not composable. |
| M9 `SWAP_SE` | ✓ | **✓ V2** | ✓ | **plausible** | |
| M10 `REASSIGN` | ✓ | **✓ V2** | ✓ | **plausible** | |
| M11 `SPLIT_BATCH` | ✓ | **✓ V2** | ✓ | **plausible** | |
| M12 place hold | ✓ | ✗ | ✓ | **plausible** | |
| M13 release hold | ✓ | ✗ | ✓ | **plausible** | |
| M14 bulk unassign | ✓ | **✓ V4, token verified** | ✓ | **✓ the closest precedent** | One tx per zone under an advisory lock. |
| M15 fire sweep | ✓ | ✗ | ✗ | ✗ | It is the engine. |
| M16 manual-assign escalation | ✓ | ✗ | ✓ | **plausible** | |
| M18 planner pin | ✓ | ✗ | ✓ | ✗ | Affects the **next** run — not part of today's change-set. |
| M19 / M20 config | ✓ | ✗ | ✗ | ✗ | Not operations. |

### 12.2 What the backend actually supports today — the five findings

**Finding 1 — There is exactly one verified staged-commit pattern, and it is not the scheduler
preview.** `M14` bulk-unassign: `PREVIEW` → signed token over a per-zone classification → `EXECUTE`
re-reads and compares → `409 TOKEN_STALE` + `freshPreview`. `[CODE — bulk-unassign.service.ts:137,
187, 208]` **Every other preview in the product is advisory.**

**Finding 2 — The scheduler preview's staleness proof is unusable.** `signPreviewToken` is called;
`checkStaleness` is implemented at `scheduler-preview.service.ts:135`; **no route reaches it.** `[CODE]`
The SDS describes it as working. **This is a direct SDS-vs-code contradiction and it is stated, not
reconciled.**

**Finding 3 — The override impact preview has no staleness signal at all.** *"If the world moves
between preview and confirm, the confirm's own 409 is the only defence."* `[DOC — UI§17.2]` A draft
basket holding several previewed overrides would age silently.

**Finding 4 — Transaction granularity is per-SE / per-lane by explicit ruling, not by accident.**
`#262` made dispatch one transaction per SE; `#275`/`#272 R8` made `assign-batch` one transaction per
lane, *"per-engineer-transactional and reports per engineer. A lane that fails is legible and
re-runnable while the rest stand. **No aggregate success toast over a partial write.**"* `[CODE — #272:59-61]`

> **This is the single most important constraint on a "Commit All" bar.** The product has already
> ruled that a multi-item commit reports **per item** and that partial success is the *normal case*. A
> console draft basket is therefore compatible with the architecture **only if it commits item-by-item
> and reports item-by-item.** An atomic "all-or-nothing" promise contradicts a standing ruling and has
> no backend construct behind it.

**Finding 5 — Two override actions are structurally hostile to a draft.** `REORDER` renumbers every
stop `1..n` `[DOC — UI§19.3]`, so two queued reorders on one schedule compose unpredictably. And the
write is **conditional on the row still being live**; losing that race aborts *and the audit entry rolls
back with it* — surfacing as `404 BATCH_NOT_FOUND`, which after an override means *"somebody else got
there first"*, not "gone". `[DOC — UI§19.3, §30.3]` A draft basket widens that race window by exactly
the time the basket sits open.

### 12.3 What a console may honestly offer

| Model | Honest today? | Why |
|---|:--:|---|
| **Preview one change, then commit it** | ✓ | For `SWAP_SE`/`REASSIGN`/`SPLIT_BATCH` and Distribute. Already built. |
| **Draft several *assignments*, then commit as lanes** | ✓ | `assign-batch` already does exactly this. |
| **Draft several *overrides*, then commit them one by one with per-item results** | ⚠ **buildable, with caveats** | Needs an explicit "these commit individually" statement, a per-item result list, staleness re-check on open, and `REORDER` excluded or last-only. `[INFER]` |
| **One atomic "Commit all changes" transaction** | ✗ | **No backend construct. Contradicts `#272 R8` / `#262`.** Would be new backend work with a real design question (what is the unit of atomicity — the SE? the zone?). |
| **A shared, resumable, cross-session draft** | ✗ | Explicitly rejected for v1 by `#272 Q2` — *"it needs its own table, an owner, and a reconciliation rule for when the underlying tickets move out from under it."* `[CODE — #272:130-136]` |

---

## 13. Copilot / Intelligence Opportunities

The brief asks which Copilot interpretations the existing data and APIs can support. **No LLM
integration exists anywhere in this repository** — there is no AI SDK, no model client, no prompt
plumbing in `apps/backend` or `apps/admin`. `[CODE — verified]` Everything below is therefore about
what a **deterministic** intelligence layer could say from persisted data.

### 13.1 Contextual Inspector — **fully supported, and mostly already built**

For a ticket **inside a run**, `GET /dispatch-runs/:runId/tickets/:ticketId/trace` returns: the winner
with coverage type, precedence rank, capacity at decision, planner bias, cluster seed, score, and tier
evaluated; up to five runners-up with verdicts and scores; pool-wide drop counts; `scoreDegenerate`;
`poolEmptyReason`; `notEnforcedFilters`; **`filterStates` per candidate**; **the full score breakdown**;
plus full ticket identity and every SE's display name. `[DOC — W§25.8; CODE — recommender.service.ts:893-936]`

**Two of those are served and unrendered (§11.3).** The inspector is not a new capability — it is a
finished component missing two sections.

### 13.2 Decision Assistant — supported per question, with named bounds

| Question | Answerable? | From | Bound |
|---|:--:|---|---|
| *Why is this ticket unassigned?* | **Yes** | `poolEmptyReason` (`NO_COVERAGE` \| `ALL_DROPPED`) + `dropCounts` + per-candidate verdicts | Only for tickets the engine **decided on**. Below-threshold work has *no recommendation, no row and no trace* — nothing to explain. |
| *Why was this engineer selected?* | **Yes, completely** | tier evaluated → precedence rank → score breakdown → pin bias | — |
| *Why not that engineer?* | **Yes** | `verdict` + `dropReason` + `filterStates` (all five, tri-state) | Only for the **top 5** runners-up. Candidates 7..N *were never stored* — this is not a UI gap. |
| *What alternatives exist right now?* | **Yes** | `GET /candidates?plantIds=` — the engine's own ordered eligibility, dropped included | No scores (the console is not placing one ticket) and no `TIER_NOT_REACHED`, deliberately. |
| *What happens if I move this?* | **Partly** | V2 for 3 of 6 actions: capacity both lanes, rank context, route effect, conflicts | Refused for remove/defer/reorder **on purpose**. |
| *What would the next run do?* | **Yes** | V1 — the real recommender, dry-run | D+1 and beyond ranks on **today's** severities; `bucketsAsOf` must be shown. |
| *Was a manager's pin ignored?* | **No** | — | **Never recorded.** A pinned SE dropped by a filter is silently skipped (**W-G6**). |
| *Which of the two `SE_UNAVAILABLE` causes?* | **No** | — | The trace collapses "on leave / off-window" and "deactivated". **Do not label it "on leave."** |
| *Who removed this ticket?* | **No** | — | `ticketsRemovedSince` is **deliberately unattributed**. |
| *Did the engineer get told?* | **No** | — | Outbox `attempts`/`lastError` exposed nowhere (**G-UI-14**). |

### 13.3 Operational Guide — **fully supported, and the strongest v1 Copilot**

Everything needed to say *"here is what needs you, in this order"* is already in one payload:

`situation.criticalNeedsYou` + `escalations[].insertionType` (which tells you **which door works**) ·
`recovery.state` + attempts + `lastError` · `rails.unassignable[].poolEmptyReason` · `situation.overCapacity` ·
`engineers[].availability` · zone `error` + `seSkips[]` · `configSnapshot.eligibilityMv.stale` ·
`build.staleBuild` · run `status` (`PARTIAL` with an empty `errors[]` is a real state) ·
`changes.counts`.

**And the ownership routing is already in the data model** (Fact 2, §2.5): unassignable → Ops;
component-blocked → Warehouse; bucketless → Engineering; withheld-below-threshold → nobody. A guide
that says *"3 things need Ops, 1 needs the Warehouse, and 140 are policy working correctly"* is
buildable today from existing fields. `[INFER, from CODE]`

### 13.4 Natural-language Copilot — nothing to build on, and not needed for v1

No LLM plumbing exists. `[CODE]` More importantly: **every question in §13.2 has a deterministic
answer already in a payload.** Natural language would be a different *input method* for answers the
console can simply render. The brief's own constraint — *"the core Scheduler Console must remain fully
usable without chat or AI"* — is not merely satisfiable, it is the cheaper build.

**Recommendation for discussion:** treat Copilot v1 as **Contextual Inspector + Operational Guide**,
both deterministic, both from data that already ships. Defer natural language entirely. `[INFER]`

### 13.5 The honesty constraint a Copilot must respect

The engine's first rule is *"never fabricate a default."* A Copilot is the **easiest place in the whole
product to break it**, because summarising is exactly the act of filling gaps. Specific traps, each
already documented:

- `SE_UNAVAILABLE` collapses two causes → never say "on leave".
- `plannerBias` compares against `passed[0]` (highest-precedence eligible), **not** the top-scoring
  candidate → it reads *"the pin differed from precedence"* and can over-report. Never say "the pin beat
  the score." `[DOC — W§18.4]`
- `TIER_NOT_REACHED` candidates have **no score**. Rendering `0.00` re-tells the exact lie `#266`
  removed.
- `NOT_ENFORCED` is not a pass. Two of five filters are permanently unenforced today.
- `scoreDegenerate` means **precedence, not the score, decided** — and the cause is the score *spread*,
  not distance. Naming distance would send an operator to a setting that is not the reason.
- `ticketsRemovedSince` has **no** attributed cause. Never say "withdrawn by".
- `null` `addSource` is **unknown provenance**, never a system decision. *"Drawing it solid would be the
  single lie this whole grammar exists to prevent."*

---

## 14. Constraints and Things We Must Not Invent

| # | Constraint | Source |
|---|---|---|
| C1 | **No approval gate, ever.** No Approve button, no countdown, no submit before a run. Inaction means the run proceeds. | `[DOC — UI§3.1]` |
| C2 | **A projection must never read as a commitment.** Conditional voice on preview; indicative on live and history. | `#280 R2` `[CODE]` |
| C3 | **No duplicate scheduler logic anywhere.** The console composes L4 reads; it never re-derives eligibility, ranking, scoring, capacity or conflict rules. | `#282 R5`, `#272 R9` `[CODE]` |
| C4 | **No placeholder, no fake data, no invented counters.** If data is unavailable, expose the smallest honest read or mark the element pending. | `#282 R6` `[CODE]` |
| C5 | **Never fabricate a default.** Four sentinels, four visual languages: `NOT_ENFORCED` / `NOT_AVAILABLE` / `NOT_RECORDED` / a real `0`. Never collapse them into one em-dash. | `[DOC — UI§25]` |
| C6 | **Capacity is visible, never a gate** on any manual path. | `#258 Q2`, `#272 R5` `[CODE]` |
| C7 | **Tier precedence is displayed and crossable by a human, never blocked.** No flat score-sorted candidate list. | `#258 Q1`, `#272 R6` `[CODE]` |
| C8 | **No map, no ETA, no route line, no live GPS.** Ordinal stops only. | `#258 Q6`, `#272 R7` `[CODE]` |
| C9 | **A human decision never looks like a system one.** The provenance grammar is binding; `addSource === null` is *unknown*. | `#282 R2` `[CODE]` |
| C10 | **The RBAC ladder must not widen.** `dispatch-run` stays OH+CSM; bulk-unassign stays OH; weights stay OH. | `#272`, `#282` `[CODE]` |
| C11 | **`DEFICIT`/`PREVENTIVE` never reach a user.** Map to "Catch-up"/"Steady". | `[DOC — UI§34.1]` |
| C12 | **The six funnel populations stay separate.** Never one "not dispatched" number. | `[DOC — W§1.3]` |
| C13 | **Per-item commit, per-item result.** No aggregate success toast over a partial write. | `#272 R8` `[CODE]` |
| C14 | **No websocket / SSE.** Polling only; stop when the tab is hidden. | `[DOC — UI§8.3]` |
| C15 | **No progress bar for a run.** Live indicator + elapsed only. | `[DOC — UI§8.2]` |
| C16 | **The draft is session-local for v1.** No table, no owner, no staleness rule. | `#272 Q2` `[CODE]` |

### Things we must NOT invent, specifically

- A **date picker on live data** — `GET /dispatch/today` has no date parameter.
- A **pan-India cockpit** — no aggregate read; the backend refuses to guess a zone.
- A **staleness badge on the scheduler preview** — the token has no verifier.
- A **retry-this-zone** or **cancel-this-run** control — no API.
- An **"approve the plan"** step.
- A **"hold expiring soon"** state — there is no expiry mechanism; the predicate simply stops excluding.
- An **atomic Commit-All** transaction.
- A **capacity page** — there is no capacity endpoint; `committed/dailyCapacity` rides on six reads.
- An **audit-log browser** — there is no audit-browse endpoint, and raw `audit_logs` rows are not an
  operator surface.
- **`TIER_NOT_REACHED` in the assign console** — deliberately excluded there because a human may cross
  tiers.

---

## 15. Preliminary Unified Scheduler Console Mental Model

### 15.1 The primary operational object, argued from code

The brief asks what the console's primary object is. **The code answers unambiguously: the (zone,
operating day) pair.**

- `dispatch_run_zones` is keyed on it; a zone claim is *"at most one RUNNING per zone globally"*.
- `dispatch_zone_recoveries` is *"one row per zone per operating day"*.
- Schedule closure, the work pool clamp, the cockpit read and the changes ledger all key on it.
- `GET /dispatch/today` refuses to serve anything else: *"'all zones' is not a cockpit, it is a
  different product."*

`[CODE]`

Within that object, the operator selects a **secondary** object: an **engineer** (a lane), a **ticket**
(a chip or a rail row), an **exception** (an escalation, a recovery state, a skip), or a **plant**
(the pool's unit). **Every contextual control in §8 B–E hangs off one of those four.** `[INFER]`

### 15.2 A layered model, validated against the implementation

The brief proposes Situation → Work → Decision → Change → Commit. Tested against the code, that model
**holds, with two corrections**:

| Layer | What it is here | Backing | Correction |
|---|---|---|---|
| **1 Situation** | The zone's operating day: run, recovery, 6 counters, escalations, MV/build health | `GET /dispatch/today` + `configSnapshot` | **Add a Health line distinct from the counters.** Recovery, stale MV and stale build are statements about *whether the day is intact*, not counts of work. `#286` already ruled the recovery notice sits **above** the deck, not in a rail. |
| **2 Work** | Two populations, not one: **committed** (lanes → stops → tickets) and **waiting** (rails + the pool) | `engineers[]` and `rails[]` / `assignable-work` | **These are different shapes and different scopes** (F5). Modelling them as one list would be a lie. |
| **3 Decision** | Why the engine did what it did | `trace`, `decisions`, `candidates` | **Split "historical why" from "live options".** The trace is immutable and run-keyed; `/candidates` is live and unbounded. They use two different vocabularies today (§21 Q9). |
| **4 Change** | Propose · preview (3 of 6) · gate on conflicts | override + assign + hold + escalation endpoints | — |
| **5 Commit** | Immediate, per item, with a per-item result | every mutation endpoint | **There is no fifth "review everything" step in the backend.** For assignments there *is* one (`ReviewCommitScreen`). For overrides there is not. |

### 15.3 The model in one diagram

```
                    ┌───────────────────────────────────────────────┐
  GLOBAL CONTEXT    │  ZONE  ·  today  ·  run badge  ·  [Run dispatch]│  (A)
                    └───────────────────────────────────────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
  ┌───────────┐              ┌──────────────────┐            ┌──────────────┐
  │ SITUATION │              │  WORK            │            │  HEALTH      │
  │ 6 counters│              │  committed lanes │            │  recovery    │
  │           │              │  + waiting rails │            │  stale MV    │
  │           │              │  + the pool      │            │  stale build │
  └───────────┘              └────────┬─────────┘            │  seSkips     │
                                      │                      └──────────────┘
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
              ┌──────────┐      ┌──────────┐      ┌───────────┐
              │ ENGINEER │      │  TICKET  │      │ EXCEPTION │      (B/C/E)
              │ selected │      │ selected │      │ selected  │
              └────┬─────┘      └────┬─────┘      └─────┬─────┘
                   │                 │                  │
                   ▼                 ▼                  ▼
              ┌──────────────────────────────────────────────┐
              │  DECISION   why · alternatives · candidates   │      (F)
              └──────────────────────┬───────────────────────┘
                                     ▼
              ┌──────────────────────────────────────────────┐
              │  CHANGE     propose → preview (3 of 6)        │      (B/C/D)
              │             → conflict gates → COMMIT (each)  │
              └──────────────────────┬───────────────────────┘
                                     ▼
              ┌──────────────────────────────────────────────┐
              │  RESULT     per-item outcome → Changes ledger │
              └──────────────────────────────────────────────┘

  OUTSIDE THE CONSOLE, REACHABLE FROM IT:
    Scheduler Preview (a different day)  ·  Dispatch Runs ledger (a different object)
    SE Planner (dates × plants)          ·  Bulk Unassign (OH)  ·  Settings (OH)
```

---

## 16. Candidate Information Architecture — For Discussion Only

**Three options. None is recommended as final; each is stated with its cost so the discussion has real
alternatives rather than one proposal to rubber-stamp.**

### Option 1 — "Commandable cockpit" (smallest change; no ruling overturned)

Keep every route. Make `/dispatch/today` **commandable** by wiring the contextual controls that its
payload already supports (§6 F1) — overrides, impact preview, assign, hold, release, candidates,
escalation resolve — plus the zone picker (F3) and the run trigger (F2).

- **Overturns:** nothing. `#280 R2` is respected (no page is merged); `#280 R7` is respected
  (`/assign` untouched).
- **Backend work:** zero.
- **Gets:** the single biggest fragmentation win (§6 F1) and fixes the two role-blocking defects.
- **Does not get:** one workspace for hand-out-work. `/assign` remains a separate destination.
- **Risk:** `/schedules/:engineerId` becomes partly redundant — two places to override.

### Option 2 — "Scheduler Console" (the brief's direction; overturns `#280 R7`)

One route, e.g. `/scheduler`, with a persistent global context bar (zone · today · run) and a work area
that switches between **Plan · Live · Replay · Assign**, sharing the same engineer lanes and the same
selection model, with contextual controls in a right inspector.

- **Overturns:** `#280 R7` (assign merges in) and, if Plan is a *pane* rather than a link, `#280 R2`.
- **Backend work:** zero to start; the scope mismatch (F5) and acting-zone inconsistency (F6) become
  visible bugs that need fixing.
- **Gets:** the brief's stated goal — understand → identify → select → why → options → change → impact →
  commit without leaving.
- **Cost / risk:** the **mixed-commitment problem** (§7.3) — draft chips and committed chips in one
  lane. This is the design's central hazard and must be solved explicitly, not by styling.

### Option 3 — "Console + archive" (Option 2, plus a deliberate reduction)

Option 2, and the four "tense rows" collapse to **two** nav entries: **Scheduler Console** and
**Dispatch Runs** (the archival spine). Scheduler Preview becomes the console's Plan mode; Schedules
becomes the console's Live lanes; Intra-day retires (after relocating its escalation modal).

- **Overturns:** `#280 R2` and `R7` both, explicitly.
- **This is what the forensics report's §J actually recommends.** `[CODE]`
- **Gets:** the sidebar finally ranks the nouns by removing three of them.
- **Cost:** Scheduler Preview is **date-addressable for any IST day** and the console is **today-only**.
  Folding it in either loses the date range or requires a mode that changes what "today" means on
  screen — the precise confusion `#280 R2` warns about. **This is the sharpest unresolved tension in
  the whole design.**

### Comparison

| | Opt 1 | Opt 2 | Opt 3 |
|---|:--:|:--:|:--:|
| Rulings overturned | none | R7 (+R2 if Plan is a pane) | R2 + R7 |
| Backend work to start | none | none | none |
| Fixes F1 (situation ≠ actions) | ✓ | ✓ | ✓ |
| Fixes F2 / F3 (blocked roles, wrong page) | ✓ | ✓ | ✓ |
| Fixes F5 / F6 (scope mismatches) | n/a | **must** | **must** |
| One workspace for hand-out-work | ✗ | ✓ | ✓ |
| Sidebar noun count reduced | ✗ | ✗ | ✓ |
| Mixed-commitment hazard | none | **high** | **high** |
| Projection-reads-as-commitment hazard | none | medium | **high** |
| Reversible | ✓ | partly | **hard** |

---

## 17. Features That Could Be Absorbed Into the Console

| Feature | Absorbable as | Cost | Confidence |
|---|---|---|---|
| **All six override actions** (`/schedules/:engineerId`) | contextual controls on a lane / stop / chip | **zero backend** — ids already in the payload | `[CODE]` **high** |
| **Override impact preview** | a panel inside the override dialog (already is one) | zero | `[CODE]` high |
| **Candidate column** | a right-inspector pane keyed on the selected plant | zero — `plantId` in payload | `[CODE]` high |
| **Decision trace** | already inline in Replay; extend to any chip | zero — but needs a `runId` (F7) | `[CODE]` high |
| **Escalation resolve + available-SEs modal** | the interception strip's action | zero — `insertionId` in payload | `[CODE]` high |
| **Holds place / release** | a rail-row action | zero — `ticketId` in payload | `[CODE]` high |
| **Run dispatch + in-flight** | header action (CSM/OH) | zero — **already approved by `#282 R1`** | `[CODE]` high |
| **Schedules list** (`/schedules`) | the console's lanes *are* this, for one zone | must pass `?date=`; list also spans zones | `[INFER]` medium |
| **Zone detail** (per-run) | already a run-scoped card; the live twin is the console | none — they are different questions | `[DOC]` high |
| **Work pool + distribute + assign-batch** | a fourth mode, or a left rail | **zero backend, high design risk** (§7.3) | `[OPEN]` |
| **Intra-day Queue** | its escalation modal absorbs; its ledger is already replaced | zero | `[CODE]` high |
| **Score breakdown + filter states** | sections in the existing trace panel | zero backend — **client type only** | `[CODE]` high |

---

## 18. Features That May Remain Supporting / Historical / Diagnostic

| Feature | Why it stays out | Confidence |
|---|---|---|
| **Dispatch Runs → Run → Zone → Batch** | Evidence is immutable and separately addressable; a run is its own object with its own lifetime; deep links must survive | `[DOC — UI§37.1]` high |
| **Scheduler Preview** | **Date-addressable for any IST day**, all zones in scope, and must never read as a commitment. The console is today-only and zone-only. | `[CODE]` high |
| **SE Planner** | A grid over **dates × plants**, affecting the **next** run. Not a today object. | `[CODE]` high |
| **Bulk Unassign** | OH-only rebalance with its own verified-token flow and pan-India scope | `[CODE]` high |
| **Settings / weights / threshold / cron** | Changing the engine's tuning is not operating it. The console shows what *was* frozen; settings changes what *will be*. | `[DOC]` high |
| **Ticket drawer** | Owned by `/tickets`; the scheduler contributes fields to it, not the reverse | `[DOC — UI§12]` high |
| **Cross-zone escalation, tier overrides, component requests, verification** | Adjacent modules the scheduler links to but does not own | `[DOC — UI§1.2]` high |
| **Build Health, Ops Explorer, Exports** | Platform diagnostics, not scheduler operation | `[CODE]` high |

---

## 19. Backend Gaps That Affect the Console Vision

Ranked by whether they **block a correct console**, using the walkthrough's and UI spec's gap ids where
they exist.

### 19.1 Blocking — the console would have to lie or omit

| # | Gap | Consequence | Fix shape |
|---|---|---|---|
| **B1** (G-UI-2) | `componentBlockedWithheld` and `bucketlessDropped` are **not on `GET /dispatch/today`** | Two of six funnel populations invisible on the primary screen. Scraping them from the run detail mixes per-run with per-day figures. | add both to `TodaySituation` |
| **B2** (G-UI-3) | A ZM cannot see `nextFireAt` or in-flight state | The ZM's own primary screen cannot explain an empty deck at 04:55, and cannot infer 05:00 because the hour is configurable | read-only `GET /schedules/dispatch-schedule/next` for `MANAGER_ROLES`; widen in-flight, zone-clamped |
| **B3** (F6 / `#239`) | Acting-zone honoured on 10 of 20 `/schedules` routes | **Two panes on one console silently scoped differently.** Tolerable across pages; a correctness bug on one screen. | finish the `#239` sweep |
| **B4** (F5) | Work pool is pan-India for CSM/OH; the cockpit demands one zone | A merged console shows a global pool beside a single-zone deck; the counts will not reconcile | decide the console's scope rule, then align one read to it |

### 19.2 Significant — the console works but is thinner

| # | Gap | Consequence |
|---|---|---|
| **S1** (G-UI-1 / W-G1) | `checkStaleness` implemented, **no route** | A preview cannot say it went stale. The SDS says it can. |
| **S2** (G-UI-4 / W-G4) | `bucketsAsOf` computed on every run, returned only on a dry run | A real run cannot state its own data staleness while its preview can |
| **S3** (G-UI-5) | No `GET /tickets/:id/decision` | "Why is this here?" is unanswerable without first finding the run (F7) |
| **S4** (G-UI-7 / W-G9) | `heartbeat_at` on neither run DTO | Cannot distinguish "alive" from "about to be reaped" |
| **S5** (G-UI-8) | `changes-today.actorId` is a bare UUID; managers have no name lookup | The operator-facing audit shows UUIDs for the person who acted |
| **S6** (G-UI-17) | `assignment_threshold_hours` **persisted on `dispatch_run_zones`, absent from the DTO** | `recommended: 40` out of a 900 backlog is un-interpretable — a catastrophe at 24 h, correct at 72 h |
| **S7** (G-UI-9 / W-G7) | `filterStates` absent from `/candidates` | **Two vocabularies for one engine**: the console shows one drop reason, the trace shows five tri-state verdicts |

### 19.3 Would be needed only for the more ambitious console

| # | Gap | Needed for |
|---|---|---|
| **A1** | A fleet-wide scheduler aggregate (W-G2) | Any pan-India console view |
| **A2** | A change-set / multi-action commit construct | An honest "Commit all changes" |
| **A3** | A staleness verifier for the override impact preview | A draft basket of previewed overrides |
| **A4** | A date parameter on the cockpit read | "Yesterday's console" |
| **A5** | `plannerPinnedButDropped[]` on the trace (W-G6) | Copilot answering "was my pin ignored?" |
| **A6** | Outbox delivery state (G-UI-14) | Copilot answering "did the engineer get told?" |
| **A7** | An audit-browse endpoint (G-UI-6 / W-G8) | "Every override in this zone this week" |

### 19.4 Non-gaps that look like gaps

| Looks like a gap | Actually |
|---|---|
| `policyWithheld.itemised: false` | **A contract.** Those tickets get no recommendation, no row and no trace — there is nothing to list. |
| `conflicts.onSite` reads empty | The soft-state feed is a **seam**; build the path, expect it not to fire yet. |
| `VEHICLE_ON_TRIP` / `COMPONENT_UNAVAILABLE` always `NOT_ENFORCED` | Two unbuilt integrations, honestly recorded rather than defaulted to "pass". |
| `NOT_PROJECTABLE` on 3 override actions | A **deliberate refusal**. Zeros would read as "this move costs nothing". |
| Candidates 7..N missing from a trace | **Never stored.** `TRACE_RUNNERS_UP = 5`. |
| `ticketsRemovedSince` has no cause | **Deliberately unattributed.** |
| `GET /org/zones` "missing" | **It exists** and is roled for exactly CSM+OH (§4.1 R30). |

---

## 20. Important Design Decisions Still Open

These are design calls, distinct from the questions in §21. Each is `[OPEN]`.

| # | Decision | Why it is not obvious |
|---|---|---|
| D1 | **Where does the projection live?** A link out (today), a mode inside the console, or a pane beside live data | A pane makes the console complete and risks the exact `#280 R2` error |
| D2 | **Does `/schedules/:engineerId` survive** once lanes are commandable? | Two override surfaces is worse than one; but a single engineer's *whole* route across zones is a real view a zone lane cannot show |
| D3 | **Does the console own a draft basket for overrides**, or only for assignments? | Assignments already have one (`assign-batch`). Overrides commit individually by ruling (`#272 R8`), and `REORDER` is not composable. |
| D4 | **What is the console's scope rule for CSM/OH** — one zone always, or a zone selector with a pan-India summary above? | The backend refuses "all zones" for the cockpit but happily serves a pan-India pool |
| D5 | **How much technical explainability is default-visible?** | `#266`'s scores and `#270`'s tri-state filters are correct and dense. The UI spec asks (Q5) whether the breakdown opens by default. |
| D6 | **Does the Replay mode stay in the console, or move under the runs ledger?** | It is *today's* run — a live concern — but it is also immutable evidence |
| D7 | **What replaces `/intraday` for the escalation modal** before the route retires? | The modal is live and useful; the ledger it sits beside is dead |
| D8 | **Is the console a new route or the existing `/dispatch/today` grown?** | A new route abandons deep links, existing tests and operator habit; growing the existing one constrains the name |

---

## 21. Questions for Product / UX Discussion — *Decisions We Need to Make Together*

**These are not answered here.** They are the real decisions, derived from the implementation.

### The two that gate everything else

**Q1 — Do we overturn `#280 R2` ("grouping and cross-linking, not merging")?**
R2 reserved this decision for the operator, on evidence, and warned that *"merging is irreversible in
the operator's mental model, while grouping is not."* The evidence now exists (three audits, one
forensic report, this document). **Nothing else in this list can be settled until this is.**

**Q2 — Do we overturn `#280 R7` (`/assign` stays separate from the dispatch timeline)?**
R7 has been reaffirmed twice since it was made. Merging it delivers the brief's stated goal and creates
the **mixed-commitment hazard** (§7.3): a draft chip that writes nothing and a committed chip whose move
writes immediately, in the same lane, under a grammar that forbids one shape meaning two things. If we
merge, **how do we make "not yet written" visually unmistakable?** If we do not, the console is
Option 1.

### Operating model

**Q3 — What does the user see first when opening the console?**
A ZM has one zone and lands on it. A CSM/OH has no honest default — the backend refuses to guess. Do
they land on a zone picker, a remembered zone, or a cross-zone summary that **does not exist yet**
(A1)?

**Q4 — Is the console exception-driven or plan-driven?**
Both readings are supported by the same payload. Exception-driven means the escalations, recovery and
unassignable rails lead and the deck follows. Plan-driven means the deck leads. The current cockpit is
plan-driven with rails aside. `#286` already ruled recovery sits **above** the deck, which is a partial
answer.

**Q5 — Is the primary object the zone-day, the engineer, or the exception?**
The code says **zone-day** (§15.1). The brief's workflow implies the *selection* is the ticket or the
engineer. Confirming this ranks every control in §8.

**Q6 — Separate Live / Draft / Preview modes, or one surface with state?**
The current cockpit already has `?mode=plan|live|replay`. Adding a Draft mode is cheap. Making draft a
*state overlaid on live* is what creates the hazard in Q2.

### Change and commit

**Q7 — Should multiple changes accumulate before commit, and if so which ones?**
Assignments already accumulate (`assign-batch`, per-lane transactions). Overrides do not, by ruling.
**A basket is buildable only as "commits individually, reports individually."** Do we want that, given
it widens the lost-race window (§12.2 Finding 5)?

**Q8 — Which mutations must remain immediate, no matter what?**
Candidates for "always immediate": `REORDER` (not composable), escalation resolve (time-critical),
`Run dispatch` (it is the engine), hold release (trivially reversible).

**Q9 — Do we unify the two candidate vocabularies?**
`/candidates` says `PASSED`/`DROPPED`. The trace says `PASSED`/`DROPPED`/`TIER_NOT_REACHED`. On separate
pages that is defensible (`#272 R6`: a human may cross tiers, so a never-reached tier is not a
rejection). **On one console they sit side by side.** `[UI spec Q6 raised this; still open]`

### Roles and surfacing

**Q10 — How do the three roles differ inside one console?**
Hide vs disable is settled as a rule (`UI§4.4`) but not applied. **Specifically: what does a ZM see
where "Run dispatch" would be?** Nothing, a disabled control with a reason, or a "request a run"
affordance that does not exist?

**Q11 — Which controls are always visible, and which appear contextually?**
Proposed for discussion: **always** — zone, date label, run badge, refresh, the 6 counters, the health
line. **Contextual** — every one of §8 B/C/D/E.

**Q12 — How much explainability is default-open?**
The score breakdown is six rows of arithmetic. `#266` made scores decisive; `#270` made filters
tri-state. Collapsed is calmer; open is more explanatory on the screen whose whole purpose is
explanation. **Recommendation for discussion:** collapsed by default, **auto-open when
`scoreDegenerate` is false and the operator opened the panel deliberately**, always collapsed when
degenerate (the numbers are true but did not decide).

**Q13 — What is Copilot in version one?**
§13 argues: **Contextual Inspector + Operational Guide, both deterministic, both from data that already
ships**; natural language deferred entirely. **Is that the shared understanding?**

**Q14 — Do we fix the four blocking backend gaps (B1–B4) before or alongside the console?**
B3 and B4 in particular change from "confusing" to "incorrect" the moment two panes share a screen.

**Q15 — What happens to `/schedules/:engineerId`, `/schedules`, `/intraday` and `/schedules/preview`
as routes?** Retire, redirect, or keep as deep-link targets? Each has tests, nav entries, cross-links
(`#281`) and operator habit behind it.

---

## 22. Claude's Recommended Discussion Starting Point

**Start with Q1 and Q2, in that order, and settle nothing else until both are answered.** Every other
decision in §20 and §21 is downstream of them, and both are operator calls that no amount of further
code reading can resolve.

**Then, whatever the answer, do Option 1's work first.**

The reason is not caution — it is that Option 1's work is **required by all three options, needs zero
backend change, and overturns no ruling**:

1. **F3 — the zone picker.** Two of three roles cannot open the primary screen. `GET /org/zones` already
   exists. *(Hours.)*
2. **F2 — the run trigger.** Move it from an OH-only rebalance page to the cockpit. `#282 R1` already
   approved this; `#285` shipped without it. *(Hours.)*
3. **F1 — make the lanes commandable.** Wire the six overrides, the impact preview, assign, hold,
   release, candidates and escalation-resolve onto the ids **already in the cockpit payload**. This is
   the largest single reduction in navigation cost available and it is a composition task, not a design
   task. *(Days.)*
4. **F4 — render the score breakdown and the per-candidate filter states.** The engine's own arithmetic
   is persisted, served, and thrown away by two client type definitions. *(Hours.)*

**After that, the console question becomes empirically answerable rather than architecturally
speculative** — because the cockpit will *be* the console for everything except handing out work, and
the only remaining question is Q2: does the work pool come inside, and if so, how does a draft chip
avoid looking like a committed one?

**Three specific things to bring to the discussion:**

1. **The scope decision (Q3/D4) is the hidden hard one.** "One console" is a promise about a screen; the
   backend has already ruled that "all zones is not a cockpit, it is a different product." A CSM's first
   moment in the console is a zone picker, or it is a fleet view that does not exist.
2. **The mixed-commitment problem (Q2) is the hidden hazard.** The shared visual grammar's own first
   rule is "never the same shape for two meanings." A merged console puts uncommitted and committed work
   in the same lane. This needs a deliberate answer, not a styling decision made during implementation.
3. **"Commit all changes" should not appear in any wireframe until Q7 is settled.** There is no backend
   construct for it, and the product has already ruled that multi-item commits report per item and that
   partial success is normal. A bar that says "Commit 7 changes" would be the first promise in this
   product the engine cannot keep.

---

## Appendix A — Contradictions found, stated not reconciled

| # | Between | The contradiction | Resolution per authority order |
|---|---|---|---|
| X1 | **SDS ↔ code** | The SDS documents preview staleness as working: *"Re-submit the token and the system answers FRESH or STALE."* `checkStaleness` is implemented; **no route reaches it.** | **Code wins.** The capability does not exist. Do not build UI on it. `[CODE]` |
| X2 | **UI spec ↔ code** | UI§7.1 / G-UI-16: *"no zone-list endpoint"*, proposing a workaround. `GET /api/org/zones` exists, roled CSM+OH. | **Code wins.** The workaround is unnecessary. `[CODE]` |
| X3 | **`#282 R1` ↔ code** | `#282 R1` lists Run-dispatch relocation as `#285` scope; `#285` is marked DONE; the button still navigates to `/bulk-unassign`. | **Code wins.** A delivery gap against an approved ruling. `[CODE]` |
| X4 | **`#280 R2`/`R7` ↔ this task's direction** | Two live rulings forbid merging; the task asks us to explore merging. | **Neither wins automatically.** R2 reserves the decision for the operator; R7 does not. Both must be settled — §21 Q1/Q2. |
| X5 | **`nav.ts` ↔ UI spec** | UI§5.4 says retire `/intraday`; the nav still lists it with the hint *"Changes to today's plan"*, which it structurally cannot show. | **Code is current state; the spec is a proposal.** Note the modal that must be relocated first (§6 F8). |
| X6 | **Walkthrough ↔ UI spec on gap count** | W lists 16 gaps (G1–G16); UI lists 17 (G-UI-1–17), overlapping but not identical, with different priorities. | Not a contradiction — different lenses. §19 merges them by *blocking-ness*, not by id. |

## Appendix B — Minor findings outside console scope

| Finding | Evidence |
|---|---|
| `MANUAL_BATCH_ASSIGN` is written as an audit action by `assignLane` but is read by **no report** — the Assign Console's own commits are invisible to the ZM scorecard's manual-intervention counters, which read `CRITICAL_ASSIGN`, `MANUAL_ZM_UPDATE` and `BATCH_OVERRIDE_*`. | `[CODE — override.service.ts:682; zm-performance-aggregation.service.ts:15-23; grep shows no reader]` |
| Report cubes bucket by **UTC day**; scheduling buckets by **IST day**. A report figure and a dispatch figure "for the same day" cover different 24-hour windows. Not fixable in the UI, but a dashboard must not imply they are the same day. | `[DOC — W§6.1]` |
| Only 5 of 12 scheduler-relevant cron jobs pin `timeZone`. The dispatch family and closure do; the eight `BusinessSweepScheduler` jobs do not. Three of those are wall-clock-meaningful. | `[DOC — W§6.1]` |

---

*End of discussion document. Nothing here was implemented; nothing here is final.*
