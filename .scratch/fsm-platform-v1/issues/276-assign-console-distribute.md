# 276 — Assign Work Console S4: Distribute — several plants across several engineers in one pass

Status: done (2026-08-24) — see `docs/progress/276-assign-console-distribute.md`
Type: AFK · Backend + Admin
Decision: #272 **R2** (projected, not persisted), **R6** (tier precedence displayed, crossable)

## Objective

Select several plants and several engineers, and the console proposes a split into the draft — from
the real selection logic, not a second copy of it in the client — which the operator then edits
before committing. This is the operator ask that no surface answers today: *two or more engineers
onto more than one plant*.

## Current behaviour (verified)

- Every manual write is N→1. There is no multi-engineer operation anywhere in the codebase.
- The engine's own splitting logic lives in `dispatchForZone` / the recommender: candidate ordering
  (`orderedCandidatesForPlant`), hard filters, capacity accounting via the running `assigned` map
  (`recommender.service.ts:455`), planner bias (ADR-0022) and same-plant clustering.
- **#250 already built the dry-run seam**: `dryRun` suppresses all six verified mutations, takes no
  lock, no in-flight row and no ledger row, and carries `bucketsAsOf`. `#251`'s preview page already
  consumes it and renders `PreviewPlanEntry[] {seId, plants:[{plantId, ticketIds}]}` — which is
  exactly the shape a draft lane needs.
- Clustering is same-plant-only, so it stays orthogonal to distance (recorded derived call, #258).

## Required change

1. **Projection endpoint** — a dry run scoped to *a chosen set of tickets and a chosen set of
   engineers*, returning `PreviewPlanEntry[]`-shaped lanes. Built on **#250's existing seam**; this
   issue adds a scope, not a second engine. If the seam cannot express "these engineers only", extend
   the seam — do not fork the selection code.
2. **Three strategies**, chosen by the operator, all projected before anything enters the draft:
   - **By capacity headroom** — fill toward `dailyCapacity`, respecting tier order within each plant.
   - **By coverage tier** — strict DEDICATED → MULTI_PLANT → FLOATING; leaves work unplaced rather
     than crossing a tier, and says so.
   - **Keep each plant whole** — never split a plant across engineers unless explicitly asked.
3. **The proposal lands in the draft, editable.** It is a starting point, not a commit — R2 holds:
   nothing is written, the ledger recomputes, the operator moves chips, then commits through #275.
4. **Unplaceable work is shown, not dropped** — into the console's "no eligible engineer" rail with
   the reason (`NO_COVERAGE` vs `ALL_DROPPED`), the same vocabulary the transparency surfaces use.
5. **Overflow is visible, not prevented** — a strategy may leave an engineer over capacity; the lane
   is marked amber and commits normally (Q2).
6. **RBAC** — gated per #272 open question 3 (**answer before building**): the existing ladder splits
   preview + holds (all managers) from `POST dispatch-run` (OH + CSM). Distribute is closer to a
   dispatch run than to a single assignment. Do not widen the ladder on your own judgement.

## Existing code to reuse

`#250`'s `dryRun` seam and `targetDate` · `#251`'s `PreviewPlanEntry` / `ZoneProjection` shapes and
`schedulerPreview.ts` client · `orderedCandidatesForPlant` · `applyHardFilters` · the running
capacity map pattern (`recommender.service.ts:455`) · the draft lanes from #273 · the candidate data
from #274.

## Data model / API

No schema change. One projection endpoint (or a scoped mode on #250's existing dry run). No write.

## UI surfaces

Admin: `/assign` — multi-select on both columns, the **Distribute across selected engineers…**
control in the console footer, strategy picker, and the projected lanes. Mobile: none.

## Reference

`docs/ui/desktop/approved-designs/assign-work-console.html` — wireframe 1 footer control, and the
draft-plan column as the projection's destination.

## Acceptance criteria

- [x] The projection writes nothing: no recommendation rows, no lock, no in-flight row, no ledger
      row, no ticket mutation — asserted the same way #250's own ACs assert it.
- [x] Running the same projection twice on unchanged data returns the same lanes.
- [x] "By coverage tier" never places work on a lower tier when a passing higher-tier candidate
      exists; the unplaced remainder is reported, not silently dropped.
- [x] "Keep each plant whole" never splits one plant across two lanes.
- [x] "By capacity headroom" may exceed capacity when the selected engineers cannot absorb the
      selection; the affected lanes are marked and still committable.
- [x] Work with no eligible engineer lands in the no-coverage rail with `NO_COVERAGE` or
      `ALL_DROPPED`, matching the transparency vocabulary.
- [x] The proposal is editable before commit and the ledger recomputes on every edit.
- [x] Selection logic exists in exactly one place — a test asserts the projection agrees with the
      engine's own choice for a single-ticket, single-candidate case.

## Tests

Backend: no-mutation assertions (reuse #250's), determinism, per-strategy placement rules, unplaced
reporting. Admin: strategy picker, projected lanes editable, ledger recompute, rail rendering.

## Dependencies / Blocked by

- **#274** — Distribute is unusable without the capacity and coverage data it distributes over.
- **#275** — the commit the proposal flows into.
- **#250** — the seam; already landed.
- **#266 (hard)** — a "by score within tier" strategy is only meaningful once score decides anything;
  until then the strategies above are the complete set and no scoring strategy may be offered.
- **#272 open question 3 (RBAC)** — must be answered before this ships.

## Risks

Medium–high, concentrated in one place: any strategy implemented client-side, or as a second copy of
the selection rules, will drift from the engine and quietly disagree with it. The single-source AC is
the pin. If the #250 seam genuinely cannot be scoped to a chosen engineer set, **stop and surface it**
rather than forking the selection path.

## Rollback

Projection-only, no writes. Hide the Distribute control; the console degrades to manual chip
placement from #273/#274.
