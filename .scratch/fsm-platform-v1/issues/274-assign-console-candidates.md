# 274 — Assign Work Console S2: the candidate column — who can cover this plant, and can they carry it

Status: done (2026-08-21)
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

- [x] The candidate list for a plant is byte-order-identical to `orderedCandidatesForPlant` for that
      plant (asserted by calling both in one test).
- [x] `verdict`/`dropReason` for a candidate equals what `applyHardFilters` produces for the same
      readiness input — one shared call, asserted, not two implementations.
- [x] A dropped candidate is **present** in the response with its reason, not omitted.
- [x] `committed` equals #269's figure for the same engineer and day (shared-predicate assertion, the
      same pin #269 carries).
- [x] An over-capacity engineer is marked **and** can be selected; the resulting assignment returns
      200 with no confirm step and no extra audit requirement (Q2 regression pin).
- [x] A lane holding two plants at different tiers renders two coverage badges.
- [x] Selecting a FLOATING candidate while an eligible DEDICATED candidate exists marks a tier
      crossing and does not block.
- [x] A ZM sees candidates only for plants in their own zone.

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

## Corrections / found while building

**1. The design mock tags its over-capacity candidate `PASSED`. The endpoint reports
`DROPPED · OVER_CAPACITY`, and that is deliberate.** The mock's own Q2 note calls capacity
*"a scheduler constraint, not an authorization limit"* — which describes exactly a candidate the
scheduler drops — and AC-2 requires the verdict to be `applyHardFilters`' verdict rather than a second
opinion. Softening it for this one filter would make the column lie about dispatch in order to say
something the adjacent marking already says truthfully. **Selectability is what makes overload an
administrative right**, so the row carries both: `DROPPED · at or over capacity` *and*
"over capacity — still assignable", with nothing disabled. Pinned on both sides (backend AC-5 spec,
admin A2).

**2. Sharing `applyHardFilters` was never going to be enough, and the AC as written would have passed
anyway.** That function is pure and takes readiness *as given*, so two callers can agree perfectly on
the rule while feeding it two different readings of the same engineer — one calling an SE with no
`engineer_master` row "over capacity", the other not; one treating `SOFT_UNAVAILABLE` as available, the
other not. The **readiness construction** was the fork risk, and it lived inline in
`recommender.service.ts:538-555`. Extracted to `src/recommender/candidate-readiness.ts`
(`buildCandidateReadiness`) and **the engine moved onto it**, so the seam is real rather than
decorative. AC-2's test asserts the stronger property this makes available: the published row cannot
contradict its own published facts — no row can read `ON_LEAVE` and `PASSED`, or `12 / 8` and `PASSED`.

**3. `TIER_NOT_REACHED` is deliberately not a verdict on this endpoint.** #266 added it to the dispatch
trace, where one ticket is being placed and a lower tier is consulted only when every higher one failed.
This column places nothing and a human may cross tiers on purpose (R6), so a never-reached tier would
be a rejection the operator's own decision has not yet made.

**4. A tier crossing must be measured against the best *passing* tier at that plant, not against
`tierRank` in the abstract.** A floating engineer taking a plant whose only dedicated candidate was
dropped has overridden nothing — floating is the top of the reachable list there. A naive
`tierRank > 1` rule flags both cases and trains the operator to ignore the marking on the occasions it
means something. Both branches are pinned in one test.

**5. A malformed candidates payload took down the entire console** — pool, ledger and Commit button
included — because `candidateView.plants` was read unguarded. That defeats this issue's own rollback
story ("hide the column; the console degrades to #273's behaviour"). Guarded in both the column and
the lane coverage helper: the column is additive, so an odd read costs the column and nothing else.
Found by #273's own spec, which had never needed to stub this endpoint before.

**6. The `*/` docblock trap fired again**, in `**R4**/**R5**` — the same content-character class as
#273's `**R1**/**R3**`. `src/ticketing/` is not the only place this bites; it is any prose docblock in
this repo that pairs bold markers with a slash.

**7. The #272 grammar's violet has no token in the admin theme.** The legend defines the crossing
marker as *"dashed — a human crossed a coverage tier"*, so the **dash** is the load-bearing half and is
what was implemented, plus `data-tier-crossing` and a `title`. No palette entry was invented for one
badge; a colour-only treatment would also have told a screen reader nothing (the `LoadBadge` precedent).

**8. AC-1 survived as written, unlike #273's equivalent.** #273's "call both and compare" AC went
tautological the moment both sites imported one predicate. Here the HTTP layer is a genuine
re-ordering opportunity — it could sort by name for the operator's convenience, group by tier and lose
the within-tier `se_id` order, or drop the tail — so calling `orderedCandidatesForPlant` beside the
endpoint really can disagree, and the fixture is asserted to populate all three tiers so a tier-losing
implementation cannot pass on a one-tier plant.

**9. Three of the five backend tests were green on arrival** (B3 committed-equivalence, B4 zone clamp,
B5 over-capacity), because earlier slices' implementation already satisfied them. Each had its
sensitivity **verified rather than assumed**, by breaking the thing it claims to protect:

| Test | Break applied | Red produced |
|---|---|---|
| AC-4 committed | count **batches** not stops — #269's own `ZmScheduleRow.ticketCount` error | `expected 1 to be 3` |
| AC-8 zone clamp | drop `zoneClamp` from the plant `where` | `expected ['2','3'] to equal ['2']` |
| AC-5 over capacity | `>` instead of `>=` at the boundary | `expected 'PASSED' to be 'DROPPED'` |

**10. Selection got a concrete meaning.** "Can be selected" needed a behaviour, not an
`aria-disabled` assertion. Clicking **Assign** on a candidate puts that engineer on a lane holding the
focused plant — reusing their existing lane if they have one, so a second lane for the same engineer
can never split their load and make each `→ after / cap` figure wrong. The pool row's plant *name*
became the focus control, kept separate from its checkbox: ticking drafts a row, clicking its name
asks "who can cover this?".

## Rollback

Read-only additive endpoint + one column. Hide the column; the console degrades to #273's behaviour.
