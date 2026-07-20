# 08 — Data Flow

## End-to-end pipeline (write side)

```mermaid
flowchart TD
  AP[(AutoPlant MySQL)] -->|"paginated <=90 rows, ACTIVE plants / DEPLOYED vehicles"| MS[MasterSyncService]
  MS -->|"upsert by source_*_id, FK order: companies→transporters→plants→vehicles→devices"| ORG[(company_master / transporters / plants / vehicles / devices)]
  MS -->|"unseen zone values → PENDING rows"| ZMAP[(zone_mappings)]
  ZMAP -->|"admin maps + reapply"| ORG
  MS -->|"skips itemised, capped 5000/run"| REJ[(master_sync_rejects)]

  AP -->|"keyset cursor on gps_datetime"| SW[SnapshotIngestionWorker]
  SW -->|"chunked, retry x3, ON CONFLICT DO NOTHING"| RAW[(raw_device_snapshots - daily partitions)]
  SW -->|run + chunk ledger| RUNS[(snapshot_runs / snapshot_run_chunks)]
  SW -->|"incremental latest_gps_datetime"| DST[(device_states)]

  DST2[DeviceStateService.recompute] -->|"set-based UPDATE: inactivity_hours, sla_bucket, eligible_for_uptime, denorm fitment"| DST
  PGI[(pgi_history)] --> DST2
  NOP[(non_operational_markings)] --> DST2
  DEACT[(plant_deactivations)] --> TCR

  DST --> TCR[TicketCreationService]
  TCR -->|"1 tx: failure_cycle + ticket + has_open_failure_cycle flip"| SPINE[(failure_cycles / tickets)]

  SPINE --> RECO[RecommenderService]
  CONF[(priority_rule_config / system_settings / se_planner / se_availability / se_van_stock)] --> RECO
  RECO -->|"SUGGESTED / UNASSIGNABLE + score_breakdown"| RECS[(recommendations)]

  RECS --> BA[BatchAssignmentService]
  BA -->|"tx + per-zone advisory lock"| PLAN[(work_schedules / plant_batch_assignments / batch_assignment_tickets)]
```

## Field-loop data flow (mutation side)

```mermaid
flowchart LR
  SEAPP[SE actions - today via admin/API] -->|soft states| SS[(soft_states)]
  SEAPP -->|troubleshoot form| TSUB[(troubleshooting_submissions)]
  TSUB -->|"component_unavailable=true"| CREQ[(component_request)] --> PAUSE["failure_cycle.sla_paused = WAITING_COMPONENT"]
  TSUB --> VRUN[(verification_runs)]
  RAW2[(new pings)] --> VSWEEP[VerificationService sweep]
  VSWEEP --> VRUN
  VSWEEP -->|"phase 2 pass"| CLOSE["ticket CLOSED / cycle VERIFIED"]
  VSWEEP -->|"fail"| FAILV["FAILED_VERIFICATION → repeat/escalation path"]
  TSUB -->|"consumption PRE_VERIFICATION"| ITX[(inventory_transactions)]
  CLOSE -->|DEDUCTED| ITX
  FAILV -->|ROLLED_BACK| ITX
  CONFLICT[409-loser submission] -->|SHADOW_USE| ITX --> WMREC[WM reconcile/dispute]
```

## Read-side data flow

- **Dashboards** (`DashboardService`) read `device_states` + `tickets` + queues — indexed,
  denormalised; never raw telemetry.
- **Reports** read pre-aggregated cubes written by the five aggregation services
  (delete+insert per month/day, idempotent):
  `device_downtime_summary_monthly`, `root_cause_summary_monthly`,
  `zm_performance_summary_monthly`, `system_efficiency_summary_daily`,
  `soft_inactive_count_history`.
- **Freshness banner**: `GET /snapshots/latest` → `snapshot_runs.data_as_of` (the conservative
  display watermark — never advances on failed chunks).
- **Explainability**: recommendation `score_breakdown` JSONB is append-only; the admin UI reads
  it verbatim for the "why suggested" view.

## State ownership matrix (who writes what)

| Table cluster | Sole writer |
|---|---|
| org mirror (companies/plants/vehicles/devices/transporters) | MasterSyncService (FSM-owned columns excluded from updates) |
| operational zone_id, zone_mappings, plant_zone_overrides, plant_deactivations | Admin endpoints (OH), applied via `reapply` — sync never touches them |
| raw_device_snapshots, snapshot_runs | SnapshotIngestionWorker only |
| device_states | DeviceStateService (recompute) + ingest (latest_gps_datetime) + ticket-creation (has_open_failure_cycle) |
| failure_cycles/tickets | TicketCreationService + lifecycle services (ticketing/*) |
| recommendations | RecommenderService (append-only) |
| work_schedules/batches | BatchAssignmentService + override/same-day services |
| report cubes | aggregation services only |
| audit_logs | AuditService only (in-transaction) |
