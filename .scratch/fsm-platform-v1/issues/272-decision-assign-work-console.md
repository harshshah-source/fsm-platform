# 272 — DECISION RECORD: the Assign Work Console is the approved manual-assignment UI direction

Status: **APPROVED 2026-08-20** (operator). This file is the authoritative record; implementing
issues are #273–#277.
Type: HITL · Decision · Backend + Admin
Design: [`docs/ui/desktop/approved-designs/assign-work-console.html`](../../../docs/ui/desktop/approved-designs/assign-work-console.html)
(in-repo, authoritative) · published copy: https://claude.ai/code/artifact/369ddf01-b727-4d9b-b086-00714480bb74

**Nothing in this file is speculative. This is a final approved UI direction.** Do not reopen unless
code reveals a direct contradiction that makes the approved behaviour impossible without a new
business decision. Do not redesign the console; build it.

## What was approved

One console — **Assign work** — replaces the scattered manual-assignment surfaces. Route `/assign`,
opened by the existing top-bar **Assign SE** button (which today calls `navigate('/')` and opens
nothing). Three columns over one running ledger, one commit:

- **Work pool** (left) — company → plant → device, each plant row carrying
  `open unassigned / total devices`, critical+ count, oldest silent age, held count.
- **Draft plan** (centre) — one lane per engineer, each lane holding work chips from **any number of
  plants**. Coverage tier is badged **per (engineer, plant)**, not per engineer. Load reads
  `committed → after-draft / capacity`. A "no eligible engineer" rail holds what cannot be placed.
- **Candidates** (right) — `orderedCandidatesForPlant` rendered honestly: tier-grouped in
  DEDICATED → MULTI_PLANT → FLOATING order, **including** the engineers the hard filters dropped and
  the reason each was dropped.
- **Ledger** (header) — `open unassigned · in this draft · left after commit · critical+ in draft`,
  recomputed as chips move. This is the approved answer to "how many devices are left".
- **Review & commit** — a diff, not a confirm dialog: per-engineer before→after load, coverage used,
  tier crossings, over-capacity, and what is still unassigned afterwards. One mandatory reason.

## The rulings

- **R1 — The console is the single manual-assignment surface.** Seven surfaces can move work to an
  engineer today; that is how the product arrived at zero of them showing counts. New manual
  assignment UI belongs in the console, not in a ninth place.
