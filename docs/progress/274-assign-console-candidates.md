# #274 — Assign Work Console S2: the candidate column (TDD completion report)

**Date:** 2026-08-21 · **Branch:** `feat/autoplant-integration` · **Type:** AFK · Backend + Admin
**Issue:** [`.scratch/fsm-platform-v1/issues/274-assign-console-candidates.md`](../../.scratch/fsm-platform-v1/issues/274-assign-console-candidates.md)
**Design (authoritative):** `docs/ui/desktop/approved-designs/assign-work-console.html` — wireframe 1,
right column and lane headers.
**Sequenced as:** P9 slice 3 of 6, behind #273 ✅ · #269 ✅ · #178 ✅ · #266 ✅ (all four hard).

> Frozen once written, per the progress convention. Corrections go to INDEX / SYSTEM-STATE.

## What was wrong

`orderedCandidatesForPlant` is the engine's exact per-plant eligibility answer — DEDICATED and
MULTI_PLANT from `se_coverage`, FLOATING from the `plant_eligible_floating_se` MV re-validated live
against `engineer_master` (#138). `applyHardFilters` is the engine's exact readiness verdict, with a
reason per dropped candidate. **Both have been backend-internal for their entire life.** No admin
surface could reach either, and the drop *rows* were never persisted anywhere — only the counts reach
the trace, so a dropped candidate existed for a few milliseconds inside one run and was seen by nobody.

What the operator got instead: every manual picker in the app shows a name and nothing else, and the
one surface that shows coverage (`AssignSePanel`) shows the engineer's **global**
`engineer_master.coverage_type`, which for a multi-plant engineer says nothing about whether they
cover the plants being assigned.

## The equivalence that mattered was not the one the AC named

AC-2 asked for `verdict`/`dropReason` to come from "the **same** `applyHardFilters` the engine runs,
not a re-implementation". Sharing that function is necessary and **not sufficient**: it is pure and
takes readiness *as given*, so two callers can agree perfectly on the rule while handing it two
different readings of the same engineer. One could call an SE with no `engineer_master` row "over
capacity" and the other not; one could treat `SOFT_UNAVAILABLE` as available and the other not. Both
would pass a test that compares `applyHardFilters` output to `applyHardFilters` output.

The fork risk was the **readiness construction**, and it lived inline at `recommender.service.ts:538`.
It is now `src/recommender/candidate-readiness.ts` → `buildCandidateReadiness`, and **the engine was
moved onto it** so the seam is real rather than decorative. The only difference between the two
callers is the counter: a live run passes its in-run `assigned` tally, a read passes #269's
`committedDayLoad`, and NEW-A1 seeds the first from the second so they start equal.

That made a stronger assertion available than "call both and compare": **the published row cannot
contradict its own published facts.** The endpoint prints availability, load against capacity and kit
*and* a verdict; feeding those printed facts back through `buildCandidateReadiness` + `applyHardFilters`
and demanding the same partition means no row can ever read `ON_LEAVE` and `PASSED`, or `12 / 8` and
`PASSED`. A second copy of the filter passes an output-comparison test for as long as the copy happens
to be correct; it cannot pass this one while disagreeing with the facts it prints beside the verdict.

## The design mock and the design prose disagree, and the prose wins

The mock's candidate column tags its over-capacity engineer **`PASSED`**. Its own Q2 note calls
capacity *"a scheduler constraint, not an authorization limit"* — which describes precisely a
candidate the scheduler **drops** — and AC-2 requires the verdict to be the engine's.

So the endpoint reports `DROPPED · OVER_CAPACITY` and the row carries the marking beside it:
`over capacity — still assignable`, with nothing disabled and the load shown. **Selectability is what
makes overload an administrative right**, not a softened verdict. Faking the engine's answer would
make the column lie about dispatch in order to say something the adjacent marking already says
truthfully. Pinned on both sides — the backend spec asserts the drop *and* that `assignPlants` then
takes the engineer with no confirm and no extra reason; the admin spec asserts the click actually
moves work rather than asserting an `aria-disabled` attribute.

## Two rules that a naive reading gets wrong

**`TIER_NOT_REACHED` is not a verdict here.** #266 added it to the dispatch trace, where one ticket is
being placed and a lower tier is consulted only when every higher one failed. This column places
nothing and a human may cross tiers deliberately (#272 R6), so a never-reached tier would be a
rejection the operator's own decision has not yet made.

**A tier crossing is measured against the best still-*passing* tier at that plant.** A floating
engineer taking a plant whose only dedicated candidate was dropped has overridden nothing — floating
is the top of the reachable list there. A `tierRank > 1` rule flags both cases and trains the operator
to ignore the marking on the occasions it means something. Both branches are pinned in one test.

## Slices (red → green)

| # | Seam | Red produced |
|---|---|---|
| B1 | `GET /api/schedules/candidates` | `400` — `:engineerId` + `ParseUUIDPipe` captured it (#273's trap, again) |
| B2 | dropped rows present; row cannot contradict itself | `expected undefined to be 'DROPPED'` |
| B3 | `committed` vs `/schedules/engineers` | green on arrival → **sensitivity verified** |
| B4 | ZM clamp per plant, OH pan-India | green on arrival → **sensitivity verified** |
| B5 | over capacity dropped **and** assignable | green on arrival → **sensitivity verified** |
| A1 | tier grouping, engine order, empty tier named | `candidate-plant` absent |
| A2 | drop reason, over-capacity marking, clickable | `data-verdict` absent |
| A3 | focus follows the plant | no `Candidates for Pali Works` control |
| A4–A6 | two coverage badges · tier crossing · `7 → 25 / 10` | `coverage-*` / `lane-load-*` absent |

Three backend tests were green the moment they were written, because an earlier slice's implementation
already satisfied them. Each had its sensitivity **verified rather than asserted**, by breaking the
thing it claims to protect and recording the red:

| Test | Break applied | Red |
|---|---|---|
| AC-4 `committed` | count **batches** not stops — #269's own `ZmScheduleRow.ticketCount` error | `expected 1 to be 3` |
| AC-8 zone clamp | drop `zoneClamp` from the plant `where` | `expected [ '2', '3' ] to deeply equal [ '2' ]` |
| AC-5 over capacity | `>` instead of `>=` at the boundary | `expected 'PASSED' to be 'DROPPED'` |

## Found while building

- **A malformed candidates payload took down the entire console** — pool, ledger and Commit button
  included — because `candidateView.plants` was read unguarded. That defeats this issue's own rollback
  story ("hide the column; the console degrades to #273's behaviour"). Guarded in the column and in
  the lane-coverage helper: the column is additive, so an odd read must cost the column and nothing
  else. Surfaced by #273's own spec, which had never needed to stub this endpoint before — its
  fixture now answers in the real shape.
- **The `*/` docblock trap fired again**, in `**R4**/**R5**` — the same content-character class as
  #273's `**R1**/**R3**`. It is not confined to `src/ticketing/`: it is any prose docblock pairing
  bold markers with a slash. `tsc` reports it as `TS1109: Expression expected` pointing at the prose.
- **The #272 grammar's violet has no token in the admin theme.** The legend defines the marker as
  *"dashed — a human crossed a coverage tier"*, so the **dash** is the load-bearing half and is what
  was built, plus `data-tier-crossing` and a `title`. No palette entry was invented for one badge, and
  a colour-only treatment would have told a screen reader nothing (the `LoadBadge` precedent).
- **AC-1 survived as written, unlike #273's equivalent.** #273's "call both and compare" AC went
  tautological the moment both call sites imported one predicate. Here the HTTP layer is a genuine
  re-ordering opportunity — sort by name, group by tier and lose the within-tier `se_id` order, drop
  the tail — so the comparison can really fail. The fixture is additionally asserted to populate all
  three tiers, so a tier-losing implementation cannot pass on a one-tier plant.
- **"Can be selected" needed a behaviour, not an attribute.** Clicking **Assign** on a candidate puts
  that engineer on a lane holding the focused plant, reusing their existing lane if they have one — a
  second lane for the same engineer would split their load and make each `→ after / cap` figure wrong.
  The pool row's plant *name* became the focus control, kept separate from its checkbox: ticking
  drafts a row, clicking its name asks "who can cover this?".

## Deliberate scope calls

- **The readiness inputs are gathered once for the union of candidates**, not once per plant. The same
  engineer covers several selected plants far more often than not, and availability / kit / load are
  per-SE questions whose answers cannot legitimately differ between two plants on one screen.
- **An out-of-zone plant is omitted from the response, not refused.** A request naming several plants
  still answers for the ones the caller may see. Through the console this cannot arise at all — the
  pool it selects from is clamped by the same rule — so it only reaches a hand-made request, where
  returning nothing for that plant is the honest answer.
- **The lane's load reads #269's `ZoneEngineer` payload, not the candidate row.** A lane's engineer
  may hold a plant they do not cover, so they are not guaranteed to appear in any candidate list. Both
  numbers come from the same backend definition, so there is no second counter — only a source that is
  always present.
- **Amber at `after >= capacity`**, matching `isOverCapacity` and therefore the recommender's
  `OVER_CAPACITY` boundary. The issue's prose says "exceeds"; #269 recorded the same `>=`-over-`>`
  call for the same reason, and a lane showing room at exactly `10 / 10` would disagree with the
  engine it exists to mirror.

## Verification

- Backend `tsc` clean; admin `tsc` clean.
- **Full admin suite: 104 files, 539 passed / 0 failed.** The single unhandled render error
  (`TicketDetailDrawer.tsx:440`) is the pre-existing one recorded under #269 and #273 — it reproduces
  in that file's own spec run alone, and neither the component nor its test is touched here.
- Targeted backend regression over the shared-rule refactor's blast radius, before the full run:
  **43 files / 148 tests green** (`recommender-*`, `dispatch-*`, `candidate-selection*`,
  `critical-assign`, `assignable-work`, `capacity-overload-visibility`).
- **Full backend suite: 398 files, 1941 passed / 0 failed / 10 skipped, exit 0.** One #184 Windows
  worker crash (`bulk-unassign-controller`) was detected and retried by `scripts/run-tests.mjs` and
  recovered 9/9 — the known, tracked crash, not an assertion failure. Read the run log's
  `#184 AC-4: retry` line before bisecting anything recommender-shaped (the handoff's §5 lesson).

## Files

**Backend** — `src/recommender/candidate-readiness.ts` (new, the shared rule) ·
`src/recommender/recommender.service.ts` (moved onto it) ·
`src/scheduling/candidate-query.service.ts` (new) · `src/scheduling/schedules.controller.ts`
(`GET candidates` + `parsePlantIds`, declared before `:engineerId`) ·
`src/scheduling/scheduling.module.ts` (imports `EngineersModule`, `InventoryModule`) ·
`test/assign-console-candidates.e2e-spec.ts` (new, 5 tests).

**Admin** — `src/api/candidates.ts` (new) · `src/pages/assign/CandidateColumn.tsx` (new) ·
`src/pages/assign/LaneCoverage.tsx` (new) · `src/pages/assign/AssignConsolePage.tsx` (focus, the
candidates read, lane headers) · `test/assign-console-candidates.test.tsx` (new, 6 tests) ·
`test/assign-console.test.tsx` (fixture answers the new read).
