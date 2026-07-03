# 96 — AutoPlant `ap_masters` → FSM master synchroniser

Status: ready-for-human
Type: HITL (business-rule + external-access gates block completion)
Progress: core mechanism DONE (2026-07-03, branch `feat/autoplant-integration`, commit `83c5513`); the
remaining tail is gated on Ops-Head / AutoPlant decisions + VPN — see "Open gates" below.

> **Backlog-ownership item** flagged in the AutoPlant blueprint Appendix B ("the backlog has **no**
> dedicated issue for an `ap_masters` → FSM org-master sync"). Authorities:
> [`docs/architecture/autoplant-production-integration.md`](../../../docs/architecture/autoplant-production-integration.md)
> §5 (master-sync design), §7 (schema deltas), §14 (risks R4/R6/R13/R14);
> [`docs/architecture/zone-architecture-investigation.md`](../../../docs/architecture/zone-architecture-investigation.md)
> §Revision 3 (org hierarchy = AutoPlant-authoritative; FSM operational Zone = FSM-owned);
> local tracker `docs/architecture/autoplant-integration-progress-tracker.md` (Phase 4).

## Goal

Replace the synthetic org seed with a `MasterSyncService` that upserts FSM masters
(`company_master` / `plants` / `transporters` / `vehicles` / `devices`) from AutoPlant, keyed by
`source_*_id`, **preserving every FSM-owned overlay column** (operational `zone_id`, `deal_type`,
`ops_override`, company tier/rank, SE coverage/territory), with no destructive delete.

## Done (commit `83c5513`) — the decision-free mechanism

- `ingestion/autoplant/master-mapping.ts` — pure `mst_*` / `tb_vehiclemaster` → FSM
  `UpsertPlan {where, create, update}`, keyed by `source_*_id`. **Anti-drift is structural (Risk R4):**
  FSM-owned columns (`companyTier`/`companyPriorityRank`/`opsOverride`, `zoneId`/`districtId`,
  `dealType`) are excluded from every `update` set. 14 unit tests.
- `ingestion/autoplant/master-sync-run.service.ts` — `master_sync_runs` writer + single-in-flight guard
  (advisory lock + `master_sync_runs_one_in_flight` partial-unique index). 5 e2e tests.
- `ingestion/autoplant/master-sync.service.ts` — FK-ordered upsert (companies → transporters → plants →
  vehicles → devices) via injected `MasterSyncSource` / `PlantZoneResolver` / `MasterSyncScope` ports;
  **no scope ⇒ refuses to run** (R14 gate), unmappable plant ⇒ deferred (no invented UNZONED zone, R6),
  device synced only if its vehicle synced (no orphan fitment). 4 e2e tests.
- Migration `20260703120000` — nulls dangling `vehicles.transporter_id` then adds the FK
  (`ON DELETE SET NULL`); adds the run-guard index.
- `ingestion/autoplant/health.service.ts` + `GET /api/integration/health` (OpsHead) — source
  connectivity + master-sync/snapshot freshness. 4 e2e (service) + 3 e2e (HTTP).

## Open gates (block completion — DO NOT invent; route to the named owner)

| Ref | Decision needed | Owner | Consequence if wrong |
|---|---|---|---|
| **R14** | The **scope values** — which `mst_company.company_type` + `status` rows are FSM's fleet (mixes Shippers, Transporters, INACTIVE, test rows). The *mechanism* (`MasterSyncScope` predicate) ships; only the values are missing. | AutoPlant + Ops Head | Mirroring verbatim pollutes ops + the Fleet-Uptime denominator |
| **R6** | The `plant_state → FSM operational-zone` map + the breaking `plants.zone_id → nullable` migration (+ `UNZONED` holding zone + Ops-Head exception queue + ~16 cross-zone/planner/override call-site ripples). `PlantZoneResolver` port ships; the real resolver + migration are gated. | Ops Head | Wrong ZM row-scope / dashboard mis-scoping |
| **R13** | The real company **tier/rank** feed (CRM/SAP or Ops-Head seed). Insert-only safe default (`SILVER`/`C`) ships; the truth is not in AutoPlant. | Ops Head / SAP | Recommender canonical sort degenerates (all companies equal) |
| — | **`ap_masters` schema reconciliation** — exact `mst_plant` column identifiers (the source doc has DESCRIBEs for `mst_company`/`mst_transporter`/`mst_vehicle` but only a sample SELECT for `mst_plant`) + read-only VPN access to build & validate the real `AutoPlantMasterSource`. | AutoPlant DB team | The live reader can't be written faithfully or tested against real columns |

## Remaining engineering (unblocks once the gates clear)

- [ ] Real `AutoPlantMasterSource implements MasterSyncSource` over `ap_masters` (+ the master columns of
      `tb_vehiclemaster`), chunked reads (§5.7). **Blocked by** the `ap_masters` schema/VPN reconciliation.
- [ ] Concrete `PlantZoneResolver` (R6 map) + the `plants.zone_id` nullable migration + `UNZONED` +
      Ops-Head exception queue. **Blocked by R6.**
- [ ] Bind `MASTER_SYNC_SCOPE` from config once R14 lands; wire `MasterSyncService` into a Nest module.
- [ ] Phase 7 scheduler (`@nestjs/schedule` vs BullMQ — **architecture-HITL**) ordering
      master → snapshot → recompute → ticket → recommender, respecting the single-in-flight guards.
- [ ] Reconcile row counts FSM vs AutoPlant; confirm SE coverage/territory MV FKs still resolve; re-sync
      = no FSM-owned drift on live data.

## Acceptance

A scheduled full sync yields a consistent org graph scoped to FSM's fleet; a second sync is a no-op on
all FSM-owned data (asserted by the idempotency e2e already in place); `device_states` denominator
reconciles with AutoPlant deployed-device counts; no destructive deletes (INACTIVE rows mirrored via
`status`, retained).

Depends on: 02 (org/reference seed it supersedes for AutoPlant-owned masters), 04 (snapshot path/device
spine), 05 (device-state consumer). Related: 65 (AutoPlant vehicle-readiness — shares the source seam).
