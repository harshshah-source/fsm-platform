# Scheduler Engine — Frontend UI Specification

> Derived from the actual backend implementation and from the **6,712 lines of scheduler UI that
> already exist** in `apps/admin`. This is not a greenfield design. It states what is built and
> correct, what is built and wrong, and what is missing — so a frontend engineer can implement the
> remainder without asking the backend engineer what any number, state, action or endpoint means.
>
> **Companion document:** `docs/audits/scheduler-engine-technical-walkthrough.md` (5,474 lines).
> Section references of the form *W§n* point into it.
>
> **Date:** 2026-08-26 · **Branch:** `feat/autoplant-integration`

---

## 1. Purpose and Scope

### 1.1 What this covers

The operator-facing surfaces of the Scheduler/Dispatch Engine: the daily run, the projection of the
next run, the committed day plans, manual assignment and override, holds, distribution, the decision
evidence, and the failure/recovery states. Roles: `ZONAL_MANAGER`, `CENTRAL_SERVICE_MANAGER`,
`OPERATIONS_HEAD`.

### 1.2 What this does not cover

- The **SE mobile app** (`GET /api/schedules/me`, `GET /api/me/shared-pool`) — a different product.
- **Cross-zone escalation**, **tier overrides**, **component requests**, **verification** — adjacent
  modules with their own surfaces that the scheduler links to but does not own.
- Anything requiring a backend change. Gaps are named in §35; none is designed around silently.

### 1.3 The starting position — this is a brownfield spec

| Surface | Route | State |
|---|---|---|
| Today's Dispatch (Plan/Live/Replay) | `/dispatch/today` | **built**, 553 lines, 3 modes, tested |
| Assign Work Console | `/assign` | **built**, 1,037 lines + 4 sub-components |
| Scheduler Preview | `/schedules/preview` | **built**, 493 lines |
| Schedules list | `/schedules` | **built**, 274 lines |
| Schedule Detail (**the override surface**) | `/schedules/:engineerId` | **built**, 591 lines, all 6 actions + impact panel |
| Dispatch Runs ledger | `/dispatch-runs` | **built**, 89 lines |
| Run Detail | `/dispatch-runs/:runId` | **built**, 195 lines + ConfigInEffectPanel |
| Zone Detail (run-scoped) | `/dispatch-runs/:runId/zones/:zoneId` | **built**, 93 lines + 2 tables |
| Batch Detail | `/batches/:batchId` | **built**, 258 lines |
| Intra-day Queue | `/intraday` | **built, structurally blind — retire (§5.4)** |
| SE Planner | `/engineers/planner` | **built**, 288 lines |
| Bulk Unassign | `/bulk-unassign` | **built** (OH) |
| Dispatch schedule config | `/settings` | **built** (OH) |

24 admin tests already pin scheduler behaviour. **The correct output of this spec is therefore
mostly: confirm, correct four defects, fill six gaps — not rebuild.**

### 1.4 The six defects found while deriving this

Each is evidenced in place below; collected here so they are not lost in the detail.

| # | Defect | Evidence | Severity |
|---|---|---|---|
| **F1** | A CSM/OH opening `/dispatch/today` from the sidebar gets an **unrecoverable error**. The page has no zone picker; the backend 400s `ZONE_REQUIRED` for a multi-zone role with no `?zoneId`. The "Try again" button re-issues the identical failing request. | `TodaysDispatchPage.tsx:48`; `dispatch-today.controller.ts:54-58`; the behaviour is *tested as an error state* at `test/todays-dispatch.test.tsx:372-378` | **High** |
| **F2** | Plan mode's **"Run dispatch" button navigates to `/bulk-unassign`**. There is no dispatch trigger on any scheduler screen; the only caller of `POST /schedules/dispatch-run` in the whole admin app is `api/bulkUnassign.ts:136`. | `TodaysDispatchPage.tsx:424-426` | **High** |
| **F3** | The **score breakdown is never rendered**. The backend persists `trace.chosen.breakdown` (6 components + weights + baseScore + clusterMultiplier); the client type omits it and no component reads it. | `api/dispatch-runs.ts:233-246` vs `recommender.service.ts:896-897` | **High** |
| **F4** | **Per-candidate `filterStates` are never rendered.** #270 persists a tri-state verdict for all 5 filters on the chosen row and every runner-up; the client type omits it. The UI shows only trace-level `notEnforcedFilters`. | `api/dispatch-runs.ts:219-259` vs `recommender.service.ts:727,903,924` | **Medium** |
| **F5** | `PlanMode` links to `/schedules/preview?zoneId=…`; the preview page **reads `date` and `se`, never `zoneId`**, and the endpoint takes no zone parameter (scope is server-side). The param is inert. | `TodaysDispatchPage.tsx:421` vs `SchedulerPreviewPage.tsx:83-84` | Low |
| **F6** | `DecisionTrace.tsx`'s docstring still says *"no numeric score is shown"*; the component has shown scores since #266. Stale guidance for the next editor. | `DecisionTrace.tsx:9-11` vs `:56-58` | Low |

---

## 2. Source of Truth

```
CODE  ──►  scheduler-engine-technical-walkthrough.md  ──►  sds.pdf
```

Every claim below is traced to one of:
- **backend** — `apps/backend/src/...` with function and line;
- **frontend** — `apps/admin/src/...` with line;
- **W§n** — the walkthrough section that already established it.

**Where the three disagree, the disagreement is marked, never reconciled.** Three such marks exist in
this document: F3/F4 (backend richer than UI), §17.1 (SDS describes a capability with no endpoint),
and §11.4 (walkthrough G15 — two definitions of "return due today").

**`NOT AVAILABLE FROM CURRENT API`** is used verbatim wherever a UI need has no backend answer.

---

## 3. Scheduler Product Mental Model

### 3.1 The one sentence

> At 05:00 IST a program decides which engineer drives to which plant, in what order, and why. A
> manager cannot approve it, cannot block it, and can change anything afterwards.

Three consequences the UI must carry everywhere:

1. **There is no approval gate.** Inaction means the run proceeds. No screen may show an Approve
   button, a countdown, or a submit step before a run. *(`scheduler-preview.service.ts:14-29`)*
2. **The only pre-run lever is a hold** — a date on a ticket. *(W§33)*
3. **Every correction is post-hoc and immediate.** Overrides commit at once, demand a reason, and
   push to the engineer. *(`override.service.ts:132-137`)*

### 3.2 The four tenses — and why the nav is shaped as it is

The engine is one concept read at four points in time. This is already the nav's stated rationale
(`components/shell/nav.ts`, `DISPATCH_HEADING`), and it is correct:

| Tense | Question | Surface |
|---|---|---|
| **Future** | What *would* the next run do? | Scheduler Preview — a **projection**, never a commitment |
| **Present** | What is happening now? | Today's Dispatch — the cockpit |
| **Recent past** | What changed since dispatch? | Today's Dispatch → Changes rail |
| **History** | What did past runs do, and why? | Dispatch Runs → Run → Zone → Batch → Trace |

