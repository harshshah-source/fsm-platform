# 266 — Scoring selects the SE within the coverage tier, and the cluster multiplier becomes candidate-specific

Status: **partial — slice 1 landed 2026-08-21 (`8303f2d`)**; tier grouping + per-candidate scoring + Q-A clustering + floored base are in. Remaining: trace/breakdown correctness (item 4), the three dead seeded weights (item 5), the canonical-ordering pin and the preview-parity assertion (item 6).
Type: AFK · Backend + Admin
Decision: #258 **Q1** (hard eligibility → coverage tier → score among that tier's eligible
candidates → final SE; precedence inviolable; canonical ticket ordering untouched) **+ Q-A** (the
Plant Cluster Multiplier becomes a candidate-specific factor — ruled 2026-08-20 after the
pre-implementation review proved it could not otherwise influence any decision).

## Objective

`priority_rule_config` weights genuinely decide which SE wins among equally-tiered eligible
candidates; the cluster multiplier genuinely rewards the SE who is already going to that plant; and
every persisted breakdown/trace reflects scores actually computed for the candidates the decision
weighed.

## Current behaviour (verified)

- Selection is `chosen = planner ?? passed[0]` (`recommender.service.ts:466`) — strict precedence +
  `se_id` asc; **score influences nothing**. Scoring runs once, for the already-chosen SE.
