# 128 — Device deployment lifecycle: FSM never observes departures (stale-DEPLOYED mirror)

Status: DONE 2026-07-18 — mechanism `b9242da` (8/8 e2e); backfill applied by master-sync run 64
(**5,523 departed · 4,552 tickets cancelled**) and verified (eligible 0→15,799 operational-only,
departed excluded from inactive/SLA/eligibility, dispatch skips departed, fleet reconciles); before/
after in `docs/SYSTEM-STATE-2026-07.md` §6; completion report
`docs/progress/128-device-deployment-lifecycle.md`. **UI-parity ACs split to #129** (fast-follow). **Decisions taken 2026-07-17**: (2a) Option A, widen the READ to all
statuses + absence-diff safety net, with the **insert scope pinned to DEPLOYED/ACTIVE** (widening
the read must NOT widen the create); (2b) cancel open tickets with reason `DEVICE_UNDEPLOYED`;
(2e) backfill dry-run first, operator approves the counts before the live pass. Built TDD,
slice discipline per #119/#126.
Type: AFK (one HITL gate mid-build: the dry-run numbers)

> Source: investigation 2026-07-17,
> `docs/audits/deployment-lifecycle-investigation-2026-07-17.md` (all file:line + query evidence
> lives there — this file carries the ACs). Trigger: RR_D20710475 (plant 30783) dispatched in
> batch 59 while `deployment_status = UNDEPLOYED` at source.

## Problem (one paragraph)

Master sync reads `ap_masters.mst_vehicle` filtered to `deployment_status IN ('DEPLOYED')`
(`autoplant-master-source.ts:203`, default `:67`) and upserts only the rows returned
(`master-sync.service.ts:240-260`) — no code path ever touches an FSM row *absent* from the
read. A vehicle that leaves DEPLOYED is therefore frozen in FSM at `'DEPLOYED'` forever: all
20,856 FSM vehicles read DEPLOYED vs 15,652 actually deployed at source; ~37 % of FSM devices
are stale-DEPLOYED or vanished; **739 of 1,738 devices on live dispatch batches (42.5 %) are
UNDEPLOYED at source** (+118 absent by device_id); ~58 % of the 6,000-device "inactive"
population is departed devices; under `eligibility_mode='all-deployed'` the gate
(`device-state.service.ts:60-62`) is a no-op because the mirror holds only 'DEPLOYED'
(20,925/20,925 eligible). ~3,700 of 18,188 OPEN tickets target departed/vanished devices.

## Design (proposed — pending decisions)

FSM-owned lifecycle mirroring the #119 plant-deactivation posture (observe source, never
delete, reversible, audited, sync-durable). Full proposal in the evidence doc §2. Shape:

- `device_departures` side table (one active row per device, partial unique
  `WHERE restored_at IS NULL`; `observed_status`, `reason`, `detected_by_run_id`,
  `restored_at`/`restored_by_run_id`) + denormalised `device_states.is_departed`.
- **Decision 2a — APPROVED: Option A.** Widen the vehicle read to all statuses (~540 vs ~175
  daily queries, still ≤ 90 rows each) so `vehicles.status` mirrors truthfully, **plus** the
  absence-diff safety net (device absent from a SUCCESS full read ⇒ `MISSING_FROM_SOURCE`),
  guard-railed: partial/failed reads mark nothing; abort + alert if one run would mark > N % of
  the fleet.
  > **INSERT-SCOPE PIN (load-bearing).** The wider READ must **not** widen the CREATE. FSM
  > creates vehicles/devices **only** for observed status ∈ {DEPLOYED, ACTIVE}; the wider read
  > exists solely to observe transitions on entities FSM already knows (mark departures,
  > auto-restore on re-deploy). Never-deployed devices stay out of FSM — mirroring the full
  > ~48.5k catalog would take `vehicles` ~21k → ~48k and change the meaning of every dashboard
  > total and fleet denominator. **Supersedes the first draft** of the evidence doc §2a, which
  > proposed a whole-fleet registry to silence the ingest WARNs; that trade was rejected — the
  > WARNs persist and are tracked separately as log hygiene.
- **Decision 2b — APPROVED: cancel with reason `DEVICE_UNDEPLOYED`** — exact #119
  `cancelOpenTickets` semantics (failure cycle terminated, audited); a returned device that is
  still genuinely inactive gets a fresh ticket from the normal pipeline (nothing resurrected).