**The constraint that governs all copy:** *a projection must never read as a commitment*
(nav.ts, #280 R2). Preview screens use conditional voice ("would", "projected"); Live and History use
past/present indicative.

### 3.3 The engine's own four rules — which are UI rules

From the SDS §10, each verified in code (W§40.1):

1. **Never fabricate a default.** `NOT_ENFORCED` ≠ passed. `NOT_AVAILABLE` ≠ 0. `null` rank ≠
   unranked. `null` provenance ≠ system. → the rendering contract in **§25**.
2. **One rule, one implementation.** The engine's answer *is* the console's answer. → **§33**: what
   the frontend must never recompute.
3. **Contain the blast radius.** A zone fails, not a run; an engineer fails, not a zone. → the UI
   must show partial success as partial, never as failure. **§22**.
4. **Degrade loudly.** A stale eligibility map does not block dispatch — it is recorded. → **§24**.

### 3.4 The distinction the UI most often gets wrong

**`recommended + unassignable` is not the funnel.** Four further populations sit outside it, each
sending a different team (W§1.3). Merging them makes a healthy system look broken:

```
tickets in the zone
   ├─ recommended                  → placed on a plan
   ├─ unassignable                 → OPS: nobody could take it
   ├─ withheldBelowThreshold       → NOBODY: policy working
   ├─ componentBlockedWithheld     → WAREHOUSE: part on order
   ├─ bucketlessDropped            → ENGINEERING: no ranking data
   ├─ deferred / held              → nobody: a decision already taken   [no run-level count]
   ├─ plant deactivated            → nobody                            [no count anywhere]
   └─ device departed              → nobody                            [no count anywhere]
```

The last three have **no counter in the backend** (W§40.2 D2). §8.3 states exactly what may and may
not be displayed.

---

## 4. Users and Permissions

### 4.1 The role model, from code

`MANAGER_ROLES = ['ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD']` — declared
identically in six controllers. `RoleRoute` (`auth/RoleRoute.tsx`) gates client-side; every route is
gated server-side regardless.

| Capability | ZM | CSM | OH | Backend gate |
|---|:--:|:--:|:--:|---|
| Today's Dispatch, Preview, Schedules, Runs, Assign, Planner, Candidates, Distribute | ✓ | ✓ | ✓ | `@Roles(...MANAGER_ROLES)` |
| Override a batch (6 actions) + preview impact | ✓ | ✓ | ✓ | `batches.controller.ts:72,100` |
| Place / release a hold | ✓ | ✓ | ✓ | `schedules.controller.ts:306,341` |
| Intraday manual-assign | ✓ | ✓ | ✓ | `intraday-insertion.controller.ts` |
| **Trigger a dispatch run** | ✗ | ✓ | ✓ | `@Roles('OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER')` `:192` |
| **See in-flight zones** | ✗ | ✓ | ✓ | `:228` |
| **See / edit the dispatch schedule** | ✗ | ✗ | ✓ | `@Roles('OPERATIONS_HEAD')` `:164,170` |
| Bulk unassign + its history | ✗ | ✗ | ✓ | `:240,266` |
| Scoring weights | ✗ | ✗ | ✓ | `scoring-weights.controller.ts:17` |
| SE assignment threshold | ✗ | ✓ | ✓ | `/settings/assignment-threshold` |

### 4.2 Zone scope

- **ZM** — clamped to their own zone at **every** read, server-side. The UI must not offer a zone
  selector to a ZM, and must not filter client-side for security.
- **CSM / OH** — global. **They must be given a zone selector** on the two single-zone surfaces
  (`/dispatch/today`, `/dispatch/changes-today`), because the backend refuses to guess:
  `400 ZONE_REQUIRED`, *"there is no honest default — 'all zones' is not a cockpit, it is a different
  product"* (`dispatch-today.controller.ts:51-58`). **This is defect F1.**

### 4.3 Acting-zone — and its live inconsistency

`X-Acting-As-Zone` collapses an acting CSM/OH into `{role:'ZONAL_MANAGER', zoneId: actingZone}`
(`schedules.controller.ts:79-83`). It is honoured on **10 of 20** `/schedules` routes and **not** on
`preview`, `list`, `engineers` or `:engineerId` (W§24.1).

> **An Operations Head acting in a zone sees that zone's work pool but a pan-India preview.**

`#239` owns the sweep. **UI rule until it lands:** when an acting zone is set, render a persistent
banner on Scheduler Preview, Schedules and Schedule Detail stating that these four reads are **not**
acting-scoped. Do not attempt to filter client-side — that would fork the scope model, which is
exactly what §33 forbids.

*(The app already has an acting banner — `test/acting-banner.test.tsx` — so this is a copy change on
an existing component, not a new one.)*

### 4.4 Hide vs. disable — the decision rule

| Situation | Treatment | Why |
|---|---|---|
| Role lacks the route entirely (ZM → Bulk Unassign) | **hide** the nav item | `buildNav` already does this |
| Role lacks one action on a page they can see (ZM → Run dispatch) | **hide** the button | showing a permanently-disabled control teaches nothing |
| Action exists but is invalid *right now* (Run dispatch while a run holds the zone) | **disable with the reason** | the state is recoverable and the reason is actionable — `GET /schedules/dispatch-run/in-flight` exists precisely so this can be shown *before* the click (`:219-225`) |
| Action would conflict and needs confirm (ON_SITE, deferred) | **enable**; let the 409 drive a confirm dialog | both gates are confirm-and-reason, not refusals (W§32.2) |
| Engineer is over capacity on a **manual** path | **enable**, mark it | overload is an administrative right (§11.3) |

---

## 5. Recommended Information Architecture

### 5.1 The decision

**Keep the existing `Dispatch` cluster. Make four changes. Retire one page.**

The current grouping is not accidental — `nav.ts` carries its reasoning (#280 R1/R8/R9, #281, #285)
and it is right: four tenses of one concept, ranked, with the cockpit primary. Nothing in the backend
justifies re-cutting it.

### 5.2 Final navigation

```
Operations
  ├── Zone Dashboard              /
  ├── Tickets                     /tickets
  ├── Assign Work            ◄────/assign          the work pool + candidate column + commit
  ├── Create Install              /install
  ├── SE Activity                 /engineers
  ├── Manage SEs                  /engineers/manage
  ├── SE Planner             ◄────/engineers/planner   the pin the engine reads as a soft bias
  └── … (verification, readiness, cross-zone, …)

Dispatch                                            ◄── the scheduler cluster
  ├── Today's Dispatch            /dispatch/today   PRIMARY — Plan | Live | Replay
  │     "What is happening now"
  ├──   Scheduler Preview         /schedules/preview
  │     "What the next run would do"
  ├──   Schedules                 /schedules   →  /schedules/:engineerId   ◄── the override surface
  │     "Committed day plans"
  └──   Dispatch Runs             /dispatch-runs → /:runId → /zones/:zoneId → /batches/:id
        "What past runs did"

Policy   (CSM + OH)
  └── SE Assignment Threshold     /assignment-threshold

Admin    (OH only)
  ├── Bulk Unassign               /bulk-unassign
  └── Settings → Dispatch schedule /settings
```

**Removed: `Intra-day Queue` (`/intraday`).** See §5.4.

### 5.3 The four changes

| # | Change | Reason |
|---|---|---|
| **C1** | Add a **zone switcher** to Today's Dispatch, rendered only for CSM/OH | fixes **F1** — the page is currently unreachable for two of three roles |
| **C2** | Move the **Run dispatch** action onto Today's Dispatch (Plan mode), CSM/OH only, guarded by `/dispatch-run/in-flight` | fixes **F2** — the trigger currently hides inside an OH-only rebalance page |
| **C3** | Add **Score breakdown** and **per-candidate filter states** to the decision trace panel | fixes **F3/F4** — the engine's own explanation is persisted and unrendered |
| **C4** | Pass `?date=` from every surface that says "today" to `GET /schedules` | W§25.19 — the endpoint returns stale plans without it, deliberately |

### 5.4 Why Intra-day Queue is retired

`GET /api/intraday-updates` lists `audit_logs WHERE action = 'MANUAL_ZM_UPDATE'`. Those rows are
written **only** by `POST /intraday-updates/*`, and **no admin code calls those endpoints** — every
override the product performs goes through `POST /batches/:id/override` and audits as
`BATCH_OVERRIDE_*`.

> *"The one surface that claims to answer 'what changed today' is structurally unable to see the
> changes the product makes."* — `dispatch-changes-today.service.ts:34-39`

`GET /api/dispatch/changes-today` is the replacement and is **already wired** into Today's Dispatch's
Changes rail. The page is a permanent empty state.

**Action:** remove the nav entry and the route; keep the page file until a follow-up issue deletes it.
No backend change.

### 5.5 What is a page vs. a panel — and why

| Concept | Treatment | Justification |
|---|---|---|
| Scheduler Overview / Today | **page**, 3 modes | one operating day is one screen; modes are `?mode=` on one route, not three pages |
| Run details | **page** | addressable, linkable, historical |
| Zone view | **page inside a run** (`/dispatch-runs/:runId/zones/:zoneId`) + **the whole of Today's Dispatch** for the live case | a *live* zone view and a *historical* zone card are different questions; the live one already is the cockpit |
| Work pool | **page** (`/assign`) | it is a multi-step drafting workflow, not a view |
| Engineer capacity | **not a page** — a row/lane/badge everywhere | there is no capacity endpoint; `committed/dailyCapacity` rides on five different reads (§11) |
| Ticket decision / "Why?" | **inline expandable panel** | it is per-row context; a page would break the scan |
| Preview | **page** | it is date-addressable and holds its own actions |
| Override impact | **panel inside the override dialog** | it exists only in the context of a proposal |
| Distribution | **panel inside `/assign`** | it produces a draft, never a commit |
| Holds | **no page** — actions on Preview + rail on Today | a hold is a date on a ticket, not an object with a lifecycle screen |
| Recovery / exceptions | **rails + notices**, not a page | they are statements about today, not a queue |
| Audit / explainability | **the run drill-down**, plus per-ticket trace | already the shape of the evidence |

**Total scheduler surfaces: 7 routes + 3 nested detail routes.** That is the smallest structure that
covers the engine (§37).

---

## 6. Scheduler Screen Map

```
                        ┌──────────────────────────────────────┐
                        │  Today's Dispatch   /dispatch/today  │  ← PRIMARY
                        │  ?mode=plan|live|replay  ?zoneId=    │
                        └───┬──────────┬──────────┬────────────┘
              Plan mode     │          │ Live     │ Replay
                            ▼          ▼          ▼
        ┌───────────────────────┐  ┌────────┐  ┌──────────────────────┐
        │ Scheduler Preview     │  │ Crew   │  │ Decision stream      │
        │ /schedules/preview    │  │ lanes  │  │ (processing order)   │
        │ ?date= &se=           │  │ +rails │  │  └ expand → Trace    │
        └───────────┬───────────┘  └───┬────┘  └──────────┬───────────┘
                    │ hold/release     │ links            │
                    ▼                  ▼                  ▼
             tickets/:id      /schedules/:engineerId   /dispatch-runs/:runId
                                  (OVERRIDE HERE)              │
                                        │                      ▼
                                        │            /dispatch-runs/:runId/zones/:zoneId
                                        │                      │
                                        └──────────────► /batches/:batchId
                                                               │
                                                               ▼
                                                    per-ticket decision trace

        ┌──────────────────────────┐        ┌────────────────────────┐
        │ Assign Work   /assign    │        │ SE Planner             │
        │ pool → candidates →      │        │ /engineers/planner     │
        │ distribute → review →    │        │ (the soft-bias pin)    │
        │ commit                   │        └────────────────────────┘
        └──────────────────────────┘

        ┌──────────────────────────┐        ┌────────────────────────┐
        │ Bulk Unassign  (OH)      │        │ Settings → Dispatch    │
        │ /bulk-unassign           │        │ schedule  (OH)         │
        └──────────────────────────┘        └────────────────────────┘
```

### 6.1 Deep links the UI must support

| Link | Purpose | Built? |
|---|---|---|
| `/dispatch/today?zoneId=N&mode=live` | a zone's cockpit | mode ✓, zone param ✓ **but no picker (F1)** |
| `/schedules/preview?date=YYYY-MM-DD&se=<uuid>` | a specific projection, a specific engineer | ✓ |
| `/schedules?date=YYYY-MM-DD` | committed plans for a day | endpoint ✓, **caller must pass it (C4)** |
| `/schedules/:engineerId` | one engineer's plan — the override surface | ✓ |
| `/dispatch-runs/:runId` | one run | ✓ |
| `/dispatch-runs/:runId/zones/:zoneId` | one zone card + batches + unassignable | ✓ |
| `/batches/:batchId` | one stop's assignment rows | ✓ |
| `/tickets/:ticketId` | ticket detail drawer | ✓ |

**Note:** there is no route for a per-ticket trace on its own. It is always reached inside a run
(`/dispatch-runs/:runId/tickets/:ticketId/trace` is an *API*, not a route). That is correct — a trace
without its run has no meaning.
---

## 7. Scheduler Overview / Today

**Route** `/dispatch/today?mode=plan|live|replay&zoneId=N`
**Roles** ZM (own zone, no picker) · CSM/OH (**picker required — F1**)
**API** `GET /api/dispatch/today?zoneId=` + `GET /api/dispatch/changes-today?zoneId=`
**Built** `pages/dispatch/TodaysDispatchPage.tsx` (553 lines) — keep, apply C1/C2

### 7.1 Header

| Element | Source | Notes |
|---|---|---|
| Title "Today's Dispatch" | static | |
| Subtitle `<zone name> · <operating day>` | `zone.name`, `operatingDay` | `operatingDay` is an **IST calendar day**, `YYYY-MM-DD` |
| **Zone switcher** (CSM/OH only) | **`NOT AVAILABLE FROM CURRENT API`** — no zone-list endpoint on this controller | **C1**: source from `GET /api/planner/plants` (manager-roled, returns `{plantId,name,zoneId}`) and derive distinct zones, or from `GET /api/schedules/engineers` (`zoneId` per row). Both are already used elsewhere in this app. Persist the choice in the URL and in `sessionStorage`. |
| Run badge | `run` | `null` → "No run today" (neutral). `RUNNING` → "Dispatch running" (info, dot). Otherwise `Dispatched HH:MM · <status>` |
| Refresh | — | manual `refetch` |
| **Run dispatch** (CSM/OH) | **C2** — `POST /api/schedules/dispatch-run` | see §18.1 |

### 7.2 Mode strip

Three modes, one layout, `?mode=` on the URL. Already built and correct.

| Mode | Question | Content |
|---|---|---|
| `plan` | What the next run will do | link into Scheduler Preview + (C2) the run trigger |
| `live` | What is happening today | crew lanes + rails — **the default** |
| `replay` | What a past run did, and why | decision stream in `processing_rank` order |

**Plan stays deliberately thin.** It links to the projection rather than rebuilding it — the
projection is the real recommender and must have exactly one implementation (§33).

### 7.3 The situation strip — six counters

All from `situation`, all computed server-side per request.

| Label | Field | Means | Tone | Clickable → |
|---|---|---|---|---|
| Placed | `situation.placed` | devices on a plan today | brand | — (it is the deck below) |
| Unassignable | `situation.unassignable` | no eligible engineer | warning | Unassignable rail |
| Held | `situation.held` | deferred past today | info | Held rail |
| Critical needs you | `situation.criticalNeedsYou` | escalated to a human | critical | interception strip |
| Over capacity | `situation.overCapacity` | engineers at or past cap | warning | filter the crew lanes |
| Changes today | `situation.changesToday` | human adds + removes since dispatch | neutral | Changes rail |

### 7.4 The work funnel — what may and may not be shown here

**This is the section most likely to be got wrong.** The cockpit is a *live zone view*, not a run
report. Only three of the funnel populations are reachable here; the rest live on the run's zone card.

| Population | On Today's Dispatch? | Field | Itemised? | Owner |
|---|---|---|---|---|
| recommended / placed | ✓ | `situation.placed` (derived from the lanes) | ✓ the lanes | — |
| unassignable | ✓ | `rails.unassignable[]` | ✓ with `poolEmptyReason` | **Ops** |
| held / deferred | ✓ | `rails.held[]` | ✓ with `heldUntil`, `expectedFrom`, `decidedBy` | nobody |
| withheld below threshold | ✓ | `rails.policyWithheld.count` | **✗ `itemised: false`** | nobody — policy |
| component-blocked withheld | **✗** | — | — | Warehouse |
| bucketless dropped | **✗** | — | — | Engineering |
| plant deactivated | **✗ no counter exists** | — | — | nobody |
| device departed | **✗ no counter exists** | — | — | nobody |

**`policyWithheld.itemised: false` is a contract, not a placeholder.** The engine counts this work and
never itemises it — those tickets get no recommendation, no row and no trace, so there is nothing to
list. The existing copy is correct and must not be replaced with a truncated-looking list:

> "Below the assignment threshold. Counted by the run, not itemised."

**`componentBlockedWithheld` and `bucketlessDropped` are `NOT AVAILABLE FROM THIS ENDPOINT`.** They
exist only on `dispatch_run_zones` and reach the UI through Run Detail / Zone Detail. If the cockpit
should show them, that is a backend change (**gap G-UI-2**, §35) — do not fetch the run detail just
to scrape them onto this page, because the zone card's figures are *per run* and this page is *per
day across runs*; they would disagree the moment a zone is re-dispatched.

### 7.5 Recovery notice

Rendered **above** the deck, not in a rail: *"it is not a queue of work, it is a statement about
whether this zone's day is intact."* Present only when `recovery !== null`. `null` means **nothing
crashed** — not "unknown".

| `recovery.state` | Headline | Treatment | Action offered |
|---|---|---|---|
| `RECOVERED` | "…died and was automatically re-dispatched" | calm, bordered | none — reassurance |
| `PENDING` | "…died — a re-dispatch is queued" | calm | none — the collector will return within 5 min |
| `EXHAUSTED` | "…could not be recovered automatically" | **warning, 2px** | **Run dispatch for this zone** (C2) |
| `EXPIRED` | "…the operating day ended before it could be recovered" | **warning, 2px** | none today |

Always show `attempts` and `lastAttemptAt`; show `lastError` when present. *"'It gave up' without
saying after how many tries or why is an alert nobody can act on."* Built correctly at
`TodaysDispatchPage.tsx:332-373`.

### 7.6 Critical interception strip

Present when `escalations.length > 0`. **Two causes, and the row must offer the door that works:**

| `insertionType` | Means | `assignedSeId` | Action |
|---|---|---|---|
| `SYSTEM_CRITICAL` | no capacity-eligible engineer (#268) | `null` | **Assign manually** → the escalation queue |
| `SE_UNAVAILABLE` | an engineer became unavailable on committed work (#288) | **non-null** | **Reassign on the day plan** → `/schedules/:assignedSeId` |

`assignTicket` **refuses an already-assigned ticket**, so offering "Assign" on a stranded row produces
a 409 on exactly the rows that look most urgent. The built page gets this right
(`TodaysDispatchPage.tsx:200-208`).

The explanatory sentence ("no capacity-eligible engineer was available…") is printed **only when it
is true of every row** — over a mixed list it is wrong about half.

### 7.7 Live mode — crew lanes

`engineers[]` → one `CrewCard` each. **A lane is present even when the engineer has nothing today —
"an empty lane is a fact."**

Per lane: name · `coverageType` (the **global** one) · `LoadBadge(committed/dailyCapacity)` ·
availability banner when `!== 'AVAILABLE'` · ordered stops → ticket chips · footer with stops/devices
and free slots.

**Ordinal only, no times.** Live GPS does not exist in Phase 1
(`schema.prisma:253-256`); an ETA would be invented data. The built card states this
(`CrewCard.tsx:70-73`).

**The unavailable banner must say the work still stands:** *"…— work below still stands on the plan"*.
Escalation is escalate-only; nothing was reassigned.

### 7.8 The provenance grammar

Already implemented (`CrewCard.tsx:17-45`) and correct. Restated because it is the one place a
rendering mistake is a *lie*:

| Treatment | Condition | Means |
|---|---|---|
| solid + dot | `systemPlaced === true`, non-critical | the engine decided |
| **heavy crimson** | `systemPlaced` + `slaBucket ∈ {CRITICAL, HIGH_CRITICAL}` | critical, direct-assigned |
| dashed | human, `coverageTypeAtAssign ∈ {DEDICATED, MULTI_PLANT}` | human override |
| **dashed violet** | human, `coverageTypeAtAssign ∈ {FLOATING, NONE}` | **a human crossed a coverage tier** |
| **dotted, muted** | `addSource === null` | **provenance not recorded — unknown** |
| `RET` sub-badge | `returnDueToday` | vehicle due back today |

> `addSource === null` **must never** be drawn as a system decision. It is pre-#283 history and
> genuinely unknown. *"Drawing it solid would be the single lie this whole grammar exists to
> prevent."*

The legend must stay on-surface — *"a grammar nobody can read is decoration."*

### 7.9 Rails

| Rail | Source | Row content | Empty copy |
|---|---|---|---|
| Unassignable | `rails.unassignable[]` | device/ticket link · plant · `poolEmptyReason` → "no coverage" \| "all candidates dropped" \| **"reason not recorded"** | "Everything found an engineer." |
| Held / deferred | `rails.held[]` | device link · plant · "returns `heldUntil`" · "manager-approved" when `decidedBy` | "Nothing is being held back." |
| Withheld by policy | `rails.policyWithheld` | **count only** | — |
| Changes today | `changes.changes[]` (top 8) | kind badge · ticket · reason | "Nobody has changed today's plan." |

The Changes rail's subtitle shows `adds · removes · swaps`. A **swap counts once** — the backend pairs
the two legs (W§25.17).

**The changes fetch is secondary content and must fail independently** — the built page does this
(`TodaysDispatchPage.tsx:63-66`) and it is right: a ledger failure must not take the deck down.

### 7.10 Replay mode

`GET /api/dispatch-runs/:runId/decisions?zoneId=` — **ordered by `processing_rank`**, which is the
whole point: *"any other sort describes the same decisions in an order the run never used."*

Row: ordinal rank · ticket link · plant · bucket badge · engineer **or** "Unassignable — <reason>" ·
status badge when `SUGGESTED`/`RETIRED` · **Why?** toggle → `TracePanel`.

**An unassignable decision gets a row.** Listing only placements would show a run doing less than it
did.

Paging: default 100, max 500. When `total > rows.length` show *"Showing the first N of M"* and link to
Run Detail. Do **not** auto-paginate a decision stream — the operator is scanning ranks, not browsing.

### 7.11 States

| State | Condition | Render |
|---|---|---|
| Loading | first fetch | header + skeleton |
| Error | fetch rejected | `EmptyState` + **Try again** |
| **`ZONE_REQUIRED`** | CSM/OH, no `?zoneId` | **C1: render the zone picker, not an error.** Currently an unrecoverable error state — **F1** |
| `ZONE_SCOPE_VIOLATION` (403) | ZM named another zone | "You can only view your own zone." No retry. |
| `ZONE_NOT_FOUND` (403) | unknown zone id | "That zone does not exist." Offer the picker. |
| Empty roster | `engineers.length === 0` | "No engineers on this zone's roster yet." |
| No run | `run === null` | neutral badge "No run today"; Replay shows "nothing to replay yet" |

---

## 8. Run Monitoring

### 8.1 What a run's state actually is

**Confirmed from code — these are the only values.**

`dispatch_runs.status` (`DispatchRunStatus`):

| Value | Means | Written by |
|---|---|---|
| `RUNNING` | live | `admit` |
| `SUCCESS` | every requested zone processed, no issue | `execute` |
| `PARTIAL` | some zone contended, errored, or benignly skipped | `execute` |
| `FAILED` | every **processed** zone errored, and none still contended | `execute` |
| `ABORTED` | **the process stopped existing** — reaper-only, never self-written | `reapStaleDispatchRuns` |

`dispatch_run_zones.status` (`DispatchZoneClaimStatus`):

| Value | Means |
|---|---|
| `RUNNING` | this run holds the zone — at most one per zone globally |
| `DONE` | held and completed |
| `ERROR` | held, and something went wrong **or** a benign whole-zone skip |
| `CONTENDED` | asked for and refused; `contendedWithRunId` names the holder |

`dispatch_zone_recoveries.state`: `PENDING` · `RECOVERED` · `EXHAUSTED` · `EXPIRED`.

**States a UI might expect that do not exist:** `WAITING`, `QUEUED`, `PAUSED`, `CANCELLED`,
`RETRYING`, `STALE` (as a run status). `NOT AVAILABLE FROM CURRENT API`.

### 8.2 Progress — what can honestly be shown

| Wanted | Available? |
|---|---|
| % complete | **✗** no total-zone count is exposed while running (`zones` is written at finalize) |
| zones done / total | **partially** — `zoneOutcomes[]` exists on the *trigger response*, not on any read |
| current zone | **✗** `NOT AVAILABLE FROM CURRENT API` |
| current stage | **✗** the engine has no stage concept |
| is it alive? | **✗ heartbeat is not exposed** — walkthrough **G9** |
| per-ticket progress | **✗** traces are written in one `createMany` after the whole zone |

**Therefore: no progress bar.** Show a live indicator and elapsed time only:

```
● Dispatch running · started 05:00 · 4m 12s elapsed
```

`durationMs` is `null` while running — compute elapsed client-side from `startedAt`. This is
presentation arithmetic, not engine logic, so it does not violate §33.

### 8.3 Polling

**No websocket, no SSE, no event stream exists.** `NOT AVAILABLE FROM CURRENT API`. Do not invent one.

| Condition | Interval | Endpoint |
|---|---|---|
| any run `RUNNING` | **10 s** | `GET /dispatch-runs?limit=1` (cheap) + the open page's own read |
| Run dispatch button visible (CSM/OH) | **15 s** | `GET /schedules/dispatch-run/in-flight` |
| Today's Dispatch, 04:45–05:30 IST | **30 s** | `GET /dispatch/today` |
| otherwise | **none** | manual Refresh |

Stop polling when the tab is hidden (`document.visibilityState`). The reaper's own threshold is 10
minutes, so a 10-second poll is far finer than any state that can change.

### 8.4 Runs ledger — `/dispatch-runs`

`GET /api/dispatch-runs?limit=` (1–100, default 30). Built: `DispatchRunsPage.tsx`.

Columns: run id · trigger (`CRON`/`MANUAL`) · actor (`actorName ?? actorRole ?? 'SYSTEM'`) ·
started · duration · **status** · zones · schedules · batches · dispatched · recommended ·
unassignable · errors.

**For a ZM every total is their own zone's**, and `zones` is `0` when their zone row is `CONTENDED` —
*"counting it as a processed zone would tell the ZM their zone was worked and produced nothing, when
in fact it was not worked at all."* Add a footnote for ZMs stating the figures are zone-scoped.

**"Last successful run" has no server-side filter.** Derive client-side: first row with
`status === 'SUCCESS'` in a `limit=30` fetch. If none, say *"No successful run in the last 30"* —
never "never".

### 8.5 Run Detail — `/dispatch-runs/:runId`

Built: `DispatchRunDetailPage.tsx` + `ConfigInEffectPanel.tsx`.

**Header:** trigger · actor name · **`reason`** (MANUAL only; `null` for CRON and for pre-#213 runs —
render its absence as normal, not as missing data) · started/finished/duration · status ·
**build stamp**.

**Build badge:** `build === null` → render nothing (pre-#130 run). `build.staleBuild === true` →
"ran under build vX, current is vY".

**Config in effect** — frozen at run start, never today's values:

| Panel row | Field |
|---|---|
| Scoring weights | `configSnapshot.priorityRules[]` → component + weight, grouped by `weightSetRef` |
| Cluster multiplier | `settings.plant_cluster_multiplier` |
| SE assignment threshold | `settings.se_assignment_threshold_hours` |
| Inactivity threshold | `settings.inactivity_threshold_hours` |
| Eligibility mode | `settings.eligibility_mode` |
| Dispatch cron | `scheduler.dispatchCron` |
| Sweeps enabled | `scheduler.businessSweepsEnabled` |
| Capacity map | `capacity{seId: {dailyCapacity, isActive}}` — **the historical denominator** |
| Tier overrides live then | `tierOverrides[]` |
| **Eligibility map freshness** | `eligibilityMv{lastSuccessAt, stale, lastError}` — **§24.3** |

Label the panel *"Config in effect for this run"* and state that a later edit does not rewrite it.

**Zone cards** — one per zone, §9.

### 8.6 Run status → operator meaning

| Status | Badge | Sentence |
|---|---|---|
| `RUNNING` | info, dot | "Dispatching now." |
| `SUCCESS` | success | "Every zone dispatched." |
| `PARTIAL` | warning | "Some zones were contended, skipped or errored." |
| `FAILED` | critical | "Every zone this run processed failed." |
| `ABORTED` | critical, distinct | **"The process running this dispatch stopped. Nobody knows what it completed."** |

`ABORTED` must not be styled as `FAILED`. *"`FAILED` is a statement about the WORK; `ABORTED` says
nobody knows what the run did."*

A run can be `PARTIAL` with an **empty `errors` array** — a benign skip stamps `error` on the zone
row without throwing. Never render "0 errors" as "no problems" when status is `PARTIAL`.

---

## 9. Zone View

### 9.1 Two different zone questions

| Question | Surface | Data |
|---|---|---|
| "What is this zone doing **today**?" | **Today's Dispatch** (the whole page) | `GET /dispatch/today` |
| "What did **this run** do to this zone?" | Zone card on Run Detail → Zone Detail page | `dispatch_run_zones` |

Do not build a third "live zone" page. The cockpit is it.

### 9.2 The zone card — every field

`DispatchRunZoneCard`, rendered on Run Detail and as the header of Zone Detail.

| Field | Label | Notes |
|---|---|---|
| `zoneName ?? zoneId` | Zone | |
| **`outcome`** | badge | `DONE` \| `ERROR` \| `CONTENDED` \| `RUNNING` |
| `contendedWithRunId` | "held by run N" | **only render when `outcome === 'CONTENDED'`** — a `DONE` card can still carry it (the field is deliberately not cleared on promotion, W§7.5) |
| `mode` | "Catch-up" / "Steady" | **never render the raw enum** (`DEFICIT`/`PREVENTIVE`) — `utils/operatingModeCopy.ts` already owns the mapping |
| `weightSetRef` | Weight set | e.g. `v1`, `v1_preventive` |
| `ticketsConsidered` | Considered | tickets that entered the loop |
| `recommended` | Placed | |
| `unassignable` | Unassignable | → expand `unassignableReasons` |
| `unassignableReasons.NO_COVERAGE` | "no coverage" | **Ops** |
| `unassignableReasons.ALL_DROPPED` | "all candidates dropped" | capacity/readiness |
| `unassignableReasons.dropBuckets{}` | per-filter counts | e.g. `OVER_CAPACITY ×5` |
| `withheldBelowThreshold` | Withheld by policy | **not a problem** |
| `bucketlessDropped` | Unrankable | **`null` → "not recorded", never 0** |
| `componentBlockedWithheld` | Waiting on a part | **`null` → "not recorded"** |
| `assignmentThresholdHours` | Threshold in force | ⚠ **`NOT AVAILABLE FROM CURRENT API`** — written to `dispatch_run_zones.assignment_threshold_hours` by `finalizeZoneClaim:1156`, but **absent from `DispatchRunZoneCard`**. Verified: no reference in `dispatch-transparency-query.service.ts`. **G-UI-17** |
| `schedules` / `batches` / `ticketsDispatched` | commit outcome | |
| `error` | zone error | whole-zone only |
| `seSkips[]` | Engineers skipped | `{seId, reason, constraint}` — **contained failures, not a zone failure** |
| `ticketsStillAssigned` | Still on a plan | **live**, recomputed per request |
| `ticketsRemovedSince` | Removed since | live; **no cause is attributed** — do not guess |

**`ticketsDispatched` vs `ticketsStillAssigned` must be shown together.** The first is immutable
history; the second is now. Showing only the first implies work is still on plans when it may not be.

**`ticketsRemovedSince` carries no cause** — bulk unassign, `REMOVE_TICKET` and `DEFER_TICKET` all
stamp the same column. Label it "removed since" and link to Changes-today; never say "withdrawn by".

**`seSkips` must not appear in an error column.** *"A zone that dispatched four of five SEs did not
fail."* Render as a separate "N engineers skipped" line with expandable reasons. An empty array and a
missing field mean the same thing.

### 9.3 Zone Detail — `/dispatch-runs/:runId/zones/:zoneId`

Built: `DispatchZoneDetailPage.tsx` + `ZoneDispatchTable.tsx` + `ZoneUnassignableTable.tsx`.

- **Zone card** (above), full.
- **Batches** — `batchId` · SE · plant · **company** (`"Acme +2"` when a stop spans companies) ·
  `stopSequence` · status · `ticketCount` · **`capacityUsed {used, cap}`**.
  ⚠ `used` is **live**, `cap` is from the **frozen snapshot**. Tooltip: *"used now / capacity as of
  this run."*
- **Unassignable** — ticket · device · plant · company · `poolEmptyReason` · `dropCounts`.
- **Plant stats** — `totalDevices`, `inactiveDevices`, `assignedDevices`, `unassignedDevices`.
  Assigned/unassigned **exclude resolved tickets**.

### 9.4 Representation choice

| Context | Shape | Why |
|---|---|---|
| Run Detail, N zones | **cards in a grid** | a zone is a multi-figure object; a table row would truncate the funnel |
| ZM (one zone) | **one card, expanded** | no comparison to make |
| Zone Detail | **page** | it carries two tables |
| Live zone | **the cockpit** | already a page |

### 9.5 Cross-zone read failures

| Route | Failure | Render |
|---|---|---|
| `/dispatch-runs/:runId/zones/:zoneId` | **403** `ZONE_SCOPE_VIOLATION` | "You can only view your own zone." **Never link a ZM to a foreign zone** — filter the card list, which the backend already does |
| `?zoneId=` on decisions | **403** | same |
| trace | **404** | "That decision is not available in your zone." |

---

## 10. Work Pool

**Route** `/assign` · **Built** `AssignConsolePage.tsx` (1,037 lines) + `CandidateColumn`,
`DistributePanel`, `ReviewCommitScreen`, `LaneCoverage`, `grammar.tsx`

### 10.1 The pool — `GET /api/schedules/assignable-work`

Grouped **(company → plant)**, not by plant: several companies' vehicles sit at one site, and the
tier that drives dispatch priority is a *company* attribute.

| Field | Means |
|---|---|
| `totals{openUnassigned, criticalCount, heldCount, plants}` | the header figures |
| `companies[].companyName` | group heading |
| `plants[].plantName`, `.zoneId` | row |
| `.openUnassigned` | **tickets a manual assign will move right now** |
| `.totalDevices` | denominator — *this company's* devices at this site |
| `.criticalCount` | of those, CRITICAL+ |
| `.oldestInactivityHours` | longest silence; **`null` = unmeasured, not 0** |
| `.heldCount` | open + unassigned but held to a future date |

> **`openUnassigned` is the number the button will move.** The read shares one predicate with the
> write (`assignableTickets`), and there is an e2e asserting the read predicts the write. Do not
> compute a second count client-side.

**`heldCount` is reported, not derived by subtraction** — *"a dispatcher who can see 12 devices at a
plant and is offered 9 needs the missing 3 accounted for on screen."*

Sorting is server-side: busiest first, ties on name. **Preserve it.**

### 10.2 Fields the pool does **not** carry

`NOT AVAILABLE FROM CURRENT API` on `/assignable-work`: per-ticket rows, ticket id, device id,
vehicle, SLA bucket per ticket, age per ticket, repeat failure, due date, current recommendation,
score.

The pool is **plant-shaped by design**. Per-ticket fields are reached by:
- `GET /schedules/assignable-tickets?plantIds=` → ids only, at review time;
- `GET /tickets` / the ticket drawer → full ticket detail;
- the decision trace → the engine's reasoning.

Do not attempt a per-ticket pool table from this endpoint.

### 10.3 Sorting / filtering / grouping — what is actually supported

| Capability | Supported? |
|---|---|
| server-side sort | **fixed** (busiest first) — no parameter |
| server-side filter | **none** — no query params beyond the implicit scope |
| pagination | **none** — the whole scope returns |
| search | **client-side only** |
| grouping | **fixed** (company → plant) |
| selection | client-side draft state |
| bulk action | via `assign-batch` / `assign-plants` |

Client-side filter/search over the returned set is correct here — the payload is bounded by a zone's
open backlog. **Do not** add client-side re-sorting that competes with the server's ordering without
labelling it.

### 10.4 The candidate column — `GET /api/schedules/candidates?plantIds=1,2,3`

**This is the engine's own eligibility answer, published.** `orderedCandidatesForPlant` +
`buildCandidateReadiness` + `applyHardFilters` — the identical functions the run calls.

| Field | Render |
|---|---|
| `coverageType` + `tierRank` (1/2/3) | **group under tier headings** — the precedence the engine walks |
| `verdict` `PASSED`\|`DROPPED` | badge |
| `dropReason` | the **first** failing filter — see §15.4 |
| `committed` / `dailyCapacity` | `LoadBadge` |
| `availabilityStatus` | when `!== 'AVAILABLE'` |
| `kitComplete`, `missingKit[]` | "kit short ×2" + tooltip listing parts |
| `name` | never a bare UUID |

**Order is the engine's order, untouched.** *"Sorting for the operator's convenience would render a
ranking the engine does not use."*

**Dropped candidates are returned and must be shown.** *"The operator's question at this column is
'why not them', and an empty list is the least useful possible answer."*

**`TIER_NOT_REACHED` does not appear here, deliberately** — a human may cross tiers, so a never-reached
tier is not a rejection the operator's own decision has yet made.

**`NOT_ENFORCED` is absent from this endpoint** — walkthrough **G7**. Until it lands, do not claim the
column shows all five filters; it shows a verdict and one reason.

An out-of-zone plant is **omitted from the response**, not refused (§30.4).

### 10.5 The commit flow

```
pool (company→plant, counts)
  → select plants
  → candidate column per selected plant  (the engine's eligibility)
  → optionally Distribute (§21)
  → GET /schedules/assignable-tickets?plantIds=   ← resolve to ids, right before review
  → Review & commit: lanes {seId, ticketIds[]} + mandatory reasonCode
  → POST /schedules/assign-batch
  → per-lane result
```

**Resolve ids at review time, not at selection time.** The pool count and the resolved ids share one
predicate, so they agree — but the world moves; resolving late narrows the window.

### 10.6 The lane result — itemised, not a bare count

`AssignBatchResult.lanes[]`:

| Field | Render |
|---|---|
| `result` `OK` \| `SE_NOT_FOUND` \| `LANE_FAILED` | per-lane badge |
| `assigned` | count |
| `alreadyAssigned` | count — *somebody else got there first*, not an error |
| **`skipped[]`** | **itemise**: `{ticketId, reason}` where reason ∈ `NOT_FOUND` \| `OUT_OF_ZONE` \| `CONFLICT_DEFERRED` \| `LOST_RACE` |
| `scheduleId`, `batchIds[]` | links |

> *"A bare count cannot tell an operator which ticket needs a second look."* Render every skipped
> ticket with its reason and a link.

**`LANE_FAILED` is isolated** — one lane throwing does not touch the others. Say so: *"This engineer's
lane did not commit. The other lanes were unaffected."*
---

## 11. Engineer Capacity and Workload

### 11.1 There is no capacity endpoint

`NOT AVAILABLE FROM CURRENT API` — no `/engineers/:id/capacity`. `committed / dailyCapacity` rides on
**six** reads, all fed by the one backend definition `committedDayLoad`:

| Endpoint | Shape | Where used |
|---|---|---|
| `GET /schedules/engineers` | `{engineerId, name, coverageType, zoneId, committed, dailyCapacity, isActive}` | pickers, planner grid, preview name map |
| `GET /dispatch/today` | `engineers[]` + `overCapacity` + `availability` + `stops[]` | the cockpit |
| `GET /schedules/candidates` | `{committed, dailyCapacity, verdict, dropReason, kit…}` | the assign console |
| `GET /intraday-insertions/:id/available-ses` | the same `CandidateRow`, **filtered to AVAILABLE** | the escalation modal |
| `POST /batches/:id/override/preview` | `from`/`to` `{committed, after, dailyCapacity, overCapacity}` | the override dialog |
| `POST /schedules/distribute-preview` | `overCapacitySeIds[]` | the distribute panel |

**One helper, already built:** `lib/capacity.ts` — `isOverCapacity` uses `>=`, matching the engine's
`OVER_CAPACITY` boundary exactly, and treats `dailyCapacity <= 0` as unset rather than always-full.
**Use it everywhere. Never write an inline `>`.**

### 11.2 What "committed" counts — and the three properties the UI depends on

A live day-plan stop: a `batch_assignment_tickets` row still `removed_at IS NULL`, on a **live**
schedule (`ACTIVE` ∪ `OVERRIDDEN`) whose date range covers the day, **across every zone and every
run**.

1. **`OVERRIDDEN` counts.** A ZM adjusting a plan does not un-commit the work on it.
2. **No batch-status filter.** A `PARTIAL` batch's unfinished tickets still burn the day.
3. **Not zone-filtered** on `/schedules/engineers` — *"a floating SE's work in a neighbouring zone is
   still work they have to do."* If a ZM asks why an engineer shows 5/6 with only 3 stops in their
   zone, that is the answer. **Add this as a tooltip.**

### 11.3 The asymmetry the UI must not hide

| Path | Capacity | UI |
|---|---|---|
| Morning batch | **hard block** — `OVER_CAPACITY` drops the candidate | show the drop reason |
| Intraday CRITICAL sweep | **hard block**, then **escalates** rather than overloading | the interception strip |
| `POST /schedules/assign` | **no check at all** | **enable**, mark overload |
| `assign-batch` / `assign-plants` | **no check** | **enable**, mark |
| `POST /batches/:id/override` (all 6) | **no check** | **enable**, mark |
| `manual-assign` from the queue | **no check**; the modal deliberately offers over-capacity SEs | **enable**, mark |

> **"Overload is an administrative right, so it is a seen decision rather than a refused one."**

**Every manual assign control must show `committed/dailyCapacity` and must not be disabled by it.**
`engineerOptionLabel` already handles the `<option>` case, where colour cannot be used:
`"Ravi — 6/6 · over capacity"`.

### 11.4 Availability

`GET /dispatch/today` → `engineers[].availability` (the status in force for the operating day).
`GET /schedules/candidates` → `availabilityStatus`.

`SE_UNAVAILABLE` in a drop reason **collapses two causes** — an active non-AVAILABLE window *and*
`engineer_master.is_active = false`. The trace cannot tell them apart. **Do not label it "on leave."**
Say "unavailable"; `/dispatch/today` carries the specific status where it matters.

### 11.5 What is not available

| Wanted | Verdict |
|---|---|
| live GPS position | `NOT AVAILABLE FROM CURRENT API` — no live GPS in Phase 1 |
| route geometry / travel time / ETA | `NOT AVAILABLE FROM CURRENT API` — distance exists only as a scoring term |
| standing engineer ranking | `NOT AVAILABLE FROM CURRENT API` — scores exist only per (ticket, candidate) inside a run |
| shift start/end | persisted, **read by nothing** — do not surface |
| utilization % | **compute client-side** `committed / dailyCapacity`; both ship |
| remaining capacity | **compute client-side** `dailyCapacity − committed`; floor at 0 |

### 11.6 `LoadBadge` — the canonical component

Built (`components/ui/LoadBadge.tsx`). Contract:

```
committed / dailyCapacity      →  "4/6"     neutral
committed >= dailyCapacity > 0 →  "6/6"     warning + "over capacity" title
dailyCapacity <= 0             →  committed only, no denominator, no warning
```

---

## 12. Ticket Details

The scheduler does not own the ticket page — `/tickets/:ticketId` is a drawer over the tickets list.
What the scheduler **contributes** to it:

| Contribution | Source | Notes |
|---|---|---|
| current assignment | `/dispatch/today` lanes, or `/batches/:id` | there is no per-ticket "where is it" endpoint |
| hold state | `deferred_until` via the held rail / work pool | |
| the decision | `/dispatch-runs/:runId/tickets/:ticketId/trace` | **needs a `runId`** |
| assignment provenance | `addSource`, `addedBy`, `addReason`, `coverageTypeAtAssign` on `/dispatch/today` | |

> **A trace is not addressable without its run.** To show "why" on a ticket page, you must first find
> the run. There is no `GET /tickets/:id/decision`. Practical path: reach the trace from Replay or
> from a batch row (`hasTrace`), not from the ticket. **G-UI-5.**

Ticket-level scheduler fields available **somewhere**, with their source (do not assume one call):

| Field | Available from |
|---|---|
| `ticketId`, `deviceId` | everywhere |
| `vehicleNo`, `transporterName` | trace `identity`, `/batches/:id` rows |
| plant, company | trace `identity`, `/batches/:id`, `/dispatch-runs/:runId/decisions` |
| `companyTier` | `/dispatch/today` tickets, `/decisions` rows |
| `slaBucket` | `/dispatch/today` tickets, `/decisions` rows (`deviceBucket`) |
| age / `latestGpsDatetime` | `/batches/:id` rows |
| repeat failure | **`NOT AVAILABLE`** on any scheduler read — it is a scoring input only |
| `returnDueToday` | `/dispatch/today` tickets (`RET` chip) |
| hold / `heldUntil` | `/dispatch/today` held rail, preview `holds[]` |
| `sortOrder` within a stop | `/batches/:id`, `/dispatch/today` |
| `processingRank` | `/decisions` rows, `/batches/:id` (`rank`) — **not on the trace** |
| score | `/batches/:id` (`score`), trace `chosen.score` |
| `recStatus` | `/batches/:id`, trace |

---

## 13. Scheduler Decision / Why Panel

**The single most important explainability surface.** Built as `DecisionTraceView` +
`TracePanel` (`pages/dispatch/DecisionTrace.tsx`, 160 lines) — **correct as far as it goes, and
missing two sections (F3, F4).**

**API** `GET /api/dispatch-runs/:runId/tickets/:ticketId/trace`
**Placement** inline expandable panel, inside Replay and inside a batch row. Not a page.

### 13.1 The panel, top to bottom

**1 — Identity strip** *(built)*
`identity{deviceId, vehicleNo, plantName, companyName, transporterName}` — *"read context without
navigating away."* Optional (version skew): guard, do not crash.

**2 — The outcome** *(built)*

Chosen: `Chosen: <name>` + `coverageType` badge + `SE-Planner bias` badge when `plannerBias` +
`Cluster seed` when `clusterSeed` + score.
Then: *"Nth of M eligible engineers by precedence. SE load at decision: used / cap."*

Unassignable: `Unassignable — no coverage | all candidates dropped`.

**3 — Degeneracy notice** *(built)*
When `scoreDegenerate`:

> "Every candidate scored the same, so this pick was decided by precedence (coverage tier first, then
> order) rather than by a score."

**Do not name distance as the cause** — the flag is now derived from the score spread, and naming
distance would send an operator to a setting that is not the reason.

**4 — SCORE BREAKDOWN — MISSING (F3).** §15.

**5 — Runners-up** *(built, extend per F4)*
Per row: `Nth. <name>` · `coverageType` badge · **verdict badge** · score · `dropReason`.

Verdict tones — **already correct and load-bearing**:
- `PASSED` → success
- `DROPPED` → warning
- `TIER_NOT_REACHED` → **neutral, never amber** — *"amber here would tell the operator something went
  wrong for this candidate; nothing did."*

Scores: only `PASSED` runners-up carry one. **A `TIER_NOT_REACHED` candidate must show no score** —
showing one *"would re-tell exactly the lie this slice removed."*

**6 — Drop counts** *(built)*
`Dropped candidates: OVER_CAPACITY ×3 · SE_UNAVAILABLE ×1` — pool-wide, covering candidates beyond
the top 5.

**7 — Not-enforced notice** *(built)*
When `notEnforcedFilters.length > 0`:

> "Not enforced — data source pending: VEHICLE_ON_TRIP, COMPONENT_UNAVAILABLE"

Muted, visually separate from real drop reasons. **Never rendered as a pass.**

**8 — Per-candidate filter states — MISSING (F4).** §15.4.

### 13.2 The bound the panel must state

`TRACE_RUNNERS_UP = 5`. When `candidatesTotal > 6`, the panel shows the winner + 5 and **counts**
cover the rest. Add:

> "Showing the winner and the top 5 of N candidates. The remainder are summarised in the drop counts —
> the individual rows were never stored."

Without this an operator reads "5 runners-up" as "5 candidates existed".

### 13.3 What the panel cannot answer

| Question | Verdict |
|---|---|
| candidates 7…N individually | **the rows were never stored** — not a UI gap |
| a runner-up's score *components* | only the winner's `breakdown` is stored |
| `processingRank` | on the recommendation — join from `/decisions` or `/batches/:id` |
| exact decision timestamp | `dispatch_decision_traces.created_at` is **not exposed** — `NOT AVAILABLE FROM CURRENT API` |
| which availability cause | `SE_UNAVAILABLE` collapses two |
| was a planner pin ignored? | **not recorded** — walkthrough **G6** |

---

## 14. Candidate and Ranking View

### 14.1 The rule the visual must make obvious

> **Score only decides within the winning coverage tier.**

A flat, score-sorted candidate list **is forbidden** — it implies a floating engineer with a higher
score beat a dedicated one, which the engine cannot do.

### 14.2 Required layout — grouped by tier, tier order fixed

```
DEDICATED                                   ← winning tier (tierEvaluated)
  ● Ravi Kumar        score 0.83   4/6      ← chosen
    Sneha Patel       score 0.79   2/6      PASSED
    Arun Das                       6/6      DROPPED · OVER_CAPACITY

MULTI_PLANT                                 ← never reached
    Priya Nair                     1/6      TIER_NOT_REACHED
      ↳ eligible, but this tier was never consulted

FLOATING                                    ← never reached
    Mohan Lal                      0/6      TIER_NOT_REACHED
```

Rules:
1. **Tier headings always in precedence order**, even when a tier is empty.
2. The winning tier is visually marked (`chosen.tierEvaluated`).
3. **Scores appear only inside the winning tier.** No score anywhere else.
4. `TIER_NOT_REACHED` gets an explanatory line, not a warning colour.
5. Ordering **inside** a tier is the engine's `precedenceRank`, not score-descending — the trace
   preserves precedence order and re-sorting would misrepresent it.

### 14.3 The pin

| Flag | Means | Render |
|---|---|---|
| `plannerPlanned` | this SE was pinned for this plant/date | pin icon on the row |
| `plannerBias` | **the pin actually changed the pick** | `SE-Planner bias` badge on the chosen row |

They differ. A pin on the engineer who would have won anyway is `plannerPlanned: true,
plannerBias: false` — intent recorded, answer unchanged.

⚠ **`plannerBias` compares against `passed[0]` (highest-precedence eligible), not the top-scoring
candidate** (W§18.4). It reads "the pin differed from precedence", which can over-report. Tooltip:
*"the pinned engineer was not the highest-precedence eligible candidate."* Do not claim it means the
pin beat the score.

The pin **crosses tiers** — a pinned MULTI_PLANT engineer can beat an eligible DEDICATED one. When
`plannerBias` is set and `chosen.coverageType` is not the first non-empty tier, say so explicitly:
*"A manager's pin selected this engineer from a lower coverage tier."*

### 14.4 In the Assign Console

Same grouping, different vocabulary: `PASSED`/`DROPPED` only, no `TIER_NOT_REACHED`, no scores (the
console is not placing one ticket). Group under tier headings with `tierRank`; show `dropReason`,
load, availability and kit.

---

## 15. Score Breakdown

**Status: NOT BUILT (F3).** The backend persists it; the client type omits it.

### 15.1 The data

`trace.chosen.breakdown` — `recommender.service.ts:896-897`, shape from `scoring.ts:143-153`:

```jsonc
{
  "rankScore": 1,          "urgency": 0.4286,     "repeatPenalty": 0,
  "ageScore": 0.7321,      "distanceScore": 0.0847,
  "distanceKm": 10.8,                              // or "NOT_AVAILABLE"
  "weights": { "company_priority_rank":0.4, "dispatch_urgency":0.3,
               "repeat_failure_penalty":0.2, "distance":0.1 },
  "baseScore": 0.8312,     "clusterMultiplier": 1
}
```

Also available: `recommendation.scoreBreakdown` on the same response, which adds `mode`,
`weightSetRef`, `coverageType`, `companyPriorityRank`, `companyTier`, `deviceBucket`, `score`,
`tierOverrideId`.

### 15.2 The formula to render

```
base = w_rank×rankScore + w_urgency×urgency − w_repeat×repeatPenalty
     + w_bonus×repeatPenalty + w_age×ageScore + w_distance×distanceScore

score = max(base, 0) × clusterMultiplier
```

Contribution per component = `weights[key] × <componentValue>`, **signed**:
`repeat_failure_penalty` subtracts; `repeat_failure_bonus` adds.

### 15.3 Required rendering

A **table**, not a stacked bar. Contributions can be **negative** and the total is **floored** — a
stacked bar cannot express either honestly.

| Component | Value | × Weight | = Contribution |
|---|---|---|---|
| Company priority rank | 1.00 | 0.4 | **+0.400** |
| Vehicle urgency | 0.43 | 0.3 | **+0.129** |
| Repeat failure | 0 | −0.2 | 0.000 |
| Device age | 0.73 | 0.0 | 0.000 · *not weighted in this mode* |
| Distance from previous stop | 0.08 | 0.1 | **+0.008** |
| | | **Base** | **0.837** |
| | | Cluster ×1.25 | |
| | | **Final** | **1.046** |

Mandatory behaviours:

| Case | Render |
|---|---|
| weight is `0` or absent | show the row, contribution `0.000`, muted, *"not weighted in this mode"* — **do not hide it**; its absence *is* the mode |
| `distanceKm === "NOT_AVAILABLE"` | **"not available"**, never `0 km`. `distanceScore` is genuinely 0 (neutral) — say *"no home base or no plant geometry, so distance could not be computed"* |
| `inactivityHours` missing → `ageScore` 0 | *"device age unknown"* |
| **`baseScore < 0`** | show the true negative base, then **"floored to 0 before the cluster bonus"**. The breakdown carries the unfloored value deliberately |
| `clusterMultiplier === 1` | *"first visit to this plant today — no clustering bonus"* |
| `clusterMultiplier > 1` | *"already going to this plant today — ×1.25"* |
| `scoreDegenerate` | **collapse the table by default** and lead with the precedence sentence; the numbers are true but did not decide |
| mode | show `weightSetRef` and the human mode label ("Catch-up"/"Steady") — a `_preventive` set inverts the repeat-failure sign |

### 15.4 Per-candidate filter states (F4)

`filterStates: {filter, state}[]` is persisted on the chosen row **and every runner-up**
(`recommender.service.ts:727, 903, 924`), in evaluation order, tri-state.

Render as a 5-dot strip per candidate:

```
Ravi Kumar   ◌ ● ● ● ◌      ◌ not enforced   ● passed   ✕ failed
             │ │ │ │ └ COMPONENT_UNAVAILABLE  (not enforced)
             │ │ │ └── COMMON_KIT_INCOMPLETE  passed
             │ │ └──── OVER_CAPACITY          passed
             │ └────── SE_UNAVAILABLE         passed
             └──────── VEHICLE_ON_TRIP        (not enforced)
```

Three visual states, **never two**:

| State | Treatment |
|---|---|
| `PASSED` | filled, success |
| `FAILED` | ✕, warning — **this is the recorded `dropReason` only if it is the first failure** |
| `NOT_ENFORCED` | hollow/dotted, muted, tooltip *"no data source yet — this filter was not evaluated"* |

> **A candidate can fail more than one filter; only the first is the `dropReason`.** `filterStates`
> is where the operator sees the rest. Drop counts therefore do **not** sum to "engineers with a
> problem".

Today `VEHICLE_ON_TRIP` and `COMPONENT_UNAVAILABLE` are always `NOT_ENFORCED` — but the field is
per-candidate, so it stays correct when one feed goes live before the other. **Do not hardcode the
pair.**

**Client work required:** add `breakdown?` to `TraceChosen` and `filterStates?` to both `TraceChosen`
and `TraceRunnerUp` in `api/dispatch-runs.ts`. Both optional — older runs lack them.

---

## 16. KPI Catalog and Visualization

**Every KPI below exists in code.** Nothing is invented. `lib/kpiCatalog.ts` and `components/data/KpiInfo.tsx`
already exist — register these there.

### 16.1 Run-level

| Technical | Human label | Definition | Source | Persisted | Drill-down | Tooltip |
|---|---|---|---|---|---|---|
| `status` | Run outcome | SUCCESS / PARTIAL / FAILED / ABORTED / RUNNING | `dispatch_runs.status` | ✓ | run detail | §8.6 |
| `durationMs` | Duration | `finishedAt − startedAt`; `null` while running | computed at read | ✗ | — | "elapsed so far" while running |
| `zones` | Zones dispatched | contended zones **excluded** | ✓ | zone cards | "a zone another run held is not counted here" |
| `schedules` | Day plans touched | created **or appended to** | ✓ | — | "an SE with an existing plan is appended to, not duplicated" |
| `batches` | Plant stops | | ✓ | — | |
| `ticketsDispatched` | Devices dispatched | placed on a plan | ✓ | zone → batches | |
| `recommended` | Placed by the engine | | ✓ | decisions | |
| `unassignable` | No engineer found | | ✓ | decisions (filtered) | **"Ops: a coverage or capacity gap"** |
| `errorCount` | Zones with errors | zone rows with `error != null` | computed at read | zone cards | |
| `build.staleBuild` | Ran under an older build | `buildVersion < runtime_lock.version` | partly | — | |

### 16.2 Zone-level

| Technical | Human label | Owner | Tooltip |
|---|---|---|---|
| `ticketsConsidered` | Considered | — | "tickets that entered the decision loop" |
| `recommended` | Placed | — | |
| `unassignable` | No engineer found | **Ops** | |
| `unassignableReasons.NO_COVERAGE` | No coverage | **Ops** | "nobody covers this plant at all" |
| `unassignableReasons.ALL_DROPPED` | All candidates dropped | Ops/readiness | "engineers exist, but every one failed a filter" |
| `dropBuckets{}` | Why they were dropped | — | per-filter counts across unassignable tickets |
| `withheldBelowThreshold` | Withheld by policy | **nobody** | "the device has not been silent long enough yet — this is the configured policy working" |
| `componentBlockedWithheld` | Waiting on a part | **Warehouse** | "the spare is on order and the SLA clock is paused"; **`null` = not recorded** |
| `bucketlessDropped` | Unrankable | **Engineering** | "no computed severity, so it could not be ranked at all"; **`null` = not recorded** |
| `assignmentThresholdHours` | Threshold in force | — | "40 placed out of 900 is a catastrophe at 24 h and correct at 72 h" — ⚠ **not on the response DTO (G-UI-17)**; the live value is on `/settings`, but that is *today's*, not the run's |
| `mode` | **Catch-up / Steady** | — | **never show the enum** |
| `weightSetRef` | Weight set | — | |
| `ticketsStillAssigned` | Still on a plan | — | "live now" |
| `ticketsRemovedSince` | Removed since | — | "no cause is recorded — see Changes today" |
| `seSkips[]` | Engineers skipped | — | "contained — the zone did not fail" |

### 16.3 Live (per request)

| Technical | Human label | Formula |
|---|---|---|
| `situation.placed` | Placed | Σ tickets across lanes |
| `situation.unassignable` | Unassignable | `rails.unassignable.length` |
| `situation.held` | Held | `rails.held.length` |
| `situation.criticalNeedsYou` | Critical needs you | open escalations |
| `situation.overCapacity` | Engineers over capacity | lanes where `committed >= dailyCapacity` |
| `situation.changesToday` | Changes today | human adds + human removes in the IST day |
| `policyWithheld.count` | Withheld by policy | latest run-zone's figure |
| `totals.openUnassigned` | Work waiting | the number a commit will move |
| `totals.criticalCount` | Critical waiting | |
| `totals.heldCount` | Held | |
| `oldestInactivityHours` | Longest silence | **`null` = unmeasured** |

### 16.4 KPIs the UI must compute (and may)

| KPI | Formula | Why it is safe |
|---|---|---|
| Utilization | `committed / dailyCapacity` | presentation arithmetic over two server fields |
| Remaining slots | `max(0, dailyCapacity − committed)` | same |
| Elapsed | `now − startedAt` | same |
| Zone completion | `zoneOutcomes` terminal / total | same |

**Nothing else.** Anything requiring eligibility, ranking, scoring or capacity *enforcement* is §33.

### 16.5 KPIs that do not exist

`NOT AVAILABLE FROM CURRENT API`: SLA attainment, MTTR, engineer productivity, forecast accuracy,
"tickets deferred" as a run figure, dispatch retry count, per-zone duration, per-ticket decision
timestamp, run progress %.

---

## 17. Preview UX

### 17.1 Scheduler Preview — `/schedules/preview`

**API** `GET /api/schedules/preview?date=YYYY-MM-DD` · **Built** `SchedulerPreviewPage.tsx` (493 lines)

**What it is:** the real recommender with every write suppressed. Not a second scheduler.
Count-pinned to zero writes; decision-pinned equal to the real run for today.

**Trust model — state it in the UI:**

| Date | Trust | Required copy |
|---|---|---|
| today | the run's own decisions, subject only to the world moving | — |
| D+1 and beyond | placement logic is exact; **the ranking uses today's severities** | *"Severity buckets as of `<bucketsAsOf>` — the run re-evaluates at 05:00."* **built at `:307`** |

**`bucketsAsOf` is the oldest watermark across zones**, deliberately — a newest-wins figure would
understate staleness. Render in IST.

**Layout** (built, follows `12-batch-schedule-review.png`): KPI strip → SE rail → plant stops → ticket
rows, plus a holds panel.

**Framing the page must not get wrong** — no Approve, no countdown, no submit. The only action is a
hold. The page says this outright rather than leaving it to be inferred from a missing button.

**Names, not keys** (#281 AC10): three best-effort lookups —
`GET /schedules/engineers`, `GET /planner/plants`, `GET /dashboard/operating-mode`. Each falls back to
the id; one failing must not cost the page the other two.

**⚠ F5:** `/schedules/preview?zoneId=` is passed by Today's Dispatch and read by nothing. The endpoint
has no zone parameter — scope is server-side. Remove the param from the link, or accept it and
client-side filter `zones[]` to that zone (**preferred**, since the operator arrived from one zone's
cockpit and expects to land there).

**⚠ The staleness token is unusable — §30.5.** `previewToken` is returned and, in this app, referenced
only as a type. There is no endpoint to submit it to. **Build no staleness affordance on this page.**

### 17.2 Override Impact Preview

**API** `POST /api/batches/:id/override/preview` · **Built** `components/domain/OverrideImpactPanel.tsx`

**Projectable: `REASSIGN`, `SWAP_SE`, `SPLIT_BATCH` only.** The other three are **refused with 400
`NOT_PROJECTABLE`**, not answered with zeros — *"zeros would read as 'this move costs nothing'"*.
**Do not render an impact panel for REMOVE/DEFER/REORDER.**

The four outputs:

| Output | Fields | Render |
|---|---|---|
| Two capacity lanes | `from`/`to` `{seName, committed, after, dailyCapacity, overCapacity}` | `Ravi 5/6 → 4/6` · `Sneha 5/6 → 6/6 FULL` |
| Rank context | `rank{processingRank, chosenSeId, targetPrecedenceRank, targetVerdict, targetDropReason}` | *"Sneha ranked #2 for this ticket in the 05:00 run"* |
| Route effect | `route{targetScheduleId, appendedAsStop, joinsExistingStop, reordersExistingStops}` | *"Joins her existing stop 3"* or *"Appended as stop 5 — existing stops not reordered"* |
| Conflicts | `conflicts{onSite[], deferred[]}` | *what the confirm will ask about* |

Three refusals to preserve:
1. **Conflicts are reported, not enforced.** Both are confirm-and-reason on the write. A preview that
   hid a conflicted move would lie about what the operator may do.
2. **Over-capacity is stated, never a block.** `after >= dailyCapacity` — the engine's own boundary.
3. **Single-lane actions are refused, not zeroed.**

**`rank === null` means unknown, never "unranked."** Render *"No recorded ranking for this ticket"* —
a fabricated rank would be read as the engine's opinion. `targetVerdict` may be `'CHOSEN'`, a fourth
value the trace itself never uses.

`conflicts.onSite` **reads empty today** — the soft-state feed is a seam. Do not claim "no on-site
conflicts"; say nothing when empty.

**No staleness signal exists on this preview.** If the world moves between preview and confirm, the
confirm's own 409 is the only defence. Treat the impact as advisory and **always** re-check the 409
path.

### 17.3 Distribute Preview

**API** `POST /api/schedules/distribute-preview` · **Built** `pages/assign/DistributePanel.tsx`

**The three strategies are not equivalent, and the UI must say so:**

| Strategy | What it is | Label |
|---|---|---|
| `COVERAGE_TIER` | **the engine's own answer** — a scoped dry run | *"What the scheduler would do"* |
| `CAPACITY_HEADROOM` | allocation policy: most room left gets the next ticket | *"Level the load"* — **an allocation policy, not a prediction** |
| `PLANT_WHOLE` | allocation policy: each plant intact on one engineer | *"Keep each site together"* — **an allocation policy** |

> Eligibility, tier and readiness are never re-derived — they come from the shared functions. What
> these two own is *"purely the allocation policy: given several equally eligible engineers, who gets
> what. That is a genuine choice, not a second copy of the selection rule."*

**Never label `CAPACITY_HEADROOM` or `PLANT_WHOLE` as a scheduler prediction.**

Response: `lanes[]` → the draft · `unplaced[]` with `reason` `NO_COVERAGE` \| `ALL_DROPPED` ·
`overCapacitySeIds[]` → mark, never block.

**The result is a draft.** There is no endpoint that commits a Distribute result. It feeds the console
draft, which commits through `assign-batch`.

### 17.4 The three previews compared — for the UI

| | Scheduler | Override Impact | Distribute |
|---|---|---|---|
| Writes | 0 | 0 | 0 |
| Locks / claims | none | none | none |
| Safe during a live run | ✓ | ✓ | ✓ |
| Date | any IST day | today | today |
| Staleness proof | token (**unusable**) | none | none |
| Refused actions | — | 3 of 6 | — |
| Leads to | a hold, or nothing | the confirm | the console draft |
---

## 18. Manual Assignment UX

### 18.1 Run dispatch now — **C2, not currently on any scheduler screen**

```
Location      Today's Dispatch → Plan mode (and the EXHAUSTED recovery notice)
Roles         CSM, OH only — hide for ZM
Precondition  GET /schedules/dispatch-run/in-flight  → disable + name the holder if this zone is held
API           POST /api/schedules/dispatch-run  { zoneId?: number, reason?: string }
Body          zoneId = the zone in view (always send it from the cockpit)
              reason = optional one-line "why", persisted on the ledger and shown on run detail
Confirm       yes — a modal with an optional reason field. This creates real day plans.
200           DispatchRunSummary { zones, schedules, tickets, errors[], runId, zoneOutcomes[] }
409           { code:'DISPATCH_ALREADY_RUNNING', message, inFlight[] }
              → show the message verbatim: "dispatch already running for this zone
                (zone 7, started 05:00 IST by SYSTEM)" — it is already IST-rendered
500           the future-day guard throws a plain Error (unreachable from this path)
Result UI     summarise zoneOutcomes: DONE / ERROR / CONTENDED per zone, then link to the run
Refresh       §27
```

**A MANUAL run is never patient.** A CRON run waits up to 15 minutes for a contended zone; a manual
one is refused immediately — *"an operator pressing a button wants an answer rather than a queue."*
So a 409 here is final, not a queue position. **Say so.**

### 18.2 Assign one ticket

```
Location      ticket drawer; escalation queue
Roles         ZM, CSM, OH
API           POST /api/schedules/assign { ticketId, seId, confirm?, reasonCode? }
Preview       none
Capacity      NOT CHECKED — show committed/cap on the picker, do not disable
404 TICKET_OR_SE_NOT_FOUND      → "not found, or outside your zone"
409 TICKET_ALREADY_ASSIGNED     → "somebody assigned this first" + refresh
409 CONFLICT_DEFERRED           → the hold-override dialog (§18.5)
400 DEFERRAL_OVERRIDE_REASON_REQUIRED → the confirm was sent without a reason
```

### 18.3 Assign a plant's work

```
API      POST /api/schedules/assign-plants { seId, plantIds[] }
Result   PlantAssignSummary { seId, assigned, alreadyAssigned, perPlant[{plantId, assigned, openUnassigned}] }
```

**A lost race is folded into `alreadyAssigned` here** (legacy shape), whereas `assign-batch` itemises
it. If both are on screen, do not present the two numbers as the same measurement.

`openUnassigned − assigned − alreadyAssigned` is the plant's **"vanished" gap** — tickets dropped for
`NOT_FOUND`/`OUT_OF_ZONE`/`CONFLICT_DEFERRED` and uncounted on either side. Show it as
*"N no longer eligible"* rather than letting the arithmetic look broken.

### 18.4 Assign a multi-engineer plan — the console commit

```
API       POST /api/schedules/assign-batch { reasonCode, lanes: [{seId, ticketIds[]}] }
400       REASON_REQUIRED | LANES_REQUIRED | LANE_SE_AND_TICKETS_REQUIRED
200       AssignBatchResult { lanes[] }   ← per-lane, never a single verdict
```

`reasonCode` is **mandatory** — *"the one thing a manual multi-engineer plan must always be able to
answer."* Recorded once per lane even when the lane assigned nothing.

Render §10.6. **A partial result is the normal case, not an error.**

### 18.5 Overriding a hold — one dialog, three doors

Identical vocabulary on `POST /schedules/assign`, `POST /intraday-updates/add`, and
`POST /intraday-insertions/:id/manual-assign`.

```
1. call without confirm
2. 409 CONFLICT_DEFERRED { ticketId, deferredUntil, vuReport{id, proposedFrom, expectedFrom}|null }
3. dialog:
     "This ticket is held until <deferredUntil>."
     when vuReport:  "The vehicle is expected back <expectedFrom>."
                     when proposedFrom !== expectedFrom:
                     "The engineer reported <proposedFrom>; a manager set <expectedFrom>."
     [reason — REQUIRED]  [Assign anyway]  [Cancel]
4. re-send { confirm: true, reasonCode }
5. 400 DEFERRAL_OVERRIDE_REASON_REQUIRED if the reason was blank
```

> **Confirming is not enough on its own.** *"Overruling a hold somebody placed for a stated reason is
> the one action whose 'why' is the entire accountability record."*

**The vehicle report is named, not decided.** Overriding says "assign it anyway", **not** "the vehicle
is back". Do not offer to clear the report from this dialog.

`DeferralConfirm` already exists (`components/domain/DeferralConfirm.tsx`) — reuse it.

### 18.6 Resolve an escalation

```
Read      GET /api/intraday-insertions/:id/available-ses  → CandidateRow[]  (AVAILABLE only)
Write     POST /api/intraday-insertions/:id/manual-assign { seId, confirm?, reasonCode? }
```

**The modal deliberately offers capacity- and kit-short engineers** — an administrative override, not
a gate. Show `committed/cap` and kit state; do not filter them out.

**Only for escalations whose ticket is on nobody's plan.** When `assignedSeId` is non-null, this path
409s — route to `/schedules/:assignedSeId` instead (§7.6).

---

## 19. Override UX

**Location** `/schedules/:engineerId` — the one override surface. Built (591 lines), all six actions,
impact panel wired.

### 19.1 The action matrix

| Action | UI location | Preconditions | Preview | Confirm | API | Result | Refresh |
|---|---|---|---|---|---|---|---|
| `REMOVE_TICKET` | ticket row | live batch row | **✗ refused 400** | reason | `POST /batches/:id/override` | ticket → pool | source lane, pool, changes |
| `DEFER_TICKET` | ticket row | live batch row | **✗ refused** | reason + **date** | ↑ | ticket → pool, held to date | source lane, held rail, pool |
| `REORDER` | stop header | ≥2 stops | **✗ refused** | reason + position | ↑ | **all stops renumbered** | **the whole schedule** |
| `SWAP_SE` | stop header | target SE | **✓** | reason | ↑ | whole stop moves | both lanes |
| `REASSIGN` | ticket row | target SE | **✓** | reason | ↑ | one ticket moves | both lanes |
| `SPLIT_BATCH` | stop, multi-select | ≥1 ticket + target | **✓** | reason | ↑ | subset moves | both lanes |

`reasonCode` is required by the type on all six. **The controller does not validate it** for
`/batches/:id/override` — the client must.

### 19.2 The two confirm gates

Neither is a refusal. Both return a 409 first and proceed when re-sent with `confirm: true` **and a
reason**, which is separately audited.

**ON_SITE** — `409 OVERRIDE_ON_SITE_CONFLICT { ticketIds[] }`
> *"The engineer is physically at the site working this ticket right now. Moving it blind is how two
> vans end up at one gate."*

Reads **empty today** (the soft-state feed is a seam). Build the path; expect it not to fire yet.

**DEFERRED** — `409 CONFLICT_DEFERRED { ticketIds[], seId }`
Applies **only to `SWAP_SE`, `REASSIGN`, `SPLIT_BATCH`**. Remove/defer/reorder sit outside
deliberately — *"refusing to let a manager withdraw a held ticket would obstruct the very action that
respects the hold."*

### 19.3 Two write properties the UI must respect

**Nobody's decision gets overwritten.** The check happens outside the transaction, so a concurrent
remover — or the 04:00 recycle — can commit in between. The write is conditional on the row still
being live; losing that race **aborts, and the audit entry rolls back with it**. Surfaces as
`404 BATCH_NOT_FOUND`.

> A 404 after an override **is not necessarily "gone"** — it may be "somebody else got there first."
> Copy: *"This work was already changed by someone else. Refreshing to show the current plan."* Then
> refetch, do not navigate away.

**Existing stops are never renumbered — except by REORDER.** A move appends at `max+1` or joins an
existing stop for that plant. `REORDER` renumbers every stop `1..n`; so does the intraday CRITICAL
insertion (`insertAtTop`).

> **After a REORDER, refetch the whole schedule.** Do not patch one stop's sequence locally.

### 19.4 Which ids come back — a real trap

| Action | `result.seId` / `scheduleId` | |
|---|---|---|
| `SWAP_SE` | the **destination** engineer/schedule | |
| `REASSIGN`, `SPLIT_BATCH` | the **source** engineer/schedule | ⚠ |

**Do not navigate to `result.seId` after a REASSIGN** — it is the engineer you moved work *away
from*. Use the `newSeId` you sent.

### 19.5 The dialog flow

```
select action
  ├─ two-lane?  ─ yes ─► POST /batches/:id/override/preview  (identical body)
  │                       └► OverrideImpactPanel: lanes · rank · route · conflicts
  └─ no ────────────────► no preview (400 NOT_PROJECTABLE if attempted)
reason [required]
Confirm
  ├─ 200 ──────────────► toast + refresh (§27)
  ├─ 409 ON_SITE ──────► confirm dialog naming the tickets → resend confirm:true
  ├─ 409 DEFERRED ─────► confirm dialog naming the tickets → resend confirm:true
  └─ 404 ──────────────► "already changed by someone else" + refetch
```

**The preview takes the identical body the confirm takes** — build the command once and send it
twice. *"So the two cannot drift into two vocabularies."*

---

## 20. Hold UX

### 20.1 A hold is one column

`tickets.deferred_until` — a `@db.Date`. There is no hold table, no hold lifecycle screen, and no hold
list endpoint of its own.

### 20.2 Two writers, and which to use

| | Ticket is **unassigned** | Ticket is **on a plan** |
|---|---|---|
| Endpoint | `POST /api/schedules/holds` | `POST /batches/:id/override {action:'DEFER_TICKET'}` |
| UI location | Scheduler Preview; work pool | Schedule Detail ticket row |
| Also does | nothing else | removes it from the plan **and** returns it to the pool |
| Audit | `SCHEDULER_HOLD_PLACED` | `BATCH_OVERRIDE_DEFER_TICKET` |

**Choose by state, not by screen.** `POST /holds` returns
`409 TICKET_NOT_HOLDABLE {status, assignmentState}` for an assigned ticket — use that to explain and
redirect to the day plan, not as a raw error.

### 20.3 `heldUntil` is the day it comes back

`notDeferredOn` is **inclusive**: a ticket with `deferred_until = D` **is** dispatchable on D.

> **Holding a ticket off tomorrow means naming the day after.**

The date picker must say this. Suggested label: *"Returns to the pool on"* — not "Hold until", which
reads exclusive.

### 20.4 The vehicle-return guard

```
POST /schedules/holds { ticketId, heldUntil, reasonCode }
 └─ 409 CONFLICT_VEHICLE_UNAVAILABLE { expectedFrom, reportId }
      dialog: "This ticket already has a vehicle-return date of <expectedFrom>.
               Your hold would replace it, and the return date cannot be recovered."
              [Replace it]  [Cancel]
      → resend with confirm: true
```

> *"The two are different concepts sharing one column: a hold is an admin's scheduling preference, a
> return date is an operational fact about a vehicle. Overwriting the second loses information nobody
> can recover."*

The confirm audits `overrodeVehicleReport: <reportId>`. **Say in the dialog that this is recorded.**

Built at `SchedulerPreviewPage.tsx:100` (`vuConflict` state) — verify the copy matches.

### 20.5 Release

```
POST /api/schedules/holds/release { ticketId }
200 { result:'OK', ticketId }        → "released — it re-enters the very next run"
200 { result:'NOT_HELD' }            ⚠ a 200 BODY, not a 4xx — handle it as an outcome, not an error
404 { code:'TICKET_NOT_FOUND' }
```

### 20.6 Where holds appear

| Surface | Field | Shape |
|---|---|---|
| Scheduler Preview | `holds[]` | list: ticket, `heldUntil`, plant, device |
| Today's Dispatch | `rails.held[]` | + `expectedFrom`, `decidedBy` (→ "manager-approved") |
| Work pool | `heldCount` per (company, plant) + `totals.heldCount` | counts only |
| Bulk unassign preview | `deferredExcluded` | informational — structurally untouchable |

### 20.7 The lifecycle — what happens without any UI action

| Event | Effect |
|---|---|
| the day arrives | **nothing happens** — the predicate stops excluding it. No sweep, no state change. |
| return date reached | the ticket gains **sort key 2b** — but only below CRITICAL+ |
| dispatched / manually assigned | `deferred_until → null` — **the hold is spent** |
| nightly recycle | **does not touch it** — *"`UNASSIGNED` says something may re-plan it, `deferred_until` says not yet"* |

**Do not render a "hold expiring soon" state.** There is no expiry mechanism to reflect.

---

## 21. Distribution UX

Covered in §17.3. The UI rules, restated:

1. **Label `COVERAGE_TIER` differently from the other two.** One is the engine; two are policy.
2. **`unplaced[]` is not an error** — it is `NO_COVERAGE` (Ops) or `ALL_DROPPED` (capacity/readiness).
   Show each with its reason and a link to the ticket.
3. **`overCapacitySeIds[]` marks, never blocks.**
4. **The result is a draft.** Nothing is written. The only commit is `assign-batch`.
5. Ticket and engineer selection are **client-side draft state**; the request carries explicit ids.
6. Out-of-scope ticket ids are **silently dropped** by the backend — if `lanes` + `unplaced` account
   for fewer tickets than were sent, say *"N tickets were outside your zone and were not projected."*

---

## 22. Recovery and Exceptions

**Every operational failure the UI can encounter, with its source and its owner.**

| State | What the user sees | What happened | Who acts | Action available | API | Refresh |
|---|---|---|---|---|---|---|
| **Run `ABORTED`** | "The process running this dispatch stopped. Nobody knows what it completed." | the process died; the reaper closed it | Ops/eng | inspect zones; re-run | `GET /dispatch-runs/:runId` | on demand |
| **Zone `ERROR`** | "This zone did not dispatch — `<error>`" | a throw, or a benign whole-zone skip | Ops | re-run the zone | zone card | on demand |
| **Zone `CONTENDED`** | "Another run held this zone — run `<contendedWithRunId>`" | refused at admission | nobody | open the holding run | zone card | — |
| **Recovery `PENDING`** | "…died — a re-dispatch is queued" | reaper marked it | nobody | wait (≤5 min) | `/dispatch/today` → `recovery` | 60 s while PENDING |
| **Recovery `RECOVERED`** | "…was automatically re-dispatched" | the collector succeeded | nobody | — | ↑ | — |
| **Recovery `EXHAUSTED`** | "…could not be recovered automatically" + attempts + `lastError` | 3 attempts spent | **Ops** | **Run dispatch** (C2) | ↑ | — |
| **Recovery `EXPIRED`** | "…the operating day ended first" | past 18:00 IST | **Ops** | nothing today | ↑ | — |
| **SE skipped** | "N engineers skipped" + reasons | per-SE transaction failed | Ops | inspect; usually self-clears | `seSkips[]` | next run |
| **`NO_COVERAGE`** | "no coverage" on an unassignable row | nobody covers this plant | **Ops — a coverage gap** | fix coverage; assign manually | rails / zone card | — |
| **`ALL_DROPPED`** | "all candidates dropped" + `dropCounts` | everyone failed a filter | Ops/readiness | free capacity, fix kit, restore availability | ↑ | — |
| **Withheld by policy** | count, not a list | below the threshold | **nobody** | change the threshold if wrong | `policyWithheld` | — |
| **Component-blocked** | count, `null`-aware | part on order | **Warehouse** | — | zone card | — |
| **Bucketless** | count, `null`-aware | no computed severity | **Engineering** | — | zone card | — |
| **Stale eligibility map** | "the floating-engineer pool may be out of date" | the 04:30 MV rebuild did not run | Ops/eng | rebuild | `configSnapshot.eligibilityMv` | per run |
| **Notification failure** | — | outbox retry exhausted | — | **`NOT AVAILABLE FROM CURRENT API`** | — | — |
| **`TICK_CLAIMED`** | — | another instance won the window | **nobody — this is normal** | — | not exposed | — |
| **Scheduler disabled** | — | `BUSINESS_SWEEPS_ENABLED` false | Ops | — | `configSnapshot.scheduler.businessSweepsEnabled` (per run only) | — |

### 22.1 Two states that must never look like failures

- **`CONTENDED`** — *"neither a success nor a failure of this run: the work simply was not this run's
  to do."* Neutral tone, and a link to the holding run.
- **`TICK_CLAIMED`** — a no-op. Not exposed to the UI at all, and must never be inferred as an error.

### 22.2 Two states with no UI at all today

- **Notification delivery failure.** `last_error`/`attempts` live on the outbox and are exposed
  nowhere. `NOT AVAILABLE FROM CURRENT API`. An SE may not have been told their plan changed and no
  screen can say so. **G-UI-6.**
- **Scheduler globally disabled.** Only visible inside a past run's `configSnapshot`. If sweeps are
  off, no run exists, so there is nothing to read it from. **G-UI-7.**

---

## 23. Audit / Explainability

### 23.1 Where audit lives — and it is not one page

**Do not build an audit log viewer.** There is no audit-browse endpoint
(`NOT AVAILABLE FROM CURRENT API`), and raw `audit_logs` rows are not an operator surface.

| Question | Surface | API |
|---|---|---|
| Why did the engine choose this engineer? | trace panel | `/dispatch-runs/:runId/tickets/:tid/trace` |
| What did this run decide, in order? | Replay | `/dispatch-runs/:runId/decisions` |
| What config was in force? | Run Detail | `configSnapshot` |
| Who ran this manually, and why? | Run Detail header | `actorName`, `actorRole`, `reason` |
| What did humans change today? | Changes rail | `/dispatch/changes-today` |
| Who withdrew this ticket? | Changes rail (`actorId`, `via`, `reason`) | ↑ |
| What happened to this batch? | Batch Detail | `/batches/:batchId` |
| Bulk unassign history | its own page (OH) | `/schedules/bulk-unassign/history` |
| Everything else in `audit_logs` | **not exposed** | — |

### 23.2 The changes ledger — the operator-facing audit

`GET /api/dispatch/changes-today?zoneId=`

| Field | Render |
|---|---|
| `kind` `ADD`/`REMOVE`/`SWAP` | badge |
| `ticketId` | link |
| `actorId` | **a UUID** — `NOT AVAILABLE FROM CURRENT API` as a name. **G-UI-8** |
| `at` | IST time |
| `reason` | the human "why", when the door collected one |
| `fromSeId` / `toSeId` | UUIDs — resolve via `/schedules/engineers` |
| `via` | the door: `MANUAL_REASSIGN`, `SAME_DAY_ADD`, `ZM_WITHDRAWN`, … |

**A swap counts once.** The backend pairs the two legs; do not display an add and a remove for one
move.

**The engine's own dispatch is excluded** (`addedBy` is null by construction) — *"the morning run
placing 200 tickets is not 200 changes today."*

`counts{adds, removes, swaps, total}` for the rail header.

### 23.3 What the evidence cannot tell you

| Question | Verdict |
|---|---|
| when exactly was this decision made? | `dispatch_decision_traces.created_at` **not exposed** |
| which of the two `SE_UNAVAILABLE` causes? | collapsed |
| what caused a `ticketsRemovedSince`? | deliberately unattributed |
| candidates beyond the top 5 | never stored |
| was a planner pin ignored? | never recorded (**G6**) |
| did a notification reach the engineer? | not exposed |

---

## 24. Freshness and Data State

Four independent freshness signals. **They mean different things and must not share a component.**

### 24.1 `bucketsAsOf` — the ranking watermark

**Preview only.** The newest `device_states.computed_at` among the rows actually ranked; the preview
reports the **oldest** across zones.

> *"`slaBucket` and `inactivityHours` are materialised as of the last recompute… A preview that hid
> this would look authoritative about an ordering it cannot know."*

Render always on Preview, in IST, verbatim. **Not available on a real run — G4.**

### 24.2 `previewToken` — a staleness proof with no verifier

10-minute HMAC over `{targetDate, countsByZone}`. **There is no endpoint to submit it to** (§30.5).
Build nothing on it. *(Bulk unassign's token **is** verified and does drive a `409 TOKEN_STALE` +
`freshPreview` flow — do not confuse the two.)*

### 24.3 `configSnapshot.eligibilityMv` — the floating pool's age

```jsonc
{ "viewName":"plant_eligible_floating_se",
  "lastSuccessAt": "…Z" | null, "lastAttemptAt": "…Z" | null,
  "lastError": null | "…", "stale": false }
```

`stale === true` → banner on Run Detail:
> "The floating-engineer eligibility map had not rebuilt for this operating day. Floating candidates
> may come from out-of-date territory data. The run proceeded."

**`lastSuccessAt === null` means never rebuilt, which counts as stale** — not "unknown".
No live freshness endpoint exists (**G14**).

### 24.4 `capacityUsed` on Zone Detail — live over frozen

`used` is **live**; `cap` is from the **frozen snapshot**. Tooltip required:
*"used now / capacity as of this run."*

### 24.5 Historical vs live counters

| Pair | Historical | Live |
|---|---|---|
| dispatched vs still assigned | `ticketsDispatched` | `ticketsStillAssigned`, `ticketsRemovedSince` |
| capacity | `configSnapshot.capacity` | `/schedules/engineers` `dailyCapacity` |
| weights | `configSnapshot.priorityRules` | `/org/scoring-weights` |

**Never mix a historical numerator with a live denominator without saying so.**

### 24.6 What has no freshness signal

`GET /dispatch/today`, `/schedules`, `/assignable-work`, `/candidates` carry **no server timestamp**.
Stamp the client fetch time — *"as of HH:MM"* — and label it as such. `NOT AVAILABLE FROM CURRENT API`
for a server-side one.

---

## 25. Null / Unknown Rendering Contract

**This is a correctness contract, not a style guide.** The backend's first standing rule is *"never
fabricate a default"*; rendering any of these as a value breaks it.

### 25.1 The table

| Value | Where | Means | **Render** | **Never render as** |
|---|---|---|---|---|
| `null` **`addSource`** | today's tickets | provenance not recorded (pre-#283) | dotted chip, "provenance not recorded" | solid / a system decision |
| `"NOT_AVAILABLE"` **`distanceKm`** | score breakdown | no home base, no prior stop, or no plant geometry | "not available" | `0 km` / "0 km away" |
| `"NOT_ENFORCED"` **filter state** | `filterStates`, `notEnforcedFilters` | no data source yet — **not evaluated** | hollow marker, muted, tooltip | ✓ / PASSED / "OK" |
| `null` **`bucketlessDropped`** | zone card | not recorded (the zone's recommender threw) | "not recorded" | `0` / "none" |
| `null` **`componentBlockedWithheld`** | zone card | not recorded | "not recorded" | `0` |
| `null` **`rank`** | override impact | **unknown**, never "unranked" | "no recorded ranking" | `#0` / "unranked" / "last" |
| `null` **`recovery`** | today | **nothing crashed** | render nothing | "unknown" / an empty rail |
| `null` **`build`** | run detail | pre-#130 run | render nothing | "build unknown" as a warning |
| `null` **`run`** | today | no run today | "No run today" | "failed" |
| `null` **`reason`** | run detail | CRON, or pre-#213 | render nothing | "no reason given" as a fault |
| `null` **`oldestInactivityHours`** | work pool | unmeasured | "—" | `0h` / "just now" |
| `null` **`dailyCapacity`** / `<= 0` | candidates | no cap set | show `committed` alone | `n/0` / permanently full |
| **absent map entry** `committed` | any capacity read | nothing committed | `0` ✓ *(the one safe zero)* | — |
| `null` **`poolEmptyReason`** | rails | reason not recorded | "reason not recorded" | "no coverage" |
| **empty** `seSkips` / **missing** | zone card | no engineer skipped | render nothing | "0 skipped" as a metric |
| `null` **`processingRank`** | decisions | pre-column row | "—" | `0` / `#1` |
| `null` **`score`** on a runner-up | trace | `TIER_NOT_REACHED` — never scored | blank | `0.00` |
| `null` **`scoreDegenerate`** | batch row | pre-ledger, no trace | no badge | "not degenerate" |
| `null` **`durationMs`** | run list | still running | elapsed, computed client-side | "—" while it is clearly running |
| `null` **`contendedWithRunId`** on a DONE card | zone card | *(may be non-null — it is not cleared)* | **only render when `outcome === 'CONTENDED'`** | a contention badge on a DONE zone |
| `false` **`plannerBias`** | trace | the pin did not change the pick | no badge | "no pin" (`plannerPlanned` is the other question) |

### 25.2 Three sentinels, three visual languages

```
NOT ENFORCED   ◌  hollow, dashed border, muted        "not evaluated — no data source yet"
NOT AVAILABLE  —  em-dash, muted                      "cannot be computed"
NOT RECORDED   ·  dotted, muted, italic               "no measurement was taken"
ZERO           0  normal weight, tabular              a real, measured zero
```

**Never collapse these into one "—".** Each answers a different operator question.

### 25.3 The single most dangerous conflation

> `addSource === null` rendered as a system decision.

*"Drawing it solid would be the single lie this whole grammar exists to prevent."* Already handled at
`CrewCard.tsx:20-25` — **keep it, and test it.**
---

## 26. API-to-UI Data Contract

Legend — **Calc?**: `S` server-persisted · `SR` server-computed per request · `C` client arithmetic
(§16.4 only).

### 26.1 Today's Dispatch

| UI element | API | Response field | Backend service | DB source | Calc? | Refresh |
|---|---|---|---|---|---|---|
| Zone name | `GET /dispatch/today` | `zone.name` | `DispatchTodayQueryService.today` | `zones.name` | S | on zone change |
| Operating day | ↑ | `operatingDay` | ↑ | `istDate(now)` | SR | daily |
| Run badge | ↑ | `run{runId,status,trigger,startedAt,finishedAt}` | `.latestRun` | `dispatch_run_zones` ⋈ `dispatch_runs` | S | 10 s while RUNNING |
| Recovery notice | ↑ | `recovery{state,attempts,markedAt,lastAttemptAt,lastError}` | `.recoveryToday` | `dispatch_zone_recoveries` | S | 60 s while PENDING |
| Placed | ↑ | `situation.placed` | ↑ | Σ over lanes | SR | after any mutation |
| Unassignable | ↑ | `situation.unassignable` | ↑ | `dispatch_decision_traces` (today, `seId` null) | SR | ↑ |
| Held | ↑ | `situation.held` | ↑ | `tickets.deferred_until > day` | SR | ↑ |
| Critical needs you | ↑ | `situation.criticalNeedsYou` | `.escalationsOpen` | `intraday_insertions` | SR | 2 min |
| Over capacity | ↑ | `situation.overCapacity` | ↑ | lanes where `committed >= cap` | SR | after any mutation |
| Changes today | ↑ | `situation.changesToday` | `.changesTodayCount` | `batch_assignment_tickets` both legs | SR | ↑ |
| Crew lane | ↑ | `engineers[]` | ↑ | `engineer_master` + `work_schedules` | S | ↑ |
| — committed | ↑ | `engineers[].committed` | **`committedDayPlan`** | `batch_assignment_tickets` live rows | SR | ↑ |
| — over capacity | ↑ | `engineers[].overCapacity` | ↑ | `committed >= dailyCapacity` | SR | ↑ |
| — availability | ↑ | `engineers[].availability` | `.availabilityBySe` | `se_availability` window | SR | ↑ |
| — stops | ↑ | `engineers[].stops[]` | ↑ | `plant_batch_assignments` | S | ↑ |
| — ticket chip | ↑ | `stops[].tickets[]` | ↑ | `batch_assignment_tickets` | S | ↑ |
| — provenance | ↑ | `addSource`, `addedBy`, `addReason`, `coverageTypeAtAssign`, `systemPlaced` | ↑ | ↑ | S | ↑ |
| — `RET` chip | ↑ | `returnDueToday` | `.returnDueToday` | `vehicle_unavailability_reports` OPEN | SR | ↑ |
| Unassignable rail | ↑ | `rails.unassignable[]` | `.unassignableToday` | traces where `seId` null | S | ↑ |
| Held rail | ↑ | `rails.held[]` | `.heldToday` | tickets + VU reports | S | ↑ |
| Policy withheld | ↑ | `rails.policyWithheld{count,itemised:false}` | `.policyWithheldCount` | `dispatch_run_zones.withheld_below_threshold` | S | per run |
| Escalations | ↑ | `escalations[]` + `insertionType` + `assignedSeId/Name` | `.escalationsOpen` + `currentAssigneesFor` | `intraday_insertions` + live batch rows | S+SR | 2 min |
| Changes rail | `GET /dispatch/changes-today` | `changes[]`, `counts{}` | `DispatchChangesTodayService` | `batch_assignment_tickets` | SR | after any mutation |

### 26.2 Runs, zones, batches, traces

| UI element | API | Field | Service | DB | Calc? |
|---|---|---|---|---|---|
| Runs table | `GET /dispatch-runs?limit=` | `DispatchRunListRow[]` | `.listRuns` | `dispatch_runs` ⋈ zone rows | S + SR (`durationMs`, `errorCount`) |
| Run header | `GET /dispatch-runs/:runId` | `actorName`, `reason`, `status`, `build` | `.getRunDetail` | + `users`, `runtime_lock` | S+SR |
| Config in effect | ↑ | `configSnapshot` | `captureConfigSnapshot` | frozen JSONB | S (**frozen**) |
| Zone cards | ↑ | `zones[]` | ↑ | `dispatch_run_zones` | S |
| — live counters | ↑ | `ticketsStillAssigned`, `ticketsRemovedSince` | `.liveVsRemovedByZone` | run's batch rows | **SR** |
| Zone batches | `GET /dispatch-runs/:runId/zones/:zoneId` | `batches[]` | `.getZoneDetail` | `plant_batch_assignments` | S |
| — capacity used | ↑ | `capacityUsed{used,cap}` | ↑ | live rows / **frozen snapshot** | **mixed** |
| Zone unassignable | ↑ | `unassignable[]` | ↑ | traces | S |
| Plant stats | ↑ | `plantStats{}` | `.plantDeviceStats` | `device_states`, `tickets` | SR |
| Decision stream | `GET /dispatch-runs/:runId/decisions` | `rows[]`, `total` | `.getRunDecisions` | traces ⋈ recs ⋈ tickets | S |
| **Trace** | `GET /dispatch-runs/:runId/tickets/:tid/trace` | `trace`, `scoreBreakdown`, `seNames`, `identity` | `.getTicketTrace` | `dispatch_decision_traces` | S (**immutable**) |
| Batch rows | `GET /batches/:batchId` | `rows[]` incl. `rank`, `score`, `scoreDegenerate`, `hasTrace` | `.getBatchDetail` | batch ⋈ tickets ⋈ recs ⋈ traces | S |

### 26.3 Preview, pool, candidates, distribute

| UI element | API | Field | Service | Calc? |
|---|---|---|---|---|
| Projection | `GET /schedules/preview?date=` | `zones[]` (`ZoneProjection`) | **`RecommenderService.runForZone({dryRun})`** | SR — *the real engine* |
| — decisions | ↑ | `zones[].decisions[]` | ↑ | SR |
| — plan | ↑ | `zones[].plan[]` | `buildPreviewPlan` | SR |
| — watermark | ↑ | `bucketsAsOf` | oldest across zones | SR |
| — holds | ↑ | `holds[]` | `.holdsInForce` | S |
| — token | ↑ | `previewToken` | `signPreviewToken` | SR — **no verifier (§30.5)** |
| Work pool | `GET /schedules/assignable-work` | `totals`, `companies[]` | `AssignableWorkQueryService` | SR |
| Ticket ids | `GET /schedules/assignable-tickets?plantIds=` | `[{plantId, ticketIds[]}]` | `.ticketIdsForPlants` | SR |
| Candidates | `GET /schedules/candidates?plantIds=` | `plants[].candidates[]` | **`CandidateQueryService`** | SR — *the engine's own eligibility* |
| Distribute | `POST /schedules/distribute-preview` | `lanes[]`, `unplaced[]`, `overCapacitySeIds[]` | `DistributeProjectionService` | SR |
| Override impact | `POST /batches/:id/override/preview` | `from`,`to`,`rank`,`route`,`conflicts` | `OverrideProjectionService` | SR |

### 26.4 Schedules, engineers, config

| UI element | API | Field | Notes |
|---|---|---|---|
| Schedules list | `GET /schedules?date=` | `ZmScheduleRow[]` | **pass `?date=`** (C4) |
| Schedule detail | `GET /schedules/:engineerId` | `ZmScheduleDetail` | ⚠ **no date predicate** — may show a stale plan (**G13**) |
| — reasoning chip | ↑ | `stops[].tickets[].reasoning` | latest non-RETIRED recommendation |
| — ungated badges | ↑ | `slaBucket`, `companyTier`, `partialRecovery` | independent of the reasoning gate |
| Engineer picker | `GET /schedules/engineers` | `ZoneEngineerRow[]` | load is **not** zone-filtered |
| Dispatch schedule | `GET/PUT /schedules/dispatch-schedule` | `{cron, timeZone, nextFireAt}` | **OH only** |
| In-flight | `GET /schedules/dispatch-run/in-flight` | `{inFlight[]}` | **OH/CSM only** |
| Scoring weights | `GET/POST /org/scoring-weights` | | **OH only** |
| Weight vocabulary | `GET /org/scoring-weights/components` | `{components[]}` | **OH only** — the closed set |
| Planner pins | `GET/POST/DELETE /planner…` | `PlannerEntryView[]` | affects the **next** run only |

---

## 27. Mutation-to-Refresh Contract

The app has **no query cache** (§29) — "refresh" means calling `refetch()` on the affected
`useApiResource`, or lifting the fetch so both consumers share one. Below, each row names the
**smallest set of reads** that must be re-issued.

| Mutation | Must refetch | Must NOT refetch |
|---|---|---|
| `POST /schedules/dispatch-run` | `/dispatch/today`, `/dispatch/changes-today`, `/dispatch-runs`, `/dispatch-run/in-flight`, `/schedules?date=`, `/schedules/assignable-work` | trace panels (immutable), `configSnapshot` of *past* runs |
| `POST /schedules/assign` | `/dispatch/today`, `/dispatch/changes-today`, `/schedules/assignable-work`, `/schedules/candidates` (drafted plants), `/schedules/:seId` if open | run reads |
| `POST /schedules/assign-batch` | ↑ + `/schedules/engineers` (committed moved) | ↑ |
| `POST /schedules/assign-plants` | ↑ | ↑ |
| `POST /batches/:id/override` — `REMOVE_TICKET` | `/schedules/:sourceSeId`, `/dispatch/today`, `/dispatch/changes-today`, `/schedules/assignable-work` | the *target* lane (there is none) |
| — `DEFER_TICKET` | ↑ + preview `holds[]` if open | |
| — `REORDER` | **the whole schedule** `/schedules/:seId` — every stop renumbered | other engineers |
| — `SWAP_SE` / `REASSIGN` / `SPLIT_BATCH` | **both** `/schedules/:sourceSeId` **and** `/schedules/:newSeId`, `/dispatch/today`, `/dispatch/changes-today`, `/schedules/engineers` | the pool (nothing left the pool) |
| `POST /schedules/holds` | `/schedules/preview`, `/dispatch/today` (held rail + `situation.held`), `/schedules/assignable-work` (`heldCount`) | run reads |
| `POST /schedules/holds/release` | ↑ | ↑ |
| `POST /intraday-insertions/:id/manual-assign` | `/intraday-insertions`, `/dispatch/today` (escalations + lanes) | pool |
| `POST /schedules/bulk-unassign` (EXECUTE) | **everything scheduler-scoped** | past-run `configSnapshot` |
| `PUT /schedules/dispatch-schedule` | `/schedules/dispatch-schedule` | anything else |
| `POST /org/scoring-weights` | `/org/scoring-weights` **only** — takes effect on the **next** run; past snapshots are frozen | any run read |
| `POST` / `DELETE /planner` | the planner grid **only** — affects the **next** run | today's plan |

### 27.1 The rule for the two-lane actions

> A `REASSIGN` returns the **source** ids (§19.4). Refresh **both** lanes using the `newSeId` you
> sent, not the `seId` you got back.

### 27.2 What never needs refreshing

- A **decision trace** — append-only per run, immutable.
- A past run's **`configSnapshot`** — frozen by design.
- A past run's **historical counters** (`ticketsDispatched`, `recommended`, …). Only
  `ticketsStillAssigned` / `ticketsRemovedSince` are live, and only on a run-detail re-fetch.

---

## 28. Frontend State Model

Only states with backend evidence.

```
RunState        RUNNING | SUCCESS | PARTIAL | FAILED | ABORTED
                  ABORTED is reaper-only; a run never writes it about itself

ZoneClaimState  RUNNING | DONE | ERROR | CONTENDED
                  CONTENDED ⇒ contendedWithRunId names the holder
                  a DONE row may still carry contendedWithRunId — do not render it

RecoveryState   (absent) | PENDING | RECOVERED | EXHAUSTED | EXPIRED
                  absent (null) ⇒ nothing crashed

RecommendationState  SUGGESTED | DISPATCHED | UNASSIGNABLE | RETIRED
                  RETIRED = superseded; excluded from "why suggested" reads,
                  kept in Replay

TicketAssignmentState  UNASSIGNED | FORMALLY_ASSIGNED     (tickets.assignment_state)

ScheduleState   ACTIVE | OVERRIDDEN | COMPLETED | PARTIAL
                  LIVE = ACTIVE ∪ OVERRIDDEN — an overridden plan is still today's work

BatchState      AUTO_ASSIGNED | OVERRIDDEN | COMPLETED | PARTIAL

HoldState       (derived, not an enum)
                  none            deferred_until IS NULL
                  held            deferred_until > today
                  returning       deferred_until <= today AND an OPEN VU report has arrived
                                    → returnDueToday, sort key 2b (sub-CRITICAL only)

FilterState     PASSED | FAILED | NOT_ENFORCED          (never two-state)

CandidateVerdict
   in a trace   PASSED | DROPPED | TIER_NOT_REACHED
   in console   PASSED | DROPPED                        (deliberately narrower)

EscalationState PENDING_ACCEPTANCE | ACCEPTED | DECLINED | TIMED_OUT
                | ESCALATION_REQUIRED | ASSIGNED_DIRECT
                  only ESCALATION_REQUIRED and ASSIGNED_DIRECT are live post-#268;
                  the offer states are dead vocabulary

EscalationCause SYSTEM_CRITICAL | SE_UNAVAILABLE        (insertionType)

PreviewState    (client-only) idle | loading | projected | error
                  no server-side lifecycle — a preview is a read

OverrideState   (client-only) idle | projecting | projected | confirming
                | conflict(ON_SITE|DEFERRED) | committed | lost-race
```

### 28.1 Relationships

```
DispatchRun ──1:N── DispatchRunZone ──(zone,day)── DispatchZoneRecovery
     │                     │
     │                     └── seSkips[]  (contained per-engineer failures)
     │
     ├──1:N── Recommendation ──1:1── DecisionTrace
     │              │                     └── chosen + runnersUp[≤5] + filterStates + breakdown
     │              └── status: SUGGESTED → DISPATCHED | UNASSIGNABLE | RETIRED
     │
     └──1:N── WorkSchedule ──1:N── PlantBatchAssignment ──1:N── BatchAssignmentTicket
                   │                        │                          │
              (live = ACTIVE∪OVERRIDDEN)  stop_sequence            sort_order
                                                                  add/removal provenance
                                                                        │
                                                        committedDayPlan reads exactly these
                                                        (removed_at IS NULL, live schedule, day)
```

### 28.2 The one invariant a client must not break

> `committed` comes from **one** backend function and is rendered by six surfaces. Never derive it
> locally from a lane's ticket count — a lane shows one zone; `committed` spans all zones.

---

## 29. Query / Cache Model

### 29.1 The existing stack — use it

| Concern | Convention | Location |
|---|---|---|
| HTTP | `fetch` + `authHeaders()`, `BASE_URL = VITE_API_URL ?? 'http://localhost:3000/api'` | `api/*.ts`, one module per domain |
| 401 handling | a global rotating-refresh interceptor over `window.fetch` | `api/http.ts` |
| Fetching | **`useApiResource<T>(fetcher, deps, errorMsg)`** → `{data, loading, error, refetch}` | `hooks/index.ts` |
| Mutating | **`useAsyncAction<A>(fn, onError)`** → `{run, pending, error}` | ↑ |
| Filters | `useFilters<T>(initial)` | ↑ |
| Routing | `react-router-dom` v6, `RoleRoute` gates | `AppRoutes.tsx` |
| URL state | `useSearchParams` with `{replace: true}` for in-page state | Preview, Today's Dispatch |
| Toasts | `useToast` | `components/data/Toast.tsx` |
| Tables | `DataTable` | `components/data/DataTable.tsx` |
| Empty/loading | `EmptyState`, `Skeleton` | `components/data/feedback.tsx` |
| KPIs | `MetricStrip`, `KpiInfo` | `components/data` |

**There is no React Query, no Redux, no Zustand.** Do not introduce one for this feature — §28 of the
brief forbids it unless no mechanism exists, and `useApiResource` is a working mechanism.

### 29.2 Consequences, and how to work within them

| Consequence | Handling |
|---|---|
| No cross-component cache | **Lift the fetch** to the page and pass data down. Today's Dispatch already does this. |
| No automatic invalidation | The page owns `refetch` and calls it per §27. Pass `refetch` into dialogs. |
| No dedup | Two components needing the same read → one page-level fetch, props down. **`/schedules/engineers` is fetched by ≥4 surfaces** — a page that needs it more than once must fetch once. |
| No background refetch | Explicit `setInterval` in a `useEffect`, cleared on unmount **and** on `visibilitychange`. |
| No optimistic updates | **Correct for this domain.** Every mutation can 409. Show `pending`, then refetch. Never optimistically move a ticket between lanes — a lost race would show work on the wrong engineer. |

### 29.3 Polling helper (the one addition worth making)

`useApiResource` has no interval. Rather than a new library:

```ts
// hooks/index.ts — additive, matches the existing shape
export function usePolledResource<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  intervalMs: number | null,     // null = no polling
  errorMsg?: string,
): ApiResource<T>
```

Wraps `useApiResource`, adds a `setInterval` that calls `refetch`, pauses on
`document.visibilityState !== 'visible'`. Intervals per §8.3.

### 29.4 Naming

`api/` modules already exist for every scheduler endpoint:
`dispatchToday.ts` · `dispatch-runs.ts` · `schedulerPreview.ts` · `schedules.ts` · `candidates.ts` ·
`assignWork.ts` · `intradayInsertions.ts` · `intradayUpdates.ts` · `dispatchSchedule.ts` ·
`bulkUnassign.ts` · `planner.ts` · `operatingMode.ts`.

**Add nothing.** The three client-side changes needed are type additions in `dispatch-runs.ts`
(F3/F4) and one zone-list helper for the picker (C1).

---

## 30. Error and Conflict UX

### 30.1 By status

| Status | Meaning | Treatment | Retry? |
|---|---|---|---|
| **400** | validation / missing scope | **inline**, next to the offending control | fix + resubmit |
| **403** | permission or zone scope | **page-level**, no retry | no |
| **404** | not found **or** out of scope **or** lost race | **contextual** — see §30.3 | usually refetch |
| **409** | conflict — often **actionable** | **dialog**, never a toast | yes, with `confirm` |
| **500** | unexpected | toast + Try again | yes |

### 30.2 Every code the scheduler surfaces can return

| Code | Endpoint | Copy | Action |
|---|---|---|---|
| `ZONE_REQUIRED` | `/dispatch/*` | — | **render the zone picker (C1)** |
| `INVALID_FILTER` | ↑ | "That zone id is not valid." | picker |
| `ZONE_SCOPE_VIOLATION` | zone/decisions/today | "You can only view your own zone." | none |
| `INVALID_DATE` | preview, holds, schedules | "Use YYYY-MM-DD." | inline on the field |
| `INVALID_CRON_EXPRESSION` | dispatch-schedule | show `reason` **verbatim** — it is the parser's own message | inline; **the previous schedule is untouched and still firing** — say so |
| `DISPATCH_ALREADY_RUNNING` | dispatch-run | `message` verbatim (already IST-rendered) + `inFlight[]` | disable; poll in-flight |
| `TICKET_ALREADY_ASSIGNED` | assign, manual-assign | "Somebody assigned this first." | refetch |
| `TICKET_OR_SE_NOT_FOUND` | assign | "Not found, or outside your zone." | refetch |
| `CONFLICT_DEFERRED` | assign / override / intraday | the hold dialog (§18.5) | confirm + reason |
| `DEFERRAL_OVERRIDE_REASON_REQUIRED` | ↑ | "A reason is required." | inline |
| `OVERRIDE_ON_SITE_CONFLICT` | override | name the tickets | confirm + reason |
| `TICKET_NOT_HOLDABLE` | holds | "This ticket is on a day plan — defer it there instead." | **link to `/schedules/:seId`** |
| `CONFLICT_VEHICLE_UNAVAILABLE` | holds | the return-date dialog (§20.4) | confirm |
| `INVALID_HOLD` | holds | "Ticket, date and reason are required." | inline |
| `NOT_PROJECTABLE` | override preview | **do not show** — never call it for single-lane actions | — |
| `BATCH_NOT_FOUND` | override | **"Already changed by someone else."** | refetch |
| `TICKET_NOT_FOUND` | holds | | refetch |
| `DISPATCH_RUN_NOT_FOUND` / `_ZONE_` / `_TRACE_` / `_BATCH_` | ledger reads | "Not available." | back |
| `PREVIEW_TOKEN_REQUIRED` / `_INVALID` / `_STALE` | **bulk unassign only** | `_STALE` → show `freshPreview` and re-confirm | re-preview |
| `REASON_REQUIRED` / `LANES_REQUIRED` / `LANE_SE_AND_TICKETS_REQUIRED` | assign-batch | inline | fix |
| `TICKET_IDS_REQUIRED` / `ENGINEER_IDS_REQUIRED` / `STRATEGY_REQUIRED` | distribute | inline | fix |
| `SE_AND_PLANTS_REQUIRED` | assign-plants | inline | fix |

### 30.3 The 404 that is really a conflict

`404 BATCH_NOT_FOUND` after an override may mean the guarded write **lost a race** — a concurrent
remover or the 04:00 recycle got there first, and the transaction rolled back *including its audit
row*.

> Copy: **"This work was already changed by someone else. Showing the current plan."**
> Then refetch. **Do not** say "not found" and **do not** navigate away.

### 30.4 Silent omission — the third failure mode

Two endpoints **omit rather than refuse**:

- `GET /schedules/candidates?plantIds=` — an out-of-zone plant is absent from `plants[]`.
- `POST /schedules/distribute-preview` — out-of-scope ticket ids are dropped.

**If you asked for N and got back fewer, say so.** *"2 of the 5 plants you selected are outside your
zone and were not returned."* Otherwise the operator reads an empty column as "nobody covers this
site".

### 30.5 The conflict UX that cannot be built

**Preview staleness on the scheduler preview.** `previewToken` is minted on every response and
`checkStaleness` is implemented — but **no route exposes it**. `NOT AVAILABLE FROM CURRENT API`.

Do not build a "your preview is stale" affordance on `/schedules/preview`. The pattern **does** exist
and **is** wired on Bulk Unassign (`409 PREVIEW_TOKEN_STALE` + `freshPreview`) — use that as the
template when the scheduler endpoint lands. **Gap G-UI-1 / walkthrough G1.**

---

## 31. Page-by-Page Specification

### 31.1 Today's Dispatch — `/dispatch/today`

```
PURPOSE     The operating day for one zone: what the engine did, what needs a human, what changed.
USERS       ZM (own zone) · CSM/OH (must choose a zone)
ROUTE       /dispatch/today?mode=plan|live|replay&zoneId=N
PRIMARY     Run dispatch (C2, CSM/OH) · resolve an escalation · open a plan · inspect a decision

LAYOUT
  Header    title · "<zone> · <operatingDay>" · [zone picker: CSM/OH] · run badge · Refresh
            · [Run dispatch: CSM/OH]
  Nav       mode strip — Plan | Live | Replay
  Strip     MetricStrip ×6 (§7.3)
  Notice    RecoveryNotice (when recovery != null)
  Notice    Critical interception strip (when escalations.length > 0)
  Main      live:   crew lanes grid + ProvenanceLegend  |  rails aside (18rem)
            plan:   projection link + Run dispatch
            replay: decision stream, each row expandable → TracePanel

LOADING     header + skeleton
EMPTY       no engineers → "No engineers on this zone's roster yet."
            no run → neutral badge; Replay → "nothing to replay yet"
ERROR       EmptyState + Try again
ZONE_REQ    ► zone picker, NOT an error (C1 — currently F1)
STALE       none available (§24.6) — stamp client fetch time
PERMISSION  ZM: no picker, no Run dispatch

API         GET /dispatch/today?zoneId=          (primary)
            GET /dispatch/changes-today?zoneId=  (secondary — must fail independently)
            GET /dispatch-runs/:runId/decisions  (replay)
            GET /dispatch-runs/:runId/tickets/:tid/trace  (on expand)
            GET /schedules/dispatch-run/in-flight (C2, CSM/OH)
MUTATIONS   POST /schedules/dispatch-run (C2)
REFRESH     10 s while RUNNING · 30 s in the dispatch window · else manual
DEEP LINKS  ?mode= ?zoneId=
NAV OUT     /tickets/:id · /schedules/:seId · /schedules/preview · /dispatch-runs/:runId
            · /dispatch-runs · /intraday(escalation, unassigned only)
```

### 31.2 Scheduler Preview — `/schedules/preview`

```
PURPOSE     What the next run WOULD do, and the one pre-run lever (a hold).
USERS       ZM (own zone) · CSM/OH (all zones)
ROUTE       /schedules/preview?date=YYYY-MM-DD&se=<uuid>
PRIMARY     Place a hold · release a hold · read the projection

LAYOUT
  Header    title · date picker (default tomorrow) · mode label ("Catch-up"/"Steady")
  Caveat    "Severity buckets as of <bucketsAsOf> — the run re-evaluates at <nextFireAt>"
  Framing   "Approval is never required. Doing nothing means the run proceeds."
  Strip     recommended · unassignable · withheld · component-blocked (per zone)
  Main      SE rail → plant stops → ticket rows        (12-batch-schedule-review layout)
  Panel     Holds in force → release
  Errors    zones[] that failed to project — surfaced, never dropped

EMPTY       zones [] → "No active zone in your scope."
            plan  [] → "The run would place nothing for this day."
ERROR       "Failed to load the projected plan."
STALE       bucketsAsOf ALWAYS rendered; token unusable (§30.5)
PERMISSION  ZM zone-clamped server-side; ⚠ NOT acting-zone aware (§4.3)

API         GET /schedules/preview?date=
            GET /schedules/engineers · GET /planner/plants · GET /dashboard/operating-mode
              (three best-effort name lookups — one failing must not cost the page the others)
MUTATIONS   POST /schedules/holds · POST /schedules/holds/release
REFRESH     on date change; after a hold write
DEEP LINKS  ?date= ?se=      ⚠ ?zoneId= is inert (F5)
NAV OUT     /schedules/:se (the committed twin) · /tickets/:id
```

### 31.3 Schedules — `/schedules` and `/schedules/:engineerId`

```
LIST
PURPOSE     Committed day plans.
ROUTE       /schedules?date=YYYY-MM-DD      ◄── C4: always pass ?date= on a "today" surface
API         GET /schedules?date=
COLUMNS     engineer · zone · dateFrom–dateTo · status · batchCount · ticketCount
⚠           Without ?date= this returns every live plan including never-closed ones from last week.

DETAIL — THE OVERRIDE SURFACE
PURPOSE     One engineer's plan, and the six ways to change it.
ROUTE       /schedules/:engineerId
API         GET /schedules/:engineerId · GET /schedules/engineers (targets)
MUTATIONS   POST /batches/:id/override/preview   (SWAP_SE, REASSIGN, SPLIT_BATCH only)
            POST /batches/:id/override           (all six)
LAYOUT      header (engineer, status, dates)
            → stops (ordered) → [Reorder] [Swap SE]
              → tickets (sorted) → [Remove] [Defer] [Reassign] · multi-select → [Split]
            → OverrideImpactPanel inside the two-lane dialogs
            → "Why suggested?" chip per ticket (companyTier, deviceBucket, rank, cluster×)
            → ungated badges: slaBucket, companyTier, partialRecovery
⚠           No date predicate on this read — may show a stale plan (G13). Show dateFrom/dateTo
            prominently and warn when dateTo < today.
REFRESH     §27 — REORDER refetches the whole schedule
```

### 31.4 Dispatch Runs — `/dispatch-runs`, `/:runId`, `/:runId/zones/:zoneId`, `/batches/:id`

```
LIST        GET /dispatch-runs?limit=  (1–100, default 30)
            columns §8.4 · ZM footnote: "figures are for your zone"
            "Last successful run" derived client-side; never say "never"

RUN DETAIL  GET /dispatch-runs/:runId
            header §8.5 · Config-in-effect panel · zone cards §9.2
            MV-stale banner when configSnapshot.eligibilityMv.stale

ZONE DETAIL GET /dispatch-runs/:runId/zones/:zoneId
            zone card · batches (capacityUsed tooltip) · unassignable · plant stats
            403 ZONE_SCOPE_VIOLATION for a ZM's foreign zone — never link there

BATCH       GET /batches/:batchId
            rows: ticket · device · vehicle · transporter · deviceType · imsi · lastGps
                  · rank · score · scoreDegenerate · recStatus · ticketStatus · hasTrace
            hasTrace → expand the trace panel
            runId may be null (manual plan, or an intraday CRITICAL schedule) — the batch still
            resolves; only the run-keyed trace is unavailable

REFRESH     10 s while any run is RUNNING; otherwise none. Traces never refresh.
```

### 31.5 Assign Work — `/assign`

```
PURPOSE     Hand out unassigned work with the engine's own eligibility in view.
USERS       ZM · CSM · OH (acting-zone aware)
ROUTE       /assign
FLOW        pool → select plants → candidate column → [Distribute] → resolve ids → review → commit

API         GET /schedules/assignable-work
            GET /schedules/candidates?plantIds=
            GET /schedules/assignable-tickets?plantIds=
            POST /schedules/distribute-preview
MUTATIONS   POST /schedules/assign-batch   (reasonCode mandatory)
            POST /schedules/assign-plants  (legacy shorthand)

EMPTY       totals.openUnassigned === 0 → "Nothing is waiting to be assigned."
            candidates [] for a plant → "No engineer covers this plant." (NO_COVERAGE)
PARTIAL     per-lane results; skipped[] itemised with reasons (§10.6)
PERMISSION  acting-zone honoured on all four reads and the commit
```

### 31.6 Supporting surfaces

```
SE PLANNER      /engineers/planner   GET/POST/DELETE /planner  · affects the NEXT run only
                 ⚠ no date validation server-side — validate client-side
BULK UNASSIGN   /bulk-unassign (OH)  preview → token → execute · 409 TOKEN_STALE → freshPreview
                 ⚠ currently also hosts the only Run-dispatch trigger — move it (C2)
DISPATCH SCHED  /settings (OH)       GET/PUT /schedules/dispatch-schedule
                 show cron + timeZone + nextFireAt; on 400 state that the OLD schedule still fires
INTRA-DAY QUEUE /intraday            ► RETIRE (§5.4)
```

---

## 32. Component-by-Component Specification

| Component | Input data | API source | Interaction | State | Mutation |
|---|---|---|---|---|---|
| `ZoneSwitcher` **(new, C1)** | zone list | derived from `/planner/plants` or `/schedules/engineers` | select → `?zoneId=` | URL + sessionStorage | — |
| `RunStatusBadge` | `run{status,startedAt,trigger}` | `/dispatch/today`, `/dispatch-runs` | — | — | — |
| `RunDispatchButton` **(new, C2)** | `inFlight[]`, role | `/dispatch-run/in-flight` | click → confirm modal (optional reason) | pending / 409 | `POST /schedules/dispatch-run` |
| `SchedulerMetricStrip` | `situation` | `/dispatch/today` | click → scroll to rail | — | — |
| `RecoveryNotice` *(built)* | `recovery` | ↑ | — (EXHAUSTED → Run dispatch) | — | — |
| `CriticalInterceptionStrip` *(built)* | `escalations[]` | ↑ | route by `assignedSeId` | — | — |
| `CrewCard` *(built)* | `TodayEngineer` | ↑ | click stop → batch | — | — |
| `TicketChip` *(built)* | `TodayTicket` | ↑ | hover → provenance title | — | — |
| `ProvenanceLegend` *(built)* | — | — | — | — | — |
| `LoadBadge` *(built)* | `{committed, dailyCapacity}` | six reads | tooltip | — | — |
| `Rail` *(built)* | title, count, rows | ↑ | row → ticket | — | — |
| `PolicyWithheldCard` *(built)* | `{count, itemised:false}` | ↑ | **none — never a list** | — | — |
| `DecisionStreamRow` *(built)* | `DispatchDecisionRow` | `/decisions` | expand → trace | open ticket id | — |
| `TracePanel` *(built)* | `runId`, `ticketId` | `/trace` | lazy fetch | loading/error | — |
| `DecisionTraceView` *(built, extend)* | `DispatchTicketTrace` | ↑ | — | — | — |
| `ScoreBreakdownTable` **(new, F3)** | `trace.chosen.breakdown` | ↑ | expand/collapse | collapsed when degenerate | — |
| `FilterStateStrip` **(new, F4)** | `filterStates[]` | ↑ | tooltip per dot | — | — |
| `CandidateTierGroup` **(new, §14.2)** | `chosen` + `runnersUp[]` | ↑ | — | — | — |
| `ZoneStatusCard` *(built)* | `DispatchRunZoneCard` | `/dispatch-runs/:runId` | → zone detail | — | — |
| `ConfigInEffectPanel` *(built)* | `configSnapshot` | ↑ | expand sections | — | — |
| `FreshnessIndicator` **(new, §24)** | one of four signals | varies | tooltip | — | — |
| `CandidateColumn` *(built)* | `PlantCandidates` | `/candidates` | select engineer | draft | — |
| `DistributePanel` *(built)* | strategy + selections | `/distribute-preview` | strategy switch | draft | — |
| `ReviewCommitScreen` *(built)* | lanes + reason | `/assignable-tickets` | commit | pending | `POST /assign-batch` |
| `OverrideDialog` *(built)* | `OverrideCommand` | — | preview → confirm | conflict states | `POST /batches/:id/override` |
| `OverrideImpactPanel` *(built)* | `OverrideImpact` | `/override/preview` | — | — | — |
| `DeferralConfirm` *(built)* | 409 body | — | confirm + reason | — | re-send |
| `HoldDialog` **(extend)** | ticket + date + reason | — | confirm; VU conflict | 409 | `POST /schedules/holds` |
| `DispatchTimelineNote` *(built)* | — | — | cross-view links | — | — |

**"Built" = exists and is correct.** "extend" = exists, needs the noted addition. "new" = does not
exist.
---

## 33. Things Frontend Must NOT Reimplement

Every item below is decided by the engine and must be **displayed**, never recomputed. The reason is
always the same shape: two callers reading the same facts differently while agreeing perfectly on the
rule is the *quiet* failure — a screen that looks right and disagrees with dispatch under load.

| Concept | Frontend displays | Backend source | Why never client-side |
|---|---|---|---|
| **Ticket ranking** | `processingRank`, and the stream's order | `canonicalSort` — 6 keys | 6 keys incl. a sub-CRITICAL-gated return-date key and a null-last GPS ordering. **There is no SQL mirror**; re-sorting client-side invents a second ordering. |
| **Hard-filter evaluation** | `verdict`, `dropReason`, `filterStates` | `applyHardFilters` | first-FAILED-wins over a fixed order, with two filters permanently `NOT_ENFORCED`. A client check would render a stub as a pass. |
| **Tier selection** | `coverageType`, `tierRank`, `tierEvaluated` | `chooseWithinTier` | the winning tier is the first non-empty tier of *hard-filtered* candidates — it depends on filter results the client does not hold. |
| **Score** | `score`, `breakdown` | `scoreCandidate` | 6 weighted components, DB-configurable weights, a **floor before a multiplier**, and a mode switch that inverts one sign. |
| **Capacity enforcement** | `committed`, `dailyCapacity`, `overCapacity` | `committedDayLoad` + `OVER_CAPACITY` | the count spans **every zone and every run**, includes `OVERRIDDEN` plans, and excludes nothing by batch status. A lane's ticket count is not it. |
| **Eligibility / coverage** | `candidates[]` in the engine's order | `orderedCandidatesForPlant` | `se_coverage` ∪ a materialized view **re-validated live** against `engineer_master`. |
| **Planner-pin selection** | `plannerPlanned`, `plannerBias` | `chooseWithinTier` | the pin crosses tiers and beats the score; whether it *changed* the outcome is a comparison against the engine's own ordering. |
| **Route mutation** | `stopSequence`, `sortOrder`, `route.appendedAsStop` | `moveTickets` / `nextStopSequence` | append-vs-join and the REORDER renumber are transactional facts. |
| **Conflict rules** | the 409 bodies | `override` gates | ON_SITE and deferral gates are evaluated inside the write against live rows. |
| **Decision trace** | the persisted JSONB | `RecommenderService` | it is the record of a decision already made. Recomputing it would produce a *different* decision. |
| **Mode (DEFICIT/PREVENTIVE)** | the human label | `SoftInactiveCountService` | a zone-level threshold over materialised device state. |
| **"Assignable" work** | `openUnassigned` | `assignableTickets` | three clauses, one of them a date-inclusive deferral boundary. The read predicts the write **only** because they share the predicate. |
| **"Live" schedule** | `status` | `LIVE_SCHEDULE_STATUSES` | `OVERRIDDEN` is still today's work. Filtering to `ACTIVE` blanks a whole day plan. |
| **Return-due** | `returnDueToday` | `returnDateArrivedBefore` | an IST-day boundary on a timestamptz column. |

### 33.1 The four things the client MAY compute

Presentation arithmetic over fields the server already sent (§16.4): **utilization**, **remaining
slots**, **elapsed time**, **zone completion count**.

### 33.2 The rule of thumb

> If the number would change when a *backend* rule changes, fetch it. If it would only change when a
> *pixel* changes, compute it.

---

## 34. Things That Should NOT Be Exposed

| Category | Items | Verdict |
|---|---|---|
| **Required for UI** | run/zone/recovery states, the funnel counters, `committed`/`dailyCapacity`, coverage tier, verdicts, scores + breakdown, `filterStates`, `poolEmptyReason`, `dropCounts`, provenance fields, `heldUntil`, `bucketsAsOf`, `stopSequence`, `sortOrder`, `reasonCode` | show |
| **Useful for diagnostics** — behind an expander, OH-first | `runId`, `batchId`, `scheduleId`, `recommendationId`, `weightSetRef`, `configSnapshot` raw, `buildVersion`/`buildFingerprint`, `contendedWithRunId`, `seSkips[].constraint`, `assignmentThresholdHours`, `eligibilityMv.lastError`, `imsiNo`, `deviceType`, `tripCreationDatetime` | show on demand, not by default |
| **Backend-only — never render** | `traceId`, `insertionId` (except as a key), `run.heartbeatAt`, advisory-lock keys, `cron_tick_claims`, `dispatch_run_zones.id`, `tierOverrideId`, outbox ids/`attempts`/`lastError`, `retryChain`, `path` (`MORNING_BATCH`), `@@unique` names, `P2002` codes, `LostRaceError`, `previewToken` (opaque) | hide |
| **Dead / unused — do not build UI for** | `intraday_insertions.retryCount` & `retryChain` (the offer machinery is deleted), `priority_rule_config.effectiveFrom` (read by nothing), `engineer_master.shiftStart/shiftEnd` (read by nothing), `IntradayInsertionStatus` offer states (`PENDING_ACCEPTANCE`/`DECLINED`/`TIMED_OUT`), `RecPath.INTRADAY` (never written), `GET /intraday-updates` (structurally blind) | do not surface |
| **Raw ids in place of names** | `seId`, `plantId`, `zoneId`, `companyId`, `actorId` | **always resolve**. `/decisions` and `/trace` return `seName`; `/dispatch/today` returns `name`; plants come from `/planner/plants`. **`changes-today.actorId` has no name source — G-UI-8.** |

### 34.1 The `mode` rule

`DEFICIT` / `PREVENTIVE` **must never reach a user**. Map through `utils/operatingModeCopy.ts`
("Catch-up" / "Steady"). This is the backend's own instruction.

### 34.2 Truncated UUIDs

The app renders `ticketId.slice(0, 8)` in dense lists. Acceptable **only** when the full id is in a
`title` and the row links to the entity. Never as the sole identifier in a dialog or a confirmation.

---

## 35. Frontend-Backend Gaps

Walkthrough gaps that bind the UI, plus gaps found only while deriving it. **Identified, not
implemented.**

| # | What UI needs | Why | Data exists? | API? | Workaround safe? | Backend change | Priority |
|---|---|---|---|---|---|---|---|
| **G-UI-1** (W-G1) | Tell the operator their projection is stale | The preview mints `previewToken` on every response; `checkStaleness` is fully implemented and **has no route**. The SDS documents "re-submit the token" as a working capability. | ✓ | **✗** | **No** — the client cannot verify its own token | expose `POST /schedules/preview/staleness`, mirroring bulk-unassign's `409 TOKEN_STALE` + `freshPreview` | **High** |
| **G-UI-2** | Show component-blocked and unrankable counts on the cockpit | Two of six funnel populations are invisible on the live surface; they exist only per run | ✓ on `dispatch_run_zones` | ✗ on `/dispatch/today` | **No** — scraping the run detail mixes per-run with per-day figures | add both to `TodaySituation` | **High** |
| **G-UI-3** (W-G3) | A ZM must see the next run time and whether a run is in flight | `dispatch-schedule` is OH-only, `in-flight` is OH/CSM. A ZM's cockpit cannot explain an empty deck at 04:55. **D3 makes this worse**: 05:00 is configurable, so the UI cannot hardcode it either. | ✓ | wrong role | **No** | read-only `GET /schedules/dispatch-schedule/next` for `MANAGER_ROLES`; widen in-flight, zone-clamped | **High** |
| **G-UI-4** (W-G4) | "This run ranked on data computed at HH:MM" | `bucketsAsOf` is computed on **every** run and returned only on a dry run | ✓ computed, discarded | ✗ | **No** | add to `RunSummary`; persist on `dispatch_run_zones` | **High** |
| **G-UI-5** | "Why is this ticket here?" from the ticket drawer | A trace is only addressable inside its run; there is no `GET /tickets/:id/decision` | ✓ | ✗ | Partial — reach it from Replay or a batch row instead | a ticket-scoped latest-decision read | Medium |
| **G-UI-6** (W-G8) | "Show me every override in this zone this week" | Only bulk-unassign history and the (blind) intra-day queue exist. `changes-today` covers **today, this zone, assignments only**. | ✓ in `audit_logs` | ✗ | **No** | `GET /audit?entityType&action&zoneId&from&to` | Medium |
| **G-UI-7** (W-G9) | "This run is alive" vs "about to be reaped" | `heartbeat_at` is the reaper's own input and is on neither run DTO | ✓ | ✗ | **No** | add `heartbeatAt` + derived `staleForMs` | Medium |
| **G-UI-8** | A name for the actor of a change | `changes-today.actorId` is a bare UUID; `fromSeId`/`toSeId` too | ✓ | ✗ | Partial — resolve SEs via `/schedules/engineers`; **managers have no lookup** | add `actorName`, or a manager-name endpoint | Medium |
| **G-UI-9** (W-G7) | Filter states in the Assign Console | The console shows `PASSED`/`DROPPED` + one reason; the trace shows all five tri-state. Two vocabularies for one engine. | ✓ (pure fns) | ✗ on `/candidates` | Partial — the column is still useful | add `filterStates[]` to `CandidateRow` | Low |
| **G-UI-10** (W-G10) | Per-zone durations | `dispatch_run_zones.started_at/finished_at` exist; the card omits both | ✓ | ✗ | **No** | add both | Low |
| **G-UI-11** (W-G11) | The unrankable count on a preview | `bucketlessDropped` is on `RunSummary`, not `ZoneProjection` | ✓ | ✗ | **No** | add to `ZoneProjection` | Low |
| **G-UI-12** (W-G13) | A date-scoped schedule detail | `/schedules/:engineerId` has no date predicate; `/schedules` gained `?date=` | ✓ | ✗ | Partial — show `dateFrom/dateTo` and warn when past | accept `?date=` | Low |
| **G-UI-13** (W-G6) | "Your pin was not used, because…" | A pinned SE dropped by a filter is silently skipped; nothing records it | ✗ **not recorded** | ✗ | **No** | persist `plannerPinnedButDropped[]` on the trace | Low |
| **G-UI-14** | Notification delivery state | An SE may not know their plan changed; no screen can say so | ✓ on the outbox | ✗ | **No** | expose exhausted outbox rows | Low |
| **G-UI-15** | "The scheduler is switched off" | `businessSweepsEnabled` is only inside a past run's snapshot — and if sweeps are off there is no run to read | ✓ | ✗ | **No** | fold into G-UI-3's read | Low |
| **G-UI-16** | A zone list for the picker (C1) | `/dispatch/today` needs a `zoneId`; no zone-list endpoint on that controller | ✓ | **workaround exists** | **Yes** — derive from `/planner/plants` or `/schedules/engineers`, both manager-roled and already used | a proper `GET /zones` for managers would be cleaner | Medium |
| **G-UI-17** | The SE-assignment threshold in force **for this run** | #238 added the column precisely so *"a historical zone card can be read without inferring the config from the run's snapshot"* — and the card does not carry it. Without it, `recommended: 40` out of a 900-ticket backlog is un-interpretable: a catastrophe at 24 h, correct at 72 h. | ✓ persisted on `dispatch_run_zones` | **✗ absent from `DispatchRunZoneCard`** | Partial — `configSnapshot.settings.se_assignment_threshold_hours` carries the **run-level** value, which is right for a single-zone run and wrong the moment the setting changes mid-run | add `assignmentThresholdHours` to the zone card | Medium |

### 35.1 The four gaps that block a *correct* UI

**G-UI-1** (a documented capability that does not exist), **G-UI-2** (two funnel populations invisible
where they matter), **G-UI-3** (a ZM cannot learn when the run fires — and cannot infer it, because
the hour is configurable), **G-UI-4** (a run cannot state its own data staleness while its preview
can).

Everything else can be worked around or deferred without the UI telling a lie.

---

## 36. Open Questions

| # | Question | Why it matters | Who decides |
|---|---|---|---|
| Q1 | Should the cockpit's zone picker default to a remembered zone, or force an explicit choice each session? | The backend refuses to guess on purpose. A sticky default is friendlier; an explicit choice is truer to *"'all zones' is not a cockpit"*. | Product |
| Q2 | Should `Run dispatch` be zone-scoped by default from the cockpit, or offer "all zones"? | `POST /dispatch-run` accepts an optional `zoneId`. From a one-zone cockpit, scoping is obviously right — but the only existing trigger (bulk-unassign) is pan-India by default. | Ops |
| Q3 | Is `/intraday` retired, or repointed at `changes-today`? | The page is a permanent empty state either way. Retiring loses a nav row an operator may have bookmarked. | Product |
| Q4 | Does `plannerBias`'s `passed[0]` baseline need correcting before the UI leans on it? | It reads "differed from precedence", which can over-report (§14.3). The badge is already shipped. | Backend + Product |
| Q5 | Should the score breakdown be default-open or default-collapsed when **not** degenerate? | It is six rows of arithmetic. Collapsed is calmer; open is more explanatory on the screen whose whole purpose is explanation. | UX |
| Q6 | Should the Assign Console adopt `TIER_NOT_REACHED`? | Deliberately excluded (a human may cross tiers) — but a manager comparing the console to a trace sees two vocabularies. | Backend (#272 R6 owner) |
| Q7 | What does a ZM see where `Run dispatch` would be? | Nothing, a disabled control with an explanation, or a "request a run" affordance that does not exist? | Product |
| ~~Q8~~ | ~~Should `assignmentThresholdHours` render on the zone card?~~ | **Resolved during this investigation:** it is persisted and **not exposed**. Now **G-UI-17**, not an open question. | — |
| Q9 | Acting-zone banner wording on the four non-acting-aware reads (§4.3)? | Until #239 lands, the UI must say which reads ignore the acting zone without implying they are broken. | UX + #239 owner |

---

## 37. Recommended Final Scheduler UI Architecture

```
NAVIGATION

Operations
  ├── Zone Dashboard                /
  ├── Tickets                       /tickets
  ├── Assign Work                   /assign                    ◄── the work pool + commit
  ├── SE Planner                    /engineers/planner         ◄── the soft-bias pin
  └── … (install, SE activity, verification, readiness, cross-zone, …)

Dispatch                                                       ◄── the scheduler cluster
  ├── Today's Dispatch              /dispatch/today            ◄── PRIMARY SCREEN
  │     "What is happening now"           ?mode=plan|live|replay  &zoneId=
  ├──   Scheduler Preview           /schedules/preview         ?date= &se=
  │     "What the next run would do"
  ├──   Schedules                   /schedules?date=
  │     "Committed day plans"          └── /schedules/:engineerId   ◄── THE OVERRIDE SURFACE
  └──   Dispatch Runs               /dispatch-runs
        "What past runs did"           └── /:runId
                                            └── /zones/:zoneId
                                                 └── /batches/:batchId

Policy   (CSM + OH)
  └── SE Assignment Threshold       /assignment-threshold

Admin    (OH only)
  ├── Bulk Unassign                 /bulk-unassign
  └── Settings → Dispatch schedule  /settings

REMOVED:  Intra-day Queue  /intraday        (structurally blind — §5.4)


PRIMARY SCHEDULER SCREEN — /dispatch/today
  ├── Plan    → links to the projection · Run dispatch (CSM/OH)
  ├── Live    → crew lanes + 4 rails + recovery notice + critical interception
  └── Replay  → decision stream in processing order → per-ticket trace

SECONDARY VIEWS
  ├── Scheduler Preview   the projection + holds
  ├── Schedule Detail     the six override actions + impact preview
  ├── Assign Work         pool → candidates → distribute → review → commit
  └── Dispatch Runs       the historical ledger and all evidence
```

### 37.1 Why this is the smallest structure that fully represents the engine

The engine has exactly **four tenses** (§3.2) and **three kinds of human action** (assign, override,
hold). This architecture gives each tense one surface and each action one home:

| Engine concept | Surface | Could it be merged? |
|---|---|---|
| the projection | Scheduler Preview | **No** — it is date-addressable and must never read as a commitment |
| the live day | Today's Dispatch | **No** — it is the only surface that answers "now" |
| the committed plan per engineer | Schedule Detail | **No** — it is where the six override actions live and they need one engineer's whole route |
| the historical ledger | Dispatch Runs | **No** — evidence is immutable and separately addressable |
| handing out work | Assign Work | **No** — a multi-step drafting workflow |
| the pin | SE Planner | **No** — it is a grid over dates × plants, not a scheduler view |

**Six surfaces for six concepts.** Everything else — zone views, capacity, holds, distribution,
recovery, audit, score explanation — is a **panel, rail, drawer or badge inside one of them**, because
none of them is a destination an operator navigates *to*; each is context they need *while* doing
something else.

**The three merges this architecture makes**, each justified by the backend:

1. **Zone view is not a page.** The live case *is* the cockpit; the historical case is a card inside a
   run. Two different questions, neither a standalone destination.
2. **Engineer capacity is not a page.** There is no capacity endpoint — `committed/dailyCapacity`
   rides on six reads and belongs beside the decision being made.
3. **Holds are not a page.** A hold is one date column; its actions belong where the work is.

**And one removal:** Intra-day Queue reads an audit action no admin code writes.

---

## 38. Implementation Readiness Assessment

### 38.1 Is the backend sufficiently exposed?

**For the recommended architecture: yes, with four caveats.**

| Surface | Backend ready? | Blocker |
|---|---|---|
| Today's Dispatch — Live | ✓ | needs a zone list for the picker (**G-UI-16**, workaround exists) |
| Today's Dispatch — Plan | ✓ | — |
| Today's Dispatch — Replay | ✓ | — |
| Scheduler Preview | ✓ | staleness is **not buildable** (**G-UI-1**) |
| Schedules + Detail | ✓ | no date predicate on detail (**G-UI-12**) |
| Dispatch Runs → Zone → Batch → Trace | ✓ | `bucketsAsOf` and heartbeat missing (**G-UI-4**, **G-UI-7**) |
| Assign Work | ✓ | `filterStates` absent from `/candidates` (**G-UI-9**) |
| Score breakdown | **✓ fully** | **the data ships today; only the client is missing (F3)** |
| Filter states in the trace | **✓ fully** | **ships today; client missing (F4)** |
| Overrides + impact | ✓ | — |
| Holds | ✓ | — |
| Distribute | ✓ | — |
| Recovery / exceptions | ✓ | notification failures invisible (**G-UI-14**) |
| A fleet-wide overview | **✗** | no aggregate read (**W-G2**) — not in this architecture, deliberately |

### 38.2 What can be built today with no backend change

1. **F1** — the zone picker (unblocks two of three roles).
2. **F2** — the Run dispatch control on the cockpit.
3. **F3** — the score breakdown table. *The richest single improvement available: the engine's own
   arithmetic is persisted, served, and currently thrown away.*
4. **F4** — the per-candidate filter-state strip.
5. **§14.2** — tier-grouped candidate ranking, replacing any flat list.
6. **C4** — pass `?date=` to `/schedules`.
7. **§5.4** — retire `/intraday`.
8. **F5/F6** — the inert `?zoneId=` link param and the stale docstring.

### 38.3 What is blocked

| Blocked | On |
|---|---|
| preview staleness | G-UI-1 |
| component-blocked / unrankable on the cockpit | G-UI-2 |
| a ZM's "next run" | G-UI-3 |
| run-level data-staleness | G-UI-4 |
| "why" from a ticket page | G-UI-5 |
| historical override audit | G-UI-6 |
| run liveness | G-UI-7 |
| actor names on the change ledger | G-UI-8 |

### 38.4 Quality-bar answers

**A manager opens the Scheduler UI.** ✓ `GET /api/dispatch/today?zoneId=` — every field mapped in
§26.1, every KPI defined in §16, staleness in §24, unassignable in §7.9, what needs action in §7.6
and §22. **Caveat: a CSM/OH cannot open it at all today (F1).**

**A manager clicks a ticket.** ✓ `GET /api/dispatch-runs/:runId/tickets/:ticketId/trace` gives what
happened, why it was selected, why others lost, which tier, which filters failed, each candidate's
score, and whether a pin changed it. **Two of those — the score *components* and the per-candidate
filter states — are served and unrendered (F3, F4).** The panel must state the top-5 bound (§13.2).

**A manager changes an assignment.** ✓ §19.1 gives preview-required per action, the endpoint, the
confirm, both conflicts, the response, and the refresh set (§27). **Two traps documented: the
returned ids are the *source* for REASSIGN/SPLIT (§19.4), and a 404 may mean "somebody else got there
first" (§30.3).**

**The scheduler fails.** ✓ §22 distinguishes all nine states — failed run, failed zone, abandoned
(`ABORTED`) run, recovery pending/recovered/exhausted/expired, contention, and stale eligibility —
each with its owner and its available action. `ABORTED` must not be styled as `FAILED`.

**The backend does not expose something.** ✓ `NOT AVAILABLE FROM CURRENT API` appears **19 times**,
and §35 lists 16 gaps with "can the frontend work around it safely?" answered for each. Nothing is
invented.

### 38.5 Suggested sequence

```
Phase 1 — unblock (no backend change)
  F1 zone picker · F2 run trigger · C4 ?date= · F5/F6 cleanup · retire /intraday

Phase 2 — explainability (no backend change)   ◄── highest value per unit of work
  F3 score breakdown · F4 filter-state strip · §14.2 tier-grouped ranking
  → the engine's reasoning becomes fully legible with zero backend work

Phase 3 — backend gaps, in priority order
  G-UI-1 staleness · G-UI-2 cockpit counters · G-UI-3 ZM next-run · G-UI-4 bucketsAsOf

Phase 4 — depth
  G-UI-5 · G-UI-6 · G-UI-7 · G-UI-8
```

### 38.6 Two prerequisites outside this spec

1. **The working tree does not compile.** `apps/backend/src/scheduling/scheduler-preview.service.ts:221`
   carries an uncommitted stray edit — an unterminated string literal (`tsc` reports `TS1002`). HEAD
   is clean. Until it is reverted, the preview and holds surface cannot be built or run.
2. **Acting-zone is inconsistent** across `/schedules` (§4.3). Until #239 lands, the UI must state
   which reads ignore the acting zone rather than silently mixing scopes.

---

*End of specification.*