- Runner-up trace rows carry the WINNER's score (`:687`, in-code TODO at `:682-686` admits it).
- Dead config: seeded weights `company_tier`/`device_bucket`/`sla_urgency` (`org-seed.ts:70-72`)
  are read by nothing; `distance` is active-but-null-fed (becomes real in #267).
- Tiers arrive pre-flattened but **each candidate already carries its `coverageType`**
  (`candidate-selection.service.ts:29-51` builds `{seId, coverageType}` for all three legs), so
  tier grouping needs no new lookup — it is a `groupBy` over data already in hand.
- **The Plant Cluster Multiplier is decorative twice over.** `multiplier = isSeed ? 1 :
  clusterMultiplier` where `isSeed` keys on a run-level `seededPlants` set (`:468-470`): for a given
  ticket it is a single value applied to **every** candidate, so it cancels out of any comparison
  between them — and since score does not order tickets either, it currently changes nothing at all.
  It also does not mean what its name says: it asks "has ANY SE been seeded at this plant this run",
  not "does THIS SE already go to this plant".

## Required change

1. After hard filters, group `passed` by `coverageType`; the **winning tier** is the first
   non-empty in precedence order — a lower tier is reached only when every higher-tier candidate
   was filtered out. (FLOATING can never out-score an eligible DEDICATED — by structure, untestable
   to violate.)
2. Score **every candidate in the winning tier** — per-candidate now, not once per ticket. Winner =
   highest score; deterministic tie-break `se_id` asc.
2b. **Q-A — candidate-specific plant clustering.** Replace the run-level `seededPlants` seed test
   with a per-SE plant set, derived from data the run already reads and mirroring exactly how
   capacity is handled (`committedDayLoad` seeds a per-SE counter, then in-run wins increment it):
   - **seed** each SE's set from the plants already on their live day plan for the target day
     (`plant_batch_assignments.plantId` on non-removed `batch_assignment_tickets` over
     `liveScheduleFilter()` schedules — the same rows `committedDayLoad` already counts, so this is
     one widened read, not a new query pattern);
   - **grow** it in-run: when an SE wins a ticket at plant P, add P to their set;
   - **apply** `plant_cluster_multiplier` (unchanged setting, default 1.25) to a candidate's score
     **iff** the ticket's plant is in that candidate's set — otherwise ×1.
   The signal is deliberately **same-plant only**. Geographic proximity is priced by the distance
   component (#267); pricing "nearby" here too would double-count the same preference and make the
   breakdown uninterpretable. Clustering is never a filter and never crosses tiers (Q-A).
3. **Planner bias precedence (derived, flag if disputed):** ADR-0022's ruling ("soft bias among
   eligible candidates") is preserved and sits ABOVE score within the tier — a planner-named,
   filter-passing SE in the winning tier wins regardless of score, exactly as today. Score decides
   when no planner pin applies. Q1 is silent on this interaction; ADR-0022 is standing authority,
   so it is kept, and `plannerBias` in the breakdown records when it decided.
4. Breakdown/trace correctness: persist the winner's real breakdown **including the
   candidate-specific clustering contribution** (Q-A requires the breakdown to show it); trace rows
   for runner-ups in the winning tier carry **their own** scores (closes the `:687` defect);
   candidates in non-winning tiers are traced as `TIER_NOT_REACHED`, not scored-and-lost.
5. Remove the three dead seeded weights (migration deactivates them; parser/docs updated) so the
   admin weights page shows only levers that exist. `distance` stays (0-contribution until #267 —
   equal contribution cannot reorder).
6. Preview parity is free (same `runForZone` path) — assert it, don't assume it.

## Existing code to reuse

`scoring.ts` `scoreCandidate` (unchanged math); `activeWeights` resolution incl. `_preventive`;
`hard-filters.ts`; planner map (`plannerForDate`); trace plumbing; `dispatch-preview`/
`scheduler-preview` specs as parity harness.

## Data model

None (seed-data migration only, for item 5).

## API

None — `scoreBreakdown`/trace shapes gain `tierEvaluated`/per-candidate scores (additive JSON).

## UI surfaces

Admin: dispatch trace drawer renders per-candidate scores (values change, layout doesn't); scoring
weights page loses the three dead rows. Mobile: n/a.

## Reference

`docs/ui/desktop/v2-reference/` transparency/trace page (no redesign).

## Acceptance criteria

- [x] DEDICATED score 60 beats FLOATING score 95 (precedence inviolable).
- [~] ~~Within one tier: higher score wins; weight change flips the winner~~ — **UNBUILDABLE AS
      WRITTEN, and the reason matters.** `features` is built entirely from the *ticket*
      (`companyPriorityRank`, `dispatchUrgency`, `repeatFailure`, `inactivityHours`) and
      `distanceFromPrevStopKm` is hardcoded `null` until #267, so **every candidate for a ticket
      computes an identical `baseScore`** and no weight change can reorder them. The cluster
      multiplier is the only per-candidate term this slice can produce — which is exactly what the
      pre-implementation review meant by Q-A "could not otherwise influence any decision". Built
      instead in the only form the feature set allows: driving `plant_cluster_multiplier` to 1.0
      hands the ticket back to the `se_id` winner, which fails if clustering is cosmetic.
      **Consequence to carry into #267:** the four remaining weights still influence no selection
      until `distance` becomes per-candidate.
- [x] Planner-named SE beats a higher-scoring same-tier peer; `plannerBias` recorded.
- [x] Equal scores → `se_id` asc, pinned for determinism.
- [ ] Runner-up trace scores are the runner-ups' own (regression on the `:687` defect).
- [ ] Canonical ticket ordering byte-identical before/after (processingRank unchanged on a fixed
      fixture) — Q1's "do not replace canonical ordering" clause, pinned.
- [ ] Capacity/cluster interplay: the winning SE's `assigned` increment and plant-set growth follow
      the SCORED winner (the counters at `:406`/`:468` keyed on the new chosen).
- [x] **Q-A clustering is candidate-specific**: same tier, otherwise-equal candidates, SE A already
      holding a stop at plant P and SE B not → A wins the next ticket at P; the breakdown shows the
      multiplier applied to A and not to B. Setting `plant_cluster_multiplier` to 1.0 flips the
      outcome back to the score-only winner (proves the factor is load-bearing, not cosmetic).
- [x] Clustering seeds from an SE's **pre-existing** day plan, not only from in-run wins (an SE
      given plant P by an earlier run or a manual assign carries the benefit into this run).
- [x] Clustering never promotes a lower tier over a higher one, and never drops a candidate
      (not a filter) — asserted with a FLOATING SE holding the plant vs. a DEDICATED SE who is not.

## Tests

Unit: tier-grouping + selection matrix. e2e: extend `recommender-run`, `recommender-planner-bias`,
`recommender-cross-zone-capacity`; new `recommender-score-selection.e2e-spec.ts`; preview-parity
assertion in `recommender-dry-run`.

## Dependencies / Blocked by

**#177** (exclude WAITING_COMPONENT tickets from the pool) lands first — sequenced by the
pre-implementation review so the selection rewrite happens over a correct candidate pool rather than
being re-touched afterwards. #267 and #268 build on this issue. Coordinate with #262 only at merge
time (different files: recommender vs batch-assignment).

## Risks

Dispatch outcomes CHANGE by design — every spec that pinned `passed[0]` winners needs deliberate
re-baselining (re-derive expected winners, don't blind-update). The ADR-0022 interplay (item 3) is
the one derived call: surface it in the TDD report for operator visibility.

Q-A's clustering read widens `committedDayLoad`'s query from a count to a
plant-set-plus-count — verify it stays one query and does not regress the per-run cost that NEW-A1
established. **#137's deferred stub cites `recommender.service.ts:522-526` as the multiplier's home
for its "group nearby jobs" posture**; that citation moves with this change — update the stub's
reference line (it stays deferred; only the pointer changes).

## Rollback

Code-only; seed migration reversible.

## Rulings and corrections made while building (slice 1)

- **Item 3 was self-contradictory and is now ruled.** It said planner bias sits above score *"within
  the tier ... exactly as today"* — but today the pin **crosses tiers**: `passed.find(planner)`
  searches every filter-passing candidate, and `recommender-planner-bias.e2e-spec.ts` has pinned a
  planner-named MULTI_PLANT SE beating an eligible DEDICATED one since Issue 14a. Restricting it to
  the winning tier silently retires a ratified ADR-0022 behaviour and overrides a manager's explicit
  choice with an SE they did not name. **Operator-ruled: the cross-tier pin stands.** Q1's
  "precedence is inviolable" therefore binds the **score** — a higher score can never cross a tier,
  a human's pin still can.
- **`score = baseScore * clusterMultiplier` inverts on a negative base.** With the seeded DEFICIT
  weights an install-backlog ticket has `dispatchUrgency = 0` by design, so a repeat-failure ticket
  for a company at rank F scores exactly 0 (the bonus is a no-op) and at rank G or lower scores
  negative — where the 1.25x bonus makes the SE *already going to that plant* score **worse**.
  `company_priority_rank` is a free `String` column, not an enum, so those letters are reachable.
  **Operator-ruled: multiply a floored base** (`max(base, 0)`); the breakdown still carries the true
  `baseScore`, so nothing is hidden.
- **`clusterSeed` changed meaning** from run-level ("first ticket at this plant this run", whoever
  won it) to per candidate ("this winner's first stop at this plant today"). It is rendered in the
  transparency drawer; the docstring and `dispatch-transparency.e2e-spec.ts` were updated together.
- **Three expectations re-derived, none blind-updated** (operator-ruled method): `recommender-run`'s
  capacity-fallback SE no longer collects a 1.5x cluster boost for a plant they have never visited
  (1.5 → 1, same SE chosen), and `dispatch-transparency`'s same fallback SE is now correctly recorded
  as seeding the plant (false → true). Both test titles asserted the old meaning in words and were
  corrected with them.
- **`committedDayLoad` is re-expressed over a new `committedDayPlan`** rather than duplicated, so the
  capacity counter and the clustering plant-set are seeded from the same rows and cannot drift — one
  widened `select`, not a second query, so the NEW-A1 per-run cost is unchanged.