# 72 — Recommender preventive-mode scoring re-prioritisation

Status: done
Type: AFK
Origin: Issue 40 follow-up (2026-06-26).

## What to build

Issue 40 made the Soft Inactive Count drive the Recommender's **mode** (`RunSummary.mode` +
`scoreBreakdown.mode`, switched DEFICIT/PREVENTIVE off the count vs the 2% threshold). The current
scoring is the deficit-style behaviour (devices-cleared-per-SE-day with plant clustering). This issue
implements the distinct **preventive-mode** prioritisation (CONTEXT §5/§196): when a zone is in
PREVENTIVE mode, the planner shifts toward **repeat-offenders, aged devices, and Install backlog**
instead of raw clustering.

- In `RecommenderService.runForZone`, branch the scoring/sort weights on `mode`: PREVENTIVE biases
  `repeatFailure`, device age, and INSTALL work-type tickets up; DEFICIT keeps today's behaviour.
- Keep the mode signal + breakdown stamping from Issue 40 unchanged; this only changes ranking when
  `mode === 'PREVENTIVE'`.

## Acceptance criteria

- [x] PREVENTIVE mode re-prioritises repeat-offenders / aged devices over pure clustering *(Install backlog → #75; see Disposition)*
- [x] DEFICIT mode behaviour unchanged from Issue 10/40
- [x] Mode-driven ranking is reflected in `scoreBreakdown` for explainability

## Blocked by

- #40 (done)
- #10

## Disposition

**Done — TROUBLESHOOT re-ranking scope (2026-06-27).** 7 e2e (5 pure scoring + 2 run), recommender
regression suites (#10/#40) green, `tsc` clean. Scope confirmed with the user: re-rank the existing
TROUBLESHOOT candidates via a **separate PREVENTIVE weight set**; the **Install-backlog** leg (bringing
INSTALL tickets into the recommender candidate set — a candidate-selection change touching #11/#33/#34)
is split out to **#75**.

- **`scoring.ts`** — `scoreCandidate` gains an `inactivityHours` feature + two weight components,
  `repeat_failure_bonus` and `device_age`. Both default 0, so the DEFICIT set produces a **byte-identical**
  score (the existing repeat-failure *penalty* is untouched). `ageScore` (inactivity / 7d, clamped 0..1) is
  exposed in the breakdown.
- **`RecommenderService.activeWeights(mode)`** — DEFICIT uses the base active set (e.g. `v1`). PREVENTIVE
  uses a configured `<base>_preventive` set if active, else a **code default** derived from the base: repeat
  penalty → 0, `repeat_failure_bonus = 0.5`, `device_age = 0.5`. The base set is never mutated. The chosen
  ref (`v1_preventive`) is stamped into `scoreBreakdown.weightSetRef` (AC#3 explainability).
- **`runForZone`** passes each candidate's `inactivityHours` (from `latestGpsDatetime`) into the scorer.
  Result: in PREVENTIVE a repeat-offender on an aged device out-scores a fresh, non-repeat ticket — the
  opposite of DEFICIT, where repeat-failure is a penalty.
- **Hard Filters untouched** — activity-ping/`last_activity_at` is never a filter or scoring gate (CONTEXT
  §3/§16). The canonical sort (ADR-0017) is unchanged; the re-prioritisation is in the explainable score.

**Deferred → #75 (filed, linked in INDEX):** PREVENTIVE-mode Install-backlog inclusion in the recommender
candidate set.
