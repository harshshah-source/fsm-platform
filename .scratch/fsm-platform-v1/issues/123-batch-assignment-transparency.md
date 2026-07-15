# 123 — Batch-Assignment transparency (dispatch ledger + manager drill-down)
Status: done
Type: AFK

> Source: manager need to answer "why did the batch run assign (or fail to assign) this ticket to
> this SE?" against a run whose config may since have changed. Step-1 inventory (accepted): the
> Recommender already persists `processing_rank` + winner-only `score_breakdown`; candidate lists,
> per-filter drop verdicts and capacity order were discarded; selection is precedence-based (runner-up
> scores degenerate until distance scoring lands); no `run_id` existed anywhere; config edits rewrote
> history. This issue adds an **observe-only** ledger that records each run without altering
> selection/scoring/ordering, plus the manager drill-down over it.
>
> **2026-07-15 — backend landed (slices 1–3).** Schema + write path committed (`e20d622`, `e9e6f05`);
> read endpoints + e2e land with this file.
> **2026-07-16 — manager UI drill-down landed (FE slices 1–4)**, closing the issue: DataTable
> expandable-row primitive + runs list → run detail (config-in-effect panel) → zone → batch with the
> inline precedence-terms decision trace. Read-endpoint gaps found by the contract map were fixed
> first (`a150c13`: `scoreDegenerate` on rows, `seNames` in the trace, `actorName`); Gap B (effective
> config in the snapshot) is the #124 follow-up, rendered as "Default (not overridden)" meanwhile.

## What to build

1. **Ledger schema (slice 1 — done):** `dispatch_runs` (config snapshot at run start), `dispatch_run_zones`
   (per-zone totals + mode + `NO_COVERAGE` vs `ALL_DROPPED` reason buckets), `dispatch_decision_traces`
   (bounded per-ticket trace, 1:1 with the run's recommendation), + nullable `run_id` on
   `recommendations` and `work_schedules`. Retention wired to the #104 matrix (traces 90d, runs/zones 400d).
2. **Write path (slice 2 — done):** `runForActiveZones` opens the run row (config frozen at start:
   weights, cluster multiplier, eligibility_mode, per-SE `{daily_capacity,is_active}` map, sweeps
   flag + cron), audit-brackets the run (`DISPATCH_RUN_STARTED`/`FINISHED` — previously an unaudited
   system actor), writes per-zone rows, threads `runId` into the recommender (traces: precedence-led
   runners-up ≤5, per-filter drop COUNTS, `scoreDegenerate`) and the dispatcher (`work_schedules.run_id`).
   e2e pins the pre-ledger outcome byte-identical.
3. **Read endpoints (slice 3 — done):** `/api/dispatch-runs/*` — runs list → run detail (config-in-effect
   + zone cards) → zone → batch → per-ticket trace. Manager-roled; a ZM is zone-clamped at every level.
   Foreign-zone behaviour is per-route and deliberate (see the controller docstring): zone detail
   (`:zoneId` param) → 403 via the global `ZoneScopeGuard` (#99, the platform-standard zone-scope
   response); batch/trace (no `:zoneId`) → 404 via the service clamp.
4. **Manager UI drill-down (slice 4 — done):** runs list → run detail (config-in-effect panel + zone
   cards) → zone → batch → assignment table with an expandable per-ticket decision trace that explains
   the pick in **precedence terms** and **hides score numbers while `scoreDegenerate=true`**. Reuse the
   current theme/table patterns; role-matrix + render tests.

## Acceptance criteria

- [x] Three ledger tables + `run_id` links; from-zero migrate clean; retention comments reference the #104 matrix.
- [x] Run writes config snapshot AT RUN START (incl. per-SE capacity map); a later config/capacity edit does not rewrite past runs.
- [x] Decision trace is bounded (≤5 runners-up) with precedence rank / coverage tier / filter verdict / planner-bias / `scoreDegenerate`; drop COUNTS not raw rows; unassignable tickets traced with `NO_COVERAGE` vs `ALL_DROPPED`.
- [x] Per-run system-actor audit event (`DISPATCH_RUN_STARTED`/`FINISHED`).
- [x] Read endpoints role-guarded; ZM zone-clamped (list totals, run-detail cards, zone/batch/trace); e2e 10/10 green.
- [x] Observe-only: selection/scoring/locking untouched; slice-2 byte-identical e2e green.
- [x] Manager UI drill-down built to the ACs above (slice 4) — runs list → run detail (config panel + zone cards) → zone → batch → inline decision trace; scores hidden while degenerate; ZM never links to a foreign zone.

## Storage estimate (~6k tickets/day)

`dispatch_decision_traces` dominates: 1:1 with recommendations → ~6,000 rows/day; trace JSONB ≈ 1–1.5 KB
(bounded — ≤5 runners-up + chosen context + drop counts), plus heap header and three indexes ≈ **~1.7 KB
all-in per row → ~10 MB/day**. At the #104 traces-90d window → **~0.9 GB steady-state**.
`dispatch_run_zones` ≈ ~90 zones × ~1–2 runs/day × ~0.5 KB, 400d → ~36 MB. `dispatch_runs` ≈ ~1–2 rows/day,
`config_snapshot` ≈ 6–8 KB (per-SE capacity map), 400d → ~6 MB. **Feature total ≈ under 1 GB steady-state**,
traces ~95% of it. Retention deletes (SET NULL on op rows, CASCADE on children) are already wired for #104.

## UI surfaces

`/dispatch-runs` manager drill-down (slice 4, pending): runs list → run detail (config-in-effect panel +
zone cards) → zone → batch → assignment table with expandable decision trace. ZM zone-clamped.

## Reference
`docs/ui/desktop/v2-reference/` (manager drill-down patterns); consumes `/api/dispatch-runs/*`.

## Blocked by
None — backend consumes the existing dispatch flow (#113) and `ZoneScopeGuard` (#99). Retention is #104.