- Downstream: departed ⇒ `eligible_for_uptime=false` in BOTH eligibility modes;
  `is_inactive=false`, `sla_bucket=NULL` (a warehouse device isn't broken); recommender/dispatch
  hard-filter drop `DEVICE_DEPARTED` recorded in decision-trace drop buckets; ZM/OH dashboards
  get a separate "departed" tally (sibling of the deactivated-plants tally) so totals reconcile;
  integration-health shows per-run departures/restores; `master_sync_runs.entity_stats` grows
  `departures`/`restores`.
- Re-deployment: source shows DEPLOYED again ⇒ restore stamped (+audit), device resumes
  automatically; nothing destroyed.
- Unknown vocabulary (`DEPLOYED/UNDEPLOYED` ×4, `MAINTENANCE` ×157): treat ∉ {DEPLOYED, ACTIVE}
  as departed-equivalent, but log + surface unknown values (don't silently widen either way).

## Acceptance criteria

Mechanism (backend):
- [ ] A `DEPLOYED → UNDEPLOYED` flip at source is reflected in FSM after the next masters sync:
      truthful `vehicles.status`, active `device_departures` row (observed status, reason, run
      id), audit row `DEVICE_DEPARTED`.
- [ ] **Insert scope pinned:** a sync over the widened read creates vehicles/devices ONLY for
      observed status ∈ {DEPLOYED, ACTIVE}. A never-known UNDEPLOYED/MAINTENANCE row is skipped
      (counted in `master_sync_rejects` as `NOT_DEPLOYED_NEVER_KNOWN`, not silently dropped);
      FSM `vehicles` row count does not grow toward the ~48.5k catalog. Pinned by a test that
      runs a sync over a mixed-status read and asserts the created set.
- [ ] A never-known device that later appears as DEPLOYED is created normally (the create rule
      is status-based, not history-based) — re-deployment of an unknown device still works.
- [ ] A device absent from a **SUCCESS** full read is marked `MISSING_FROM_SOURCE`; a
      PARTIAL/FAILED read marks nothing; a run that would mark > N % (configurable) of
      operational devices aborts the departure pass and alerts, marking nothing.
- [ ] Departed device: `eligible_for_uptime=false` (both modes), `is_inactive=false`,
      `sla_bucket IS NULL`, `is_departed=true` after recompute; ticket creation skips it;
      recommender/dispatch drop it with a `DEVICE_DEPARTED` drop-bucket entry in the decision
      trace.
- [ ] Open-ticket handling per decision 2b, audited, with per-departure cancelled/suppressed
      count recorded.
- [ ] Re-deploy at source ⇒ departure row stamped restored (+`DEVICE_REDEPLOYED` audit), device
      eligible/ticketable again with **no manual step**; a still-inactive returned device gets a
      fresh ticket from the normal pipeline.
- [ ] Master-sync anti-drift preserved: the lifecycle pass is the only writer of
      `device_departures`; mirror update sets stay source-only (R4).
- [ ] `master_sync_runs.entity_stats` carries `departures`/`restores`; integration-health
      exposes them per run.

Backfill (current ~6.9k stale rows):
- [ ] Dry-run (report-only) mode emits the would-be departure list grouped by zone/plant before
      any live marking; **operator sign-off on the counts gates the live pass** (expected ~6.9k
      departed, ~3,700 tickets cancelled).
- [ ] Live backfill is the same audited, reversible mechanism (no special-case writes, no
      deletes); live batches self-clean via the 2b cancel.
- [ ] Before/after fleet + dashboard counts captured in `docs/SYSTEM-STATE-2026-07.md` (as the
      2026-07-13 zone application did). Dashboards shrinking substantially is the expected,
      correct outcome — honesty, not regression.

UI parity (same slice — surfacing rule):
- [ ] ZM + OH dashboards show the departed tally (per zone / fleet) alongside inactive +
      deactivated; fleet totals reconcile (operational + departed = mirrored fleet).
- [ ] Device detail page shows lifecycle status + departure/restore history.
- [ ] Integration health page shows per-run departures/restores.

Out of scope / untouched: scheduler flags, `eligibility_mode` value, #116 PGI feed, plant
deactivation (#119) semantics.

## Dependencies / notes

- Stale note retired by this investigation: the "~1,200 duplicate `tb_vehiclemaster.device_id`"
  concern (HANDOFF-autoplant-ingestion-2026-07-07 §risks) — **0 duplicates today** (aggregate,
  2026-07-17).
- Cross-ref added to `docs/audits/pipeline-risk-audit-2026-07-16.md` (§2 addendum line).
- Prod read budget respected in all options (≤ 90 rows/query); Option A adds ~365 daily queries
  vs the telemetry scan's ~32k/day.
