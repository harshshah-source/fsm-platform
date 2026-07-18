# 128 — Device deployment lifecycle · 2026-07-18

**Status: done** (backend mechanism + backfill applied + verified). Commits `b9242da` (mechanism,
Slice 1), `aff1d87` (interleaved enrichment WIP, isolated), plus this session's backfill-verify +
tooling commit. UI parity split to **#129** (fast-follow — data layer ready). Enrichment WIP is
`aff1d87` and is explicitly **not** independently verified.

## The gap this closed

Master sync read `mst_vehicle` filtered to `deployment_status IN ('DEPLOYED')` and upserted only the
returned rows, so a device that left the deployed fleet froze in FSM at `'DEPLOYED'` forever. Measured
2026-07-17: all 20,856 FSM vehicles read DEPLOYED vs 15,652 actually deployed at source; **42.5% of
live-batch devices were UNDEPLOYED at source**; the `all-deployed` eligibility gate was a no-op
(20,925/20,925 eligible).

## What shipped (Slice 1 — mechanism, `b9242da`)

- **Widened READ, pinned CREATE.** The master read now covers every `deployment_status` so departures
  are OBSERVED, not inferred; `isOperationalStatus` pins the CREATE to DEPLOYED/ACTIVE — a never-known
  non-operational row is counted (`NOT_DEPLOYED_NEVER_KNOWN`) and dropped, never mirrored, so `vehicles`
  never balloons ~21k → ~48k.
- **`device_departures` side table** (one active row per device, partial unique `WHERE restored_at IS
  NULL`; FKs to `devices` + `master_sync_runs`) + denormalised `device_states.is_departed`.
- **Two detection paths:** `SOURCE_STATUS` (observed non-operational — trusted, applied) and
  `ABSENT_FROM_READ` (device_id gone from the read — inferred, guard-railed: bounded to the synced
  plant scope, and the whole absence pass aborts if it would mark > `DEFAULT_MAX_ABSENCE_RATIO` = 10%).
- **Departure cancels open tickets** (`DEVICE_UNDEPLOYED_CLOSE`, #119 semantics, cycle → FAILED),
  audited (`DEVICE_DEPARTED` / `DEVICE_REDEPLOYED`, system actor). **Re-deploy auto-restores**, no
  manual step.
- **Downstream:** recompute derives `is_departed` ⇒ departed excluded from `is_inactive` /
  `sla_bucket` / `eligible_for_uptime` (both modes); recommender Troubleshoot + ticket-creation exclude
  active-departed (INSTALL backlog deliberately NOT filtered).

TDD: 8/8 e2e green (`test/device-departure-lifecycle.e2e-spec.ts`), tsc clean, regression sweep green
(device-state, master-sync, plant-deactivation, ticketing, recommender, dispatch).

## Backfill (Slice 2/3) — applied by master-sync run 64, verified 2026-07-18

The mechanism runs inside every master-sync, so the **first live sync IS the backfill**. Run 64 (a
manual `npm run autoplant:sync pipeline` at 03:28 UTC — scheduler OFF, no cron, no runs 65+) applied:

- **5,523 devices departed** — 4,436 UNDEPLOYED + 1,079 MISSING_FROM_SOURCE + 8 MAINTENANCE (absence
  path 5.1% of in-scope fleet, under the 10% guard).
- **4,552 open tickets cancelled** (`DEVICE_UNDEPLOYED_CLOSE`), 5,523 `DEVICE_DEPARTED` audit rows.
- `vehicles.status` truthful: 16,766 DEPLOYED / 4,435 UNDEPLOYED / 40 ACTIVE / 8 MAINTENANCE.

A dry-run preview (`npm run autoplant:departure-dryrun`, READ-ONLY) against the already-backfilled DB
found **0 new departures + 5 restores** — confirming idempotency.

### Before → after (SYSTEM-STATE §6 carries the same table)

| metric | before (pre-#128) | after |
|---|---|---|
| mirrored devices | 20,925 | 21,322 |
| departed | 0 | 5,523 |
| operational | 20,925 | 15,799 |
| eligible (all-deployed) | 20,925 (gate a no-op) | 15,799 (operational only) |
| is_inactive | ~6,000 | 2,943 |
| open tickets on departed | ~3,700 (est) | 0 (4,552 cancelled) |

### Verification (all confirmed)

- Departed devices: **0** eligible, **0** inactive, **0** SLA-bucketed.
- `eligible_for_uptime` (15,799) **exactly equals** operational — the gate now filters instead of
  passing 100%. (An interim `eligible=0` after run 64 was the standalone runner's settings stub forcing
  pgi mode; a corrective all-deployed recompute — `eligibility_mode` unchanged — restored 15,799.)
- Dispatch skips departed: recommender `device.departures none restoredAt:null`, ticket-creation
  `isDeparted:false`; 0 open tickets remain on departed devices.
- Fleet reconciles: operational + departed = 21,322.
- Reversible + idempotent; dashboards shrinking to the true operational fleet is the correct outcome.

## Acceptance criteria

- [x] `DEPLOYED → UNDEPLOYED` flip reflected after next sync (mirror + departure row + audit)
- [x] Insert scope pinned (mixed-status read creates only DEPLOYED/ACTIVE; `NOT_DEPLOYED_NEVER_KNOWN`)
- [x] Never-known-then-deployed device is created normally
- [x] Absence marked only on SUCCESS full read; partial/failed marks nothing; > N% aborts + alerts
- [x] Departed ⇒ ineligible (both modes), not inactive, `sla_bucket` NULL, `is_departed`; ticket-creation
      + recommender/dispatch skip it
- [x] Open-ticket cancel (`DEVICE_UNDEPLOYED`), audited, per-departure count
- [x] Re-deploy auto-restore, no manual step
- [x] Anti-drift: lifecycle pass is the only writer of `device_departures`
- [x] `master_sync_runs.entity_stats` carries `departures`/`restores`
- [x] Backfill dry-run + operator review + live pass; before/after in SYSTEM-STATE §6
- [ ] UI parity (ZM/OH departed tally, device-detail history, integration-health per-run) → **#129**

## Notes

- Scheduler untouched (`INGESTION_SCHEDULER_ENABLED=false`); `eligibility_mode` untouched (`all-deployed`).
- READ-ONLY dry-run tool added: `apps/backend/src/ingestion/autoplant/autoplant-departure-dryrun.ts`
  (`npm run autoplant:departure-dryrun`) — inspects the plan, never writes.
- Pre-existing #128 number collision (untracked `128-reaper-reaps-live-runs-zombie-resurrect.md`) —
  flagged for renumbering, not part of this issue.
