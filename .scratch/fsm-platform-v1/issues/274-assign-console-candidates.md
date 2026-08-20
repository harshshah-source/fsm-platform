# 274 — Assign Work Console S2: the candidate column — who can cover this plant, and can they carry it

Status: ready-for-agent
Type: AFK · Backend + Admin
Decision: #272 **R4** (coverage per engineer-and-plant), **R5** (capacity visible, never a gate),
**R6** (tier precedence displayed, crossable), **R9** (one capacity counter) · inherits #258 **Q1**, **Q2**

## Objective

Before an operator drops work on an engineer, the console answers three questions on screen: does
this engineer cover *this plant* and at which tier, how loaded are they already against capacity, and
if the engine would not have picked them — why not.

## Current behaviour (verified)

- `orderedCandidatesForPlant` (`recommender/candidate-selection.service.ts:23-53`) is the exact
  per-plant eligibility answer: DEDICATED and MULTI_PLANT from `se_coverage`, FLOATING from the
  `plant_eligible_floating_se` MV **re-validated live** against `engineer_master` (#138). It is
  backend-internal; no admin surface can reach it.
- `applyHardFilters` runs over `SeCandidateReadiness` and produces `{passed, dropped}` with a reason
  per dropped candidate; drop **counts** are persisted to the trace, dropped rows never are
  (`recommender.service.ts:472-475`).
- Every manual picker shows a name and nothing else. `ZoneEngineer.dailyCapacity` and
  `EngineerListRow.dailyCapacity` are both populated and rendered in **zero** places.
- `AssignSePanel` shows the engineer's **global** `engineer_master.coverage_type` — which for a
  MULTI_PLANT engineer says nothing about whether they cover the plants being assigned. The per-pair
  value is `se_coverage.coverage_type` (`schema.prisma:299-312`, unique on `(seId, plantId)`).
- `intraday-insertion.controller.ts:93` `GET :id/available-ses` returns `string[]` of bare UUIDs —
  the same information gap in the intra-day path (owned by #277).

## Required change

1. **Backend read** `GET /api/schedules/candidates?plantIds=1,2,3` (manager roles, zone-clamped).
   Per plant, the ordered candidate list with, per candidate:
   `{seId, name, coverageType, tierRank, verdict: 'PASSED' | 'DROPPED', dropReason, committed,
   dailyCapacity, availabilityStatus, kitComplete, missingKit}`.
   - Order is `orderedCandidatesForPlant`'s order, unchanged — DEDICATED → MULTI_PLANT → FLOATING.
   - `verdict` / `dropReason` come from the **same** `applyHardFilters` the engine runs, not a
     re-implementation.
   - `committed` / `dailyCapacity` come from **#269's payload** (R9) — this issue defines no counter.
   - Dropped candidates are **returned, not filtered out**. The operator's question is "why not
     them", and an empty list is the least useful possible answer to it.
2. **Candidate column** (right) — tier-grouped with the rank shown, dropped candidates rendered
   muted with their reason, over-capacity candidates marked and **still selectable** (R5 / Q2).
   Focus follows the plant or chip the operator is working on.
3. **Per-(engineer, plant) coverage badges on lanes** (R4). A lane spanning two plants shows two
   badges when the tiers differ. A lane whose coverage for a plant is weaker than an available
   higher tier is marked as a **tier crossing** — dashed/violet per the #272 grammar — never blocked.
4. **Load on lanes** — `committed → after-draft / capacity`, amber lane treatment when the
   after-draft figure exceeds capacity. A state, not a barrier.

## Existing code to reuse

`orderedCandidatesForPlant` · `applyHardFilters` + `SeCandidateReadiness` · `ensureKitStatus` /
`ensureAvailability` memoisation (`recommender.service.ts:439-457`) · #269's committed-load function ·
`Badge` tones from FE-04 · the console shell from #273.

## Data model / API

No schema change. One new GET. No write.

## UI surfaces

Admin: `/assign` candidate column, lane headers (coverage badges + load). Mobile: none.

## Reference

`docs/ui/desktop/approved-designs/assign-work-console.html` — wireframe 1, right column and lane
headers. Tier grouping, the muted dropped rows, and the "over capacity — still assignable" marking
are all load-bearing, not decoration.

## Acceptance criteria

- [ ] The candidate list for a plant is byte-order-identical to `orderedCandidatesForPlant` for that
      plant (asserted by calling both in one test).
- [ ] `verdict`/`dropReason` for a candidate equals what `applyHardFilters` produces for the same
      readiness input — one shared call, asserted, not two implementations.
- [ ] A dropped candidate is **present** in the response with its reason, not omitted.
- [ ] `committed` equals #269's figure for the same engineer and day (shared-predicate assertion, the
      same pin #269 carries).
- [ ] An over-capacity engineer is marked **and** can be selected; the resulting assignment returns
      200 with no confirm step and no extra audit requirement (Q2 regression pin).
- [ ] A lane holding two plants at different tiers renders two coverage badges.
- [ ] Selecting a FLOATING candidate while an eligible DEDICATED candidate exists marks a tier
      crossing and does not block.
- [ ] A ZM sees candidates only for plants in their own zone.

## Tests

Backend: order-equivalence and filter-equivalence unit tests; e2e for zone clamp, dropped-candidate
inclusion, capacity figure agreement with #269. Admin: component tests for tier grouping, dropped
rendering, over-capacity selectable, two-badge lane, tier-crossing marking.

## Dependencies / Blocked by

- **#273** — the console shell and lanes this column attaches to.
- **#269 (hard)** — owns `{committed, dailyCapacity}`. Building a counter here forks the definition.
- **#178 (hard, via #269)** — `committedDayLoad` overcounts until terminal closes clear assignment
  state, so the load column would display an inflated number as fact.
- **#266 (hard)** — selection is `chosen = planner ?? passed[0]` (`recommender.service.ts:466`);
  score decides nothing today. Rendering a candidate order as "what the engine would do" before #266
  lands teaches the operator a false model of the system.

## Risks

Medium. The failure mode is subtle rather than loud: a re-implemented filter or capacity count that
*looks* right and disagrees with the engine under load. Every equivalence AC above exists for that.

## Rollback

Read-only additive endpoint + one column. Hide the column; the console degrades to #273's behaviour.
