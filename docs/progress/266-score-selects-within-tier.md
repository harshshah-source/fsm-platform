# #266 — the score selects the engineer, and every lever on the scoring surface is real

**Landed 2026-08-21** across four commits: `8303f2d` (selection + Q-A), `4ae45e5` (trace),
`5dcad0d` (closed vocabulary + ordering pin), `322a4e4` (counter interplay).
P8 item 10; clears the last hard prerequisite of
[#274](../../.scratch/fsm-platform-v1/issues/274-assign-console-candidates.md).

Per-issue reports are frozen once written. Corrections go to INDEX / SYSTEM-STATE, never here.

---

## What was wrong

`chosen = planner ?? passed[0]` — strict coverage precedence, then `se_id` ascending. The score was
computed **once, after the winner was already picked**, for that winner alone. Every
`priority_rule_config` weight was decorative with respect to selection, and the admin weights page
offered levers that moved nothing.

## The structural finding that shaped the whole issue

**Scoring every candidate is not by itself enough to make the score selective**, and reading the code
is what shows it. `features` is built entirely from the *ticket* — `companyPriorityRank`,
`dispatchUrgency`, `repeatFailure`, `inactivityHours` — and `distanceFromPrevStopKm` is hardcoded
`null` until #267. So **every candidate for a given ticket computes an identical `baseScore`**.

That is exactly what the pre-implementation review meant when it said the Plant Cluster Multiplier
"could not otherwise influence any decision", and it is why Q-A had to land in the same slice rather
than after: clustering is the *only* per-candidate term this issue could produce.

It also made **AC-2 ("a weight change flips the winner") unbuildable as written** — raising a weight
scales every candidate's base by the same factor and cannot reorder them. Recorded as unbuildable in
the issue, and proven in the only form the feature set allows: driving `plant_cluster_multiplier` to
1.0 hands the ticket back to the `se_id` winner, which fails if clustering is cosmetic.
**Carry into #267: the four remaining weights still influence no selection until `distance` becomes
per-candidate.**

## The ratified selection order

```
hard filters
  → SE Planner pin among ALL passing candidates?  yes → WINNER   (may cross tier)
     no → winning tier (first non-empty in precedence order)
            → highest score
              → tie: se_id ascending
```

## Two rulings the build forced, neither invented

**① The cluster bonus multiplies a floored base.** `score = base × multiplier` **inverts** when the
base is negative. With the seeded DEFICIT weights an install-backlog ticket has `dispatchUrgency = 0`
*by design*, so a repeat-failure ticket for a company at rank **F** scores exactly 0 (the bonus is a
no-op) and at rank **G or below** scores negative — where a 1.25× "bonus" makes the SE *already going
to that plant* score **worse** than one who has never been. `company_priority_rank` is a free `String`
column, not an enum, so those letters are reachable today. Ruled: `max(base, 0) × multiplier`; the
breakdown still carries the true `baseScore`, so nothing is hidden.

**② The issue's item 3 was self-contradictory.** It said the planner pin sits above score *"within the
tier … exactly as today"* — but today the pin **crosses tiers**: `passed.find(planner)` searches every
filter-passing candidate, and `recommender-planner-bias.e2e-spec.ts` has pinned a planner-named
MULTI_PLANT SE beating an eligible DEDICATED one since Issue 14a. The first implementation restricted
it to the winning tier and silently retired that. Ruled: **the cross-tier pin stands**, so Q1's
"precedence is inviolable" binds the **score** — a higher score can never cross a tier, a human's
explicit pin still can.

## Q-A — clustering that means what its name says

The multiplier asked *"has ANY SE been seeded at this plant this run"* — one value per ticket applied
to every candidate, so it cancelled out of every comparison between them. It now asks **"does THIS
engineer already go to this plant today?"**

Seeded from a new `committedDayPlan` — **one widened `select` on the rows `committedDayLoad` already
reads**, not a second query, with `committedDayLoad` re-expressed over it so capacity and clustering
are seeded from the same rows and cannot drift — then **grown in-run** beside the capacity counter, so
an SE who has just won this plant carries the benefit into the next ticket here.

## The trace stopped explaining the decision wrongly

Three falsehoods, **two of them created by slice 1** — the interesting half of this issue:

- **Runner-up scores were the winner's score** (`:687`, with an in-code TODO admitting it). Harmless
  while all candidates scored alike; actively wrong once clustering became candidate-specific, because
  a runner-up who has never been to the plant was displayed carrying the winner's bonus and the trace
  **reported a tie the engine never saw**. The TODO predicted this and expected #267's distance to
  trigger it; clustering got there first.
- **`scoreDegenerate` was falsified without its expression being touched.** It read
  `distanceFromPrevStopKm === null || weights.distance === 0` — "everything ties, precedence decided".
  After Q-A that was wrong on precisely the tickets where the score genuinely decided, and an operator
  reading "precedence decided" goes hunting for a coverage explanation that does not exist. Now derived
  from the spread of the scores actually computed — the only form that survives #267.
- **Losing-tier candidates were traced `PASSED` with a score**, as though weighed and lost on merit.
  They were never scored → **`TIER_NOT_REACHED`**, null score.

## Closing the vocabulary (item 5, widened by what the surface showed)

`company_tier`, `device_bucket` and `sla_urgency` were seeded in Issue 02 and read by nothing. They
were not merely inert: `activeWeights` loads every active row into the weights map, which is persisted
verbatim as `score_breakdown.weights`, so **every stored explanation carried three numbers that
contributed nothing to the score it was explaining**.

Deactivating them would have fixed the instance and left the class — the admin's Component field is
**free text** and the table never shows `active`, so the next dead lever is one form submission away.
Ruled: close the set. `scoring.ts` exports `SCORING_COMPONENTS` (the scorer is the only thing that can
say what a lever is), the API 400s on anything outside it naming both the offender and the real
vocabulary, `GET /org/scoring-weights/components` serves that list so the picker and the validation
cannot drift, and the field becomes a picker. The three are **deactivated, not deleted** — the table is
operator-tunable and audited, so a past run's stamped `weight_set_ref` should still resolve to the rows
that were live — and dropped from the seed so a fresh database never grows them.

## Files

```
NEW  apps/backend/test/recommender-score-selection.e2e-spec.ts    5 tests
NEW  apps/backend/test/recommender-trace-scores.e2e-spec.ts       4 tests
NEW  apps/backend/prisma/migrations/20260821120000_retire_dead_scoring_weights/
MOD  apps/backend/src/recommender/{recommender.service,scoring}.ts
MOD  apps/backend/src/scheduling/committed-day-load.ts            +committedDayPlan
MOD  apps/backend/src/org/{scoring-weights.service,scoring-weights.controller,org-seed}.ts
MOD  apps/backend/test/{recommender-run,dispatch-transparency,org-scoring-weights}.e2e-spec.ts
MOD  apps/admin/src/api/{dispatch-runs,org}.ts
MOD  apps/admin/src/pages/dispatch/DecisionTrace.tsx  MOD apps/admin/src/pages/settings/sections.tsx
MOD  apps/admin/test/{dispatch-batch-detail,settings}.test.tsx
```

## Re-baselining — five expectations, every one derived

The issue's risk note said outcomes change by design and to re-derive rather than blind-update. Three
of the five were **pinning the defect**:

| spec | was | now | why |
|---|---|---|---|
| `recommender-run` | cluster boost 1.5 | 1.0 | the fallback SE had never visited that plant |
| `dispatch-transparency` | `clusterSeed: false` | `true` | that same SE *is* seeding it, not following on |
| `dispatch-transparency` | runner-up `PASSED` + a number | `TIER_NOT_REACHED`, null | its tier was never reached |
| `org-scoring-weights` | upserts `company_tier` → 201 | a real component | it pinned saving a dead lever |
| `org-scoring-weights` | 400 case used `component: 'x'` | a real component | so it fails for the reason it names |

Four test titles asserted the old meaning **in words** and were corrected with them.

## Sensitivity — verified, not asserted

Four tests were green-from-the-start; each was broken deliberately and watched go red:

- key the predicate on `slaPaused` → **only** the round-trip test fails (the permanent-stranding bug).
- leak a scoring input into `processingRank` → **only** the canonical-ordering pin fails.
- re-key the capacity counter to `passed[0]` → **only** the interplay test fails.
- revert the admin field to `<Input>` → **only** the picker test fails (`expected 'INPUT' to be 'SELECT'`).

## Verification

- backend + admin `tsc` clean.
- Full backend exit 0; **394 files passed / 3 skipped (397), 1944 passed / 0 failed / 5 skipped** on the
  clean run, 1950 collected after the final test. Full admin **103 files, 533/533**.
- Preview parity was **already** asserted (`recommender-dry-run` AC-4 compares
  `ticketId/seId/processingRank/status` between dry and real runs) and stayed green through all four
  commits, so it exercises the rewritten path rather than needing a duplicate.
- `sections.tsx` is mid-rework by another session; the committed edit is a **HEAD-based** version,
  verified green on its own before commit rather than assumed.
- Migration is a scoped, idempotent, reversible `UPDATE … SET active = false`. **#243 remains
  HITL-gated and unexecuted.**

## One finding that is not this issue's, recorded because it cost an hour

A full-suite run failed with **five assertion failures** in `recommender-dry-run` — every ticket
withheld, zero decisions. It passed in isolation. Cause: the #184 worker crash dropped
`se-assignment-threshold.e2e-spec.ts` mid-run, so its `afterAll` — which exists precisely to restore
the global `se_assignment_threshold_hours` and says so, citing #156 — **never ran**, leaving the
threshold moved for every later spec. A re-run was clean.

This is a **new instance of #156's class with a nameable mechanism**, and it matters because #156's own
note records "zero assertion failures" for that family: a crash that skips a cleanup restoring *global
config* does not look like a crash downstream — it looks like a real, reproducible-seeming logic
regression in an unrelated file. Worth knowing before someone spends a session bisecting one.