- **R2 — Nothing is written until commit.** Selection builds a draft; the draft is projected, not
  persisted. This is what makes "left after commit" a live number instead of a post-hoc toast. The
  current `assignPlants` behaviour — a ticket-by-ticket loop with no preview and no enclosing
  transaction — is superseded for the console path (#275).
- **R3 — One predicate for "assignable".** The count shown must be the count the button moves.
  `assignPlants` writes `status='OPEN' AND assignment_state='UNASSIGNED' AND NOT deferred`;
  `plantDeviceStats` counts by `assignment_state` with **no status filter**. These must not both
  feed the console. One extracted shared predicate, used by the read and the write (#273).
- **R4 — Coverage is shown per (engineer, plant).** The global `engineer_master.coverage_type` is
  not an answer to "does this engineer cover this plant"; `se_coverage.coverage_type` is. A lane
  spanning two plants shows two badges when they differ.
- **R5 — Capacity is visible, never a gate.** Inherits **#258 Q2** verbatim: over-capacity engineers
  stay selectable, are visibly marked, and there is **no block and no forced confirm**. The console
  states the overload in words on the review screen and lets it through.
- **R6 — Tier precedence is displayed, and crossable by a human.** Inherits **#258 Q1**: the
  candidate column always renders DEDICATED → MULTI_PLANT → FLOATING in that order, so the operator
  sees the tier they are crossing. Crossing is permitted and marked; it is never blocked.
- **R7 — No map, no ETA, no route line.** Inherits **#258 Q6** (no live GPS in Phase 1). Distance,
  when #267 lands, appears as a candidate attribute — not as geography.
- **R8 — Commit is per-engineer-transactional and reports per engineer.** A lane that fails is
  legible and re-runnable while the rest stand. No aggregate success toast over a partial write.
- **R9 — The console consumes #269's capacity payload; it does not define a second counter.** #269
  remains "existing pages, no redesign" and is the instrumentation this console was written for.
  There is exactly one definition of "committed day load".

## Visual grammar (non-negotiable, must survive grayscale)

Carried forward from the dispatch-board grammar so the two boards read as one product:

| Meaning | Form |
|---|---|
| Assignment inside the engineer's own coverage | solid border + dot |
| A human crossed a coverage tier | dashed border, violet |
| Critical work | heavy crimson border + flag |
| Over capacity | amber lane treatment — a state, never a barrier |

Never the same shape for two meanings. Tokens come from `apps/admin/src/index.css`; the design file
uses them directly.

## Constraints this direction inherits

From **#258**: Q1 (tier precedence), Q2 (capacity is not authorization), Q6 (no live GPS Phase 1).
From the repo: the RBAC ladder (preview + holds = all manager roles, server zone-clamped;
`POST dispatch-run` = OH + CSM; bulk-unassign = OH only; assign/override = all managers) — the
console must not widen it. `#243` dev-data cleanup stays HITL-gated and untouched by this work.

## Sequencing — the console cannot land before its numbers are true

| Hard prerequisite | Why |
|---|---|
| **#178** | Closure never clears assignment state; until it does, `committedDayLoad` overcounts and the load column lies. |
| **#269** | Owns the one `{committed, dailyCapacity}` payload. A second counter here would fork the definition. |
| **#266** | Score currently decides nothing (`chosen = planner ?? passed[0]`, `recommender.service.ts:466`). Rendering a candidate order the engine does not use teaches the operator a false model. |
| **#262** | Per-SE dispatch transactions — the transaction shape `assign-batch` must match, or the two produce competing strategies over the same tables. |
| **#265** | Clean 409s for lost manual races — the console makes concurrent manual assignment far more likely. |
| **#250** | The dry-run seam **Distribute** projects through, instead of a second copy of selection logic in the client. |

## Implementing issues

`#273` work pool + ledger · `#274` candidates + capacity · `#275` assign-batch + commit review ·
`#276` Distribute · `#277` absorb the orphaned surfaces. Build order and prereqs in
[`INDEX.md`](../INDEX.md) § P9.

## Evidence behind the approval (verified 2026-08-20, working tree)

Read directly, not inferred. Re-verifying these wastes a session:

- **`shell/TopBar.tsx:154`** — the one red primary button on every screen is `onClick={() =>
  navigate('/')}`. The v2 reference (`12-batch-schedule-review.png`, `16-se-planner.png`) shows it as
  the manual-assignment entry point.
- **`reports/AssignSePanel.tsx`** — N plants → 1 SE. `DeviceFilterOptions.plants` is
  `{plantId, name, companyId}`: **no counts**. `PlantAssignSummary.perPlant[].openUnassigned` exists
  but is computed inside the write loop, so it can only ever be reported after the fact.
- **`ScheduleDetailPage.tsx` `SePicker`** — renders `e.name` and nothing else. `ZoneEngineer` already
  carries `dailyCapacity`; it is rendered in **zero** places, here or anywhere.
- **`dashboard/CriticalQueue.tsx`** — imported by no file. Already contains an engineer picker,
  one-click assign and `DeferralConfirm`. → absorbed by #277.
- **`intraday-insertion.controller.ts:93`** — `GET :id/available-ses` returns `string[]` of bare
  UUIDs, and **no admin client calls it**; `POST :id/manual-assign` likewise has no UI. → #277.
- **`planner/PlannerPage.tsx`** — the Engineer column renders the raw `engineerId` UUID where
  reference 16 shows a name; no `LOAD / CAP` column, which reference 16 specifies. → #277 (name),
  #269 (load/cap).
- **`dispatch-transparency-query.service.ts:496-527`** — `plantDeviceStats` has no status filter.
  **`override.service.ts:466-471`** — `assignPlants` filters `OPEN` + `UNASSIGNED` + `notDeferredOn`.
  The R3 mismatch, measured.
- **`recommender/candidate-selection.service.ts:23-53`** — `orderedCandidatesForPlant` is the exact
  per-plant eligibility answer, tier-ordered, with the FLOATING leg re-validated live against
  `engineer_master` (#138). Backend-only today.
- **`recommender.service.ts:455`** — `overCapacity` is computed for the automatic path only. Every
  manual path ignores capacity and nothing displays it (#269's own finding).

## Open, and deliberately not ruled here

Three calls raised in the design and left to the operator. None blocks #273; each is answered before
the issue that needs it. **One of the three is now ruled** — see Q2.

1. **Does the console replace the Device Detail panel, or sit beside it?** Recommendation on file:
   the panel stays as a shortcut that deep-links into the console pre-scoped to that device's plant.
   Needed before #277.
2. ~~**Is a draft persistent across sessions?**~~ **RULED 2026-08-20 (operator): session-local for
   v1**, said plainly on screen. No table, no migration, no owner, no staleness rule. A shared,
   resumable draft was considered and rejected for v1 — it needs its own table, an owner, and a
   reconciliation rule for when the underlying tickets move out from under it. #273 builds to this;
   do not invent persistence.
3. **Does the Zonal Manager get Distribute, or only OH + CSM?** The existing ladder already splits
   preview/holds (all managers) from `dispatch-run` (OH + CSM); Distribute is closer to a dispatch
   run than to a single assignment. Needed before #276.
