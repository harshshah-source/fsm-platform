# #330 — The candidate pool is fetched once per plant, not once per ticket

**Finding:** AR-11 (`audit/2026-09-01-scheduler-engine-forensics.md` §7) · **Wave 4** · P3
**Landed:** 2026-09-03 · branch `feat/autoplant-integration`
**Issue:** [`.scratch/fsm-platform-v1/issues/330-candidate-query-memoisation.md`](../../.scratch/fsm-platform-v1/issues/330-candidate-query-memoisation.md)

---

## What was wrong

`orderedCandidatesForPlant` is two queries — `se_coverage`, then the floating leg joined live against
`engineer_master` (#138) — and `runForZone` called it once per **ticket**. Every other expensive read
in that loop was already memoised across the run: Common-Kit completeness, SE availability, plant
coordinates (#267 has an AC for exactly this), engineer home bases. The candidate pool was the one
input still scaling with the ticket list, so a 900-ticket zone spent roughly 1,800 round trips
re-answering "who covers this plant?" about plants it had already resolved.

Cost is the smaller half of it. The loop's wall time *is* the window #305's heartbeat exists to keep
inside the reap threshold — the `onProgress` docblock names this finding by number — so shortening the
loop shrinks a live exposure rather than just a bill.

## The fix

A run-scoped `Map<string, CandidateSe[]>` declared in `runForZone` beside `kitStatusBySe`, read through
a `candidatePool(plantId, cache)` helper shaped exactly like `ensureKitStatus` / `ensureAvailability`.

**The cache is a parameter, not a field.** That is the whole of the scoping guarantee: it is created by
`runForZone` and dies with it, so there is no cross-run or cross-zone leak to reason about and nothing
to invalidate. A field on this singleton would be shared by every zone it ever serves, which is the one
thing the issue rules out.

**Only the pool is memoised.** Readiness, hard filters, tier precedence, scoring and the capacity
counter stay per ticket, because those genuinely change as the run assigns work. The pool is the single
input that does not.

The returned array is shared across a plant's tickets, and every reader below treats it as read-only —
`filter`, `map`, `slice`, `findIndex`, `.length` (checked at all eleven sites). #276's `engineerIds`
narrowing builds a new array with `filter` rather than editing the cached one, so a scoped Distribute
run cannot poison the pool for a later ticket.

Dry-run paths (preview, Distribute) inherit this through the same code, not a fork — they were already
calling `runForZone`.

### The staleness question, answered by scope rather than invalidation

A pool cached before a mid-run coverage change is stale. That is already this engine's semantics and
not a new compromise: the run reads a snapshot — its ticket list, its committed day plan, its weights
and its tier overrides are all read once up front — so a coverage edit landing between two tickets was
never going to be applied consistently. Across runs it must be seen, and a run-scoped map gives that
for nothing. Stated in the comment, as the issue asked.

## How the equivalence is actually shown

"Decisions byte-identical" cannot be observed by running the memoised code twice. The spec is written so
that the **red run is the pre-image**: the call-count assertion is the last statement in the test, so on
the red run every decision assertion above it executed and passed against the *unmemoised* code. Those
recorded values — `recommended: 6`, `unassignable: 0`, six `SUGGESTED` / `MORNING_BATCH` rows, a dense
`processingRank` `[1..6]`, and each ticket landing on the engineer covering its own plant — are
therefore output of the old code, and the green run is the comparison.

Assertion order is load-bearing here and is commented as such in the spec, so a later edit does not
reorder it back and quietly destroy the equivalence.

## Verification

- `test/recommender-candidate-memoisation.e2e-spec.ts` — 2 cases (6 tickets across 2 plants). Red:
  `['2','2','2','3','3','3']` — six calls, one per ticket. Green: two, one per distinct plant, with
  every decision assertion unchanged from the red run.
- The second case pins the scope: two consecutive runs each re-read both plants, so nothing survives a
  run boundary.
- 26-file recommender/preview/Distribute regression surface — 93/93.
- Full backend suite with #321: **455 files, 2,423 passed, 5 skipped, zero failures**, five batches,
  every batch exit 0.
- `npx tsc --noEmit` clean. No schema, no migration, no API change.

## Acceptance criteria

- [x] **AC1** — pool queries scale with plants, not tickets; decisions byte-identical.

`UI surfaces: n/a`.
