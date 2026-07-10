# FSM GPS Field Service Management — Database Schema Blueprint

> **Status:** Database-first build blueprint · **Date:** 2026-06-08 · **Audience:** Senior backend engineers
> **Document type:** Database schema design. Implementation-ready for `schema.prisma` + PostgreSQL migrations. **No production service code.**
> **Stack (fixed):** Node.js 20 + Express + TypeScript (strict) + Prisma + PostgreSQL 16 + PostGIS + Redis 7 + BullMQ. **Not** NestJS.

---

## 0. Source Hierarchy & Method

This schema is **derived**, not transcribed. No table list was supplied; every table below is justified from the canonical sources in this precedence order. When two sources conflict, the higher wins.

| Precedence | Source | Authority for schema |
|---|---|---|
| 1 (highest) | `CONTEXT.md` | Domain rules, glossary, Decisions §1–§18, flagged-ambiguity resolutions, enum values |
| 2 | `docs/PRD-fsm-admin-dashboard.md` | Product/UI/API behaviour, page inventory, role matrix, report definitions |
| 3 | `docs/workflows/fsm-business-technical-workflow.md` | End-to-end flow, worker/table/API/state-machine catalogue (§24–§29) |
| 4 | `docs/backend/fsm-backend-low-level-design.md` | Architecture guidance, module map, prior data-model pass |
| 5 (lowest) | ADRs / root `prd.md` | History only — never overrides 1–4 |

**Derivation procedure actually followed:**
1. Read all sources end-to-end.
2. Extracted: **entities** (glossary §People/Geography/Work objects), **state machines** (CONTEXT §10, Failure Cycle / Ticket sub-types / Component / Non-Op / Verification / Voucher / Leave / Batch), **APIs** (PRD §26 / LLD §5), **mobile offline needs** (CONTEXT §SE Mobile App, idempotency), **reports** (PRD §29), **workers** (LLD §6 / workflow §24), **permissions** (CONTEXT §8 RBAC matrix), **audit** (CONTEXT §Audit, immutable closure fields).
3. Grouped entities into 17 schema domains.
4. Decided table-vs-view-vs-materialized-view-vs-derived-field per entity (§3, §7).
5. Justified every table's existence (§5, §6).

**Net result vs. the LLD's prior data-model pass:** this blueprint keeps the LLD's ~50 tables and **adds six tables the LLD under-specified** once you treat the database as primary (the sixth, `recommender_runtime_state`, was added in the 2026-06-08 schema grill):

| Added table | Why the LLD's model is insufficient | Authority |
|---|---|---|
| `warehouses` | LLD references `warehouse_id` on `warehouse_stock` / `inventory_transactions` but never defines a warehouse master — orphan FK. | CONTEXT §Inventory (Mother/Zone Warehouse are physical places) |
| `expected_components` | Decision §12: "`Ticket.expected_component` **becomes a multi-row child table**." LLD mentions it inline but never tables it; it is a Hard-Filter input. | CONTEXT Decision §12 |
| `device_uptime_daily` | Fleet Uptime % is **time-weighted over a month** (Decision §5); `device_states` holds only the *current* state (upsert) — no time-series exists to integrate over. | CONTEXT Decision §5, PRD §29 |
| `fleet_uptime_monthly` | The monthly contractual SLA number must be **stored, reproducible, and reportable per fleet/zone/company/plant**; recomputing on read from raw pings is neither cheap nor auditable. | CONTEXT Decision §5, PRD §29, workflow §29 |
| `recovery_details` | Recovery Tickets carry mandatory closure-audit data (collected `device_serial`, condition notes, `closure_type`) with no home; parallels `install_details`/`troubleshoot_details`. | CONTEXT §Recovery Ticket closure authority |
| `recommender_runtime_state` | Soft Inactive Count is a fleet/zone aggregate and the Recommender's DEFICIT/PREVENTIVE mode must be readable at run start — neither fits the per-device `device_states`. Daily rows also serve the §15 Q4 trend. | CONTEXT Decision §5, PRD §29 |

**Superseded (deliberately NOT modelled):** root-PRD `CUSTOMER_MASTER`/`customer_tier` → `company_master`; `REVIEW_PENDING` ticket state → dropped; `VERIFICATION_PENDING_COMPONENT` literal → Failure-Cycle `WAITING_COMPONENT`; `PENDING_REVIEW` batch state → removed (no approval gate); `trust_score=0.85` → `presence_source`; "Admin" role → `OPERATIONS_HEAD`; NG/Drishti source → AutoPlant DB.

---

## 1. Schema Design Summary

**Shape of the domain.** FSM is a **state-machine-and-audit system over a high-volume telemetry stream**. ~50k GPS devices emit pings into AutoPlant DB; the system snapshots them, derives inactivity, opens an immutable **Failure Cycle** + a **Ticket**, routes the Ticket to a finite SE pool via a deterministic **Recommender**, captures field work through an **offline-idempotent** mobile channel, and closes via **auto-verification** of recovery pings — recording every transition in an append-only audit log. Five forces dictate the schema:

| Force | Schema consequence |
|---|---|
| **Immutability of episodes** | `failure_cycles` immutable once `VERIFIED` (trigger-enforced); `audit_logs`, `ticket_events`, `recommendations`, `inventory_transactions`, `raw_device_snapshots` are append-only ledgers. |
| **One-active-episode invariants** | Partial unique indexes (one open cycle/device, one active mapping/device, one active batch membership/ticket, one in-flight snapshot run). |
| **Offline idempotency** | `(se_id, submission_type, client_submission_id)` ledger (`offline_submission_receipts`) + storage-level UQs on every SE-written table; inventory references the parent submission's lineage so retries never double-move stock. |
| **Telemetry volume** | `raw_device_snapshots` monthly range-partitioned; current state collapsed into `device_states` (1 row/device) + `device_uptime_daily` time-series for the monthly KPI. |
| **Multi-signal SLA & presence** | Two SLA clocks (primary pausable, secondary never-pauses) modelled with `sla_paused / sla_pause_reason / sla_accumulated_pause_seconds`; presence is `presence_source`, never a stored "confirmed" flag; SE Activity Status is **derived at query time**, never stored. |

**Counts.** 17 domains · **53 tables** · 3 materialized views · 4 query-time views · 2 partitioned tables · 20 Postgres-native enums + table-backed config for everything "implementation-defined".

**Hard database dependencies (non-negotiable):** PostgreSQL 16 (partial/exclusion constraints, range partitioning, `jsonb`, triggers, generated columns), **PostGIS** (`geometry`, `ST_Contains` for Floating-SE territory — Decision §6). Prisma is the schema source of truth; Postgres-only features are layered via raw-SQL migrations and `Unsupported("geometry…")`.

---

## 2. Source Reconciliation

Where sources disagree, the resolved schema decision and its authority:

| Topic | Lower-source claim | Resolved schema decision | Authority |
|---|---|---|---|
| Primary work view | root-PRD: Shared Pool is primary | `work_schedules`/`plant_batch_assignments` primary; Shared Pool is a **query** (`tickets WHERE status=OPEN AND assignment_state=UNASSIGNED AND plant_id ∈ coverage`), not a table | CONTEXT §Shared Pool, Decision §7 |
| Batch approval | root-PRD: ZM approves at 08:00 | **No** `PENDING_REVIEW`/`APPROVED` enum value; `plant_batch_assignments.status ∈ {AUTO_ASSIGNED,OVERRIDDEN,COMPLETED,PARTIAL}` | Decision §7 |
| Customer entity | root-PRD: `CUSTOMER_MASTER`, `customer_tier` | `company_master`, `company_tier`, `company_priority_rank` everywhere | CONTEXT §Company Master |
| Component-wait ticket state | root-PRD: `VERIFICATION_PENDING_COMPONENT` on Ticket | Ticket stays `OPEN`; `failure_cycles.state = WAITING_COMPONENT` is canonical | CONTEXT §Waiting Component, Decision §8 |
| Verification radius | root-PRD: every ping ±500m | `verification_runs` three-phase; ±500m only Phase-1 first ping (`verify_phase1_radius_m`) | Decision §9 |
| SLA pause for vehicle | ADR-0020: never pauses | `vehicle_unavailability_reports` pauses primary SLA (`pause_reason=VEHICLE_UNAVAILABLE`); raw readiness never does | CONTEXT §SLA, §Vehicle Unavailability Report |
| SLA resume after component | §Component-Request: "on RECEIVED" | Resume at **ZM-confirmed resubmit binding** (Decision §8 authoritative); `sla_resume_on_receipt` config switch reserved | Decision §8, LLD §19 Q3 |
| SE statuses | PRD §4.25: ON_SITE/BUSY/SHIFT_ENDING stored | **Derived** SE Activity Status (query-time view); stored model is `se_availability.status` only | Decision §10, CONTEXT §SE Activity Status |
| Admin persona | root-PRD: Admin role | No `ADMIN`; `users.role` enum tops out at `OPERATIONS_HEAD` | CONTEXT §Operations Head |
| Final SLA bucket | PRD: `AGED_CRITICAL` | `LONG_PENDING` canonical; `AGED_CRITICAL` not in enum | CONTEXT §SLA Bucket |
| Install trigger | root-PRD: auto from PGI | `install_trigger_source=MANUAL_OPERATIONS` (v1); `EXTERNAL_API` reserved (v2); PGI is eligibility-only | Decision §11 |

**Configurable-default convention.** Every value the sources leave "implementation-defined" (LLD §19, workflow §31) is a typed row in `system_settings` / `sla_config` / `priority_rule_config` with a launch default — never hard-coded, never a magic number in a column default that should be tunable.

---

## 3. Derived Data Domains

17 domains; each owns its writer tables. Module boundaries follow the LLD service map but the **database is the contract**.

| # | Domain | Tables | Core responsibility |
|---|---|---|---|
| D1 | Identity & Org | users, zones, regions, districts, plants, transporters, company_master, warehouses | Reference/config skeleton; RBAC actor + zone scoping |
| D2 | Assets | vehicles, devices, vehicle_device_mappings | Physical fleet; per-device-id verification anchor |
| D3 | Coverage | se_coverage, engineer_territory_coverage, engineer_master | Who is responsible for which Plant/Territory |
| D4 | Ingestion | snapshot_runs, snapshot_run_chunks, raw_device_snapshots, data_quality_errors, pgi_history | Telemetry intake (high volume) |
| D5 | Device State & KPI | device_states, device_uptime_daily, fleet_uptime_monthly | Current inactivity + Fleet Uptime time-series/rollup |
| D6 | Ticketing | failure_cycles, tickets, install_details, troubleshoot_details, recovery_details, expected_components, ticket_events | Work items + immutable episode + history |
| D7 | Soft State | soft_states | Real-time field-progress signals (not lifecycle) |
| D8 | Scheduling/Recommender | work_schedules, plant_batch_assignments, batch_assignment_tickets, recommendations, se_planner, intraday_insertions, cross_zone_escalations, recommender_runtime_state | Day Plan + auto-dispatch + explainability + mode/Soft-Inactive sink |
| D9 | Availability | se_availability, leave_requests, role_unavailability | Planning-level availability + backup cascade |
| D10 | Readiness | vehicle_readiness_state, vehicle_availability_signal, vehicle_unavailability_reports | Vehicle reachability + the only SLA vehicle-pause trigger |
| D11 | Forms & Idempotency | troubleshooting_submissions, submission_components, offline_submission_receipts | Offline-safe SE submissions |
| D12 | Inventory | component_master, component_serial, common_kit_definition, se_van_stock, warehouse_stock, inventory_transactions | Parts ledger + Shadow Use |
| D13 | Component Requests | component_requests | Warehouse fulfilment of unavailable parts |
| D14 | Verification | verification_runs | Three-phase auto-GPS verification |
| D15 | Vouchers | expense_vouchers, expense_voucher_items | SE reimbursement → Finance Excel |
| D16 | Non-Op & Recovery | non_operational_markings | Dual-confirmation exclusion + Recovery spawn |
| D17 | Notify, Audit, Config | notifications, audit_logs, system_settings, sla_config, priority_rule_config | Cross-cutting |

---

## 4. Entity Derivation Matrix

Each domain entity → the artefact chosen and why (table vs view vs MV vs derived field).

| Source entity (CONTEXT/PRD/workflow) | Artefact | Rationale for the choice |
|---|---|---|
| Service Engineer / managers | `users` (+ `engineer_master` 1:1 for SE-only profile) | Identity is a table; SE-specific columns (capacity, shift, `last_activity_at`) split to avoid wide nullable rows on managers |
| Zone / Region / District / Plant / Transporter | tables | Reference data with FKs; Plant carries geometry for territory lookup |
| Company / Company Tier / Priority Rank | `company_master` + columns | Tier/rank are columns (scoring gates), not separate tables |
| Device / Vehicle / Device Role mapping | tables; **`device_role` = column** on time-windowed `vehicle_device_mappings` | Role is an attribute of a mapping, not an entity; time-window needed for per-device-id verification |
| Inactive Device | **derived field** `device_states.is_inactive` | Computed from `latest_gps_datetime` vs threshold; never authored |
| SLA Bucket | **derived field** `device_states.sla_bucket` (recomputable) | Pure function of `inactivity_hours`; stored denormalised for fast queue queries, but authoritative at compute time (CONTEXT §9) |
| Failure Cycle | `failure_cycles` table | Immutable audit episode; first-class state machine |
| Ticket (TROUBLESHOOT/INSTALL/RECOVERY) | `tickets` + 3 sub-type child tables | Decision §4: one entity, `work_type` discriminator, sub-type fields in 1:1 children |
| Partial Recovery / Auto-Recovery | **derived sub-state** (badge) on `verification_runs.pings_received_count` / `outcome` | CONTEXT: `PARTIAL_RECOVERY` is a badge, not a stored lifecycle state |
| Soft State (VIEWED/ON_SITE/TROUBLESHOOT_STARTED) | `soft_states` table | Separate from `tickets.status`; multiple SEs may hold concurrently; non-lock |
| SE Activity Status | **query-time view** `v_se_activity_status` | CONTEXT explicit: "never stored as a separate field" |
| Presence | **derived field** `presence_source` on submission/soft-state | No "confirmed presence" entity; multi-signal enum |
| Work Schedule / Plant-wise Batch / Formal Assignment | `work_schedules`, `plant_batch_assignments`, `batch_assignment_tickets` | Formal Assignment = a row in batch tickets; not a separate table |
| Recommendation / history | `recommendations` (append-only) | Immutable; explainability `score_breakdown jsonb` |
| Shared Pool | **query, no table** | Just `tickets` filtered by coverage + UNASSIGNED+OPEN |
| Expected Component | `expected_components` table | Decision §12: multi-row child, Hard-Filter input |
| Common Kit | `common_kit_definition` table | Config list |
| SE Availability | `se_availability` time-windowed table | Decision §10 |
| SE Activity Ping | **derived field** `engineer_master.last_activity_at` | A timestamp column, not an event table (no audit value in retaining every ping) |
| Readiness | `vehicle_readiness_state` (current) + `vehicle_availability_signal` (evidence) | Current state derived from append-only signals; confidence decays |
| Vehicle Unavailability Report | `vehicle_unavailability_reports` table | Only SLA vehicle-pause trigger; auditable human signal |
| Snapshot | `snapshot_runs` + `snapshot_run_chunks` + `raw_device_snapshots` | Run header / chunk retry / telemetry rows |
| Technical Hint | **derived at display time** from latest `raw_device_snapshots` | CONTEXT hard constraint: advisory only, never stored, never affects lifecycle |
| Fleet Uptime % | `device_uptime_daily` (time-series) + `fleet_uptime_monthly` (rollup table) | Time-weighted monthly KPI needs persisted integration + reproducible report rows |
| Eligible Device | **materialized view** `device_eligibility` | Derived from PGI ≤15d AND not Non-Op CONFIRMED; refreshed daily + on change |
| Soft Inactive Count / Recommender mode | `recommender_runtime_state` table (one row per scope per run) | A fleet/zone aggregate has no home on per-device `device_states`; the twice-daily count + the `DEFICIT/PREVENTIVE` mode the Recommender reads need a real sink. Daily rows double as the §15 Q4 trend series. |
| Component Request | `component_requests` table | State machine, warehouse fulfilment |
| Inventory movement / Shadow Use / Faulty Return / Ticket Consumption | `inventory_transactions` (type/status enums) | Accounting categories are enum *values*, not tables (CONTEXT §Inventory) |
| Expense Voucher | `expense_vouchers` + `expense_voucher_items` | Header/lines; ≥1 photo across items |
| Non-Operational Marking | `non_operational_markings` table | Dual-confirmation state machine |
| Recovery Ticket | reuses `tickets` (`work_type=RECOVERY`) + `recovery_details` | No separate entity; Decision §4 |
| Cross-Zone Escalation | `cross_zone_escalations` table | Platinum auto + manual; reporting |
| Notification Delivery | `notifications` table | Per-channel delivery rows |
| Audit | `audit_logs` append-only | Single-tx with every mutation |
| Configurable defaults | `system_settings` / `sla_config` / `priority_rule_config` | Typed registry — no magic numbers |
| Floating-SE plant membership | **materialized view** `plant_eligible_floating_se` | Precomputed `ST_Contains` so hot path is an index lookup (Decision §6) |
| Plant Cluster Multiplier / weights | rows in `priority_rule_config` (versioned) | Tunable, audited per run |

---

## 5. Complete Derived Table Catalogue

53 tables. **W** = primary writer service(s), **R** = primary readers. PK is `id bigserial` unless noted; `created_at`/`updated_at timestamptz default now()` are present on every table and omitted from per-row listings.

| # | Table | Domain | PK | Append-only? | Partitioned? |
|---|---|---|---|---|---|
| 1 | users | D1 | user_id uuid | no | no |
| 2 | zones | D1 | zone_id bigserial | no | no |
| 3 | regions | D1 | region_id bigserial | no | no |
| 4 | districts | D1 | district_id bigserial | no | no |
| 5 | plants | D1 | plant_id bigserial | no | no |
| 6 | transporters | D1 | transporter_id bigserial | no | no |
| 7 | company_master | D1 | company_id bigserial | no | no |
| 8 | warehouses | D1 | warehouse_id bigserial | no | no |
| 9 | vehicles | D2 | vehicle_id bigserial | no | no |
| 10 | devices | D2 | device_id bigint (business) | no | no |
| 11 | vehicle_device_mappings | D2 | mapping_id bigserial | no | no |
| 12 | se_coverage | D3 | id | no | no |
| 13 | engineer_territory_coverage | D3 | id | no | no |
| 14 | engineer_master | D3 | engineer_id uuid (=user_id) | no | no |
| 15 | snapshot_runs | D4 | run_id bigserial | no | no |
| 16 | snapshot_run_chunks | D4 | id | no | no |
| 17 | raw_device_snapshots | D4 | id bigserial | **yes** | **yes (monthly)** |
| 18 | data_quality_errors | D4 | id | yes | no |
| 19 | pgi_history | D4 | id | yes | no |
| 20 | device_states | D5 | device_id bigint | no (upsert) | no |
| 21 | device_uptime_daily | D5 | (device_id, day) | yes | **yes (monthly)** |
| 22 | fleet_uptime_monthly | D5 | id | no (recompute-replace) | no |
| 23 | failure_cycles | D6 | cycle_id uuid | semi (immutable @VERIFIED) | no |
| 24 | tickets | D6 | ticket_id uuid | no | no |
| 25 | install_details | D6 | ticket_id uuid (FK PK) | no | no |
| 26 | troubleshoot_details | D6 | ticket_id uuid (FK PK) | no | no |
| 27 | recovery_details | D6 | ticket_id uuid (FK PK) | no | no |
| 28 | expected_components | D6 | id | no | no |
| 29 | ticket_events | D6 | event_id bigserial | **yes** | no |
| 30 | soft_states | D7 | soft_state_id bigserial | no | no |
| 31 | work_schedules | D8 | schedule_id bigserial | no | no |
| 32 | plant_batch_assignments | D8 | batch_id bigserial | no | no |
| 33 | batch_assignment_tickets | D8 | id | no | no |
| 34 | recommendations | D8 | recommendation_id bigserial | **yes** | no |
| 35 | se_planner | D8 | id | no | no |
| 36 | intraday_insertions | D8 | id | no | no |
| 37 | cross_zone_escalations | D8 | escalation_id bigserial | no | no |
| 37a | recommender_runtime_state | D8 | id bigserial | yes (daily rows) | no |
| 38 | se_availability | D9 | id | no | no |
| 39 | leave_requests | D9 | request_id bigserial | no | no |
| 40 | role_unavailability | D9 | id | no | no |
| 41 | vehicle_readiness_state | D10 | vehicle_id bigint | no (upsert) | no |
| 42 | vehicle_availability_signal | D10 | id | **yes** | no |
| 43 | vehicle_unavailability_reports | D10 | id | no | no |
| 44 | troubleshooting_submissions | D11 | submission_id uuid | no | no |
| 45 | submission_components | D11 | id | no | no |
| 46 | offline_submission_receipts | D11 | id | **yes** | no |
| 47 | component_master | D12 | component_id bigserial | no | no |
| 48 | component_serial | D12 | id | no | no |
| 49 | common_kit_definition | D12 | id | no | no |
| 50 | se_van_stock | D12 | id | no (upsert qty) | no |
| 51 | warehouse_stock | D12 | id | no (upsert qty) | no |
| 52 | inventory_transactions | D12 | txn_id bigserial | **yes** | no |
| 53 | component_requests | D13 | request_id uuid | no | no |
| 54 | verification_runs | D14 | run_id bigserial | no | no |
| 55 | expense_vouchers | D15 | voucher_id uuid | no | no |
| 56 | expense_voucher_items | D15 | item_id bigserial | no | no |
| 57 | non_operational_markings | D16 | marking_id uuid | no | no |
| 58 | notifications | D17 | notification_id bigserial | no | no |
| 59 | audit_logs | D17 | audit_id bigserial | **yes** | optional (monthly) |
| 60 | system_settings | D17 | key text | no | no |
| 61 | sla_config | D17 | id | no | no |
| 62 | priority_rule_config | D17 | id | no | no |

> Count note: 53 *domain* tables (incl. `recommender_runtime_state`, added in the 2026-06-08 grill) + 10 ledger/config/child tables that some teams count separately = 63 physical relations above. The "53" headline counts logical tables; the table list is exhaustive.

---

## 6. Detailed Table Definitions

Each block gives **purpose · columns (type, null/default) · FKs · UQ · indexes · checks · enums · writers · readers · frontend/API dep · worker dep · audit · retention**. Enums are listed once at first use and referenced thereafter.

### Enum registry (Postgres native enums)

```
role                : OPERATIONS_HEAD | CENTRAL_SERVICE_MANAGER | ZONAL_MANAGER | WAREHOUSE_MANAGER | SERVICE_ENGINEER
user_status         : ACTIVE | DISABLED
coverage_type       : DEDICATED | MULTI_PLANT | FLOATING
device_role         : PRIMARY | SECONDARY | BACKUP | COMPANY_SPECIFIC | TEMPORARY | UNKNOWN
deal_type           : RECURRING | ONE_TIME
company_tier        : PLATINUM | GOLD | SILVER
snapshot_status     : RUNNING | SUCCESS | FAILED | PARTIAL
chunk_status        : PENDING | SUCCESS | FAILED
sla_bucket          : WARNING | EARLY_RISK | RISK | CRITICAL | HIGH_CRITICAL | SEVERE | VERY_SEVERE | LONG_PENDING
failure_cycle_state : OPEN | WAITING_COMPONENT | SUBMITTED | VERIFIED | FAILED | REPEAT | ESCALATED
sla_pause_reason    : WAITING_COMPONENT | VEHICLE_UNAVAILABLE
work_type           : TROUBLESHOOT | INSTALL | RECOVERY
ticket_status       : (union, gated by work_type via CHECK — see tickets)
assignment_state    : UNASSIGNED | FORMALLY_ASSIGNED
install_trigger     : MANUAL_OPERATIONS | EXTERNAL_API
closure_type        : AUTO_CLOSED_ON_WAREHOUSE_RECEIPT | ZM_MANUAL_CLOSE | OPERATIONS_HEAD_OVERRIDE_CLOSE | CSM_ACTING_CLOSE | FAILED_RECOVERY_CLOSE
soft_state_type     : VIEWED | ON_SITE | TROUBLESHOOT_STARTED
onsite_source       : AUTO_GEOFENCE | MANUAL
schedule_status     : ACTIVE | OVERRIDDEN | COMPLETED | PARTIAL
batch_status        : AUTO_ASSIGNED | OVERRIDDEN | COMPLETED | PARTIAL
rec_path            : MORNING_BATCH | INTRADAY
insertion_state     : OFFERED | ACCEPTED | DECLINED | TIMED_OUT | REROUTED | ESCALATED
decline_reason      : AT_CAPACITY | TRAVEL_TOO_FAR | VEHICLE_TROUBLE | OTHER
escalation_decision : APPROVED | DENIED | DEFERRED
availability_status : AVAILABLE | ON_LEAVE | OFF_SHIFT | WEEKLY_OFF | SOFT_UNAVAILABLE | OFFLINE
avail_reason        : SICK | VACATION | HOLIDAY | DOCTOR | TRAINING | PERSONAL | NETWORK_OUT | OTHER
leave_type          : ON_LEAVE | WEEKLY_OFF
leave_status        : SUBMITTED | APPROVED | REJECTED
readiness           : AT_PLANT | UPCOMING_TRIP | ON_TRIP | STALE | UNKNOWN | WAITING_CONFIRMATION | AVAILABLE_FOR_REPAIR   (EXPECTED_BACK removed; UPCOMING_TRIP/ON_TRIP derived from external LR Date / Next Trip)
root_cause_category : POWER_ISSUE | SIM_NETWORK_ISSUE | GPS_ANTENNA_ISSUE | DEVICE_HARDWARE_FAULT | WIRING_ISSUE | CONFIGURATION_ISSUE | VEHICLE_ACCESS_ISSUE | INSTALLATION_ISSUE | CUSTOMER_SIDE_ISSUE | UNKNOWN
veh_unavail_reason  : VEHICLE_ON_TRIP | VEHICLE_NOT_AT_PLANT | DRIVER_NOT_AVAILABLE | CUSTOMER_REFUSED | OTHER
presence_source     : GEOFENCE_AUTO | MANUAL_ONSITE | FORM_GPS | NONE
submission_type     : TROUBLESHOOTING_FORM | EXPENSE_VOUCHER | COMPONENT_REQUEST | COMPONENT_RESUBMIT
receipt_outcome     : CREATED | DUPLICATE | CONFLICT
warehouse_type      : MOTHER | ZONE
inv_txn_type        : MOTHER_TO_ZONE | ZONE_TO_SE_RESTOCK | TICKET_CONSUMPTION | SHADOW_USE | FAULTY_COMPONENT_RETURNED | STOCK_ADJUSTMENT | VERIFICATION_ROLLBACK
inv_txn_status      : PRE_VERIFICATION | DEDUCTED | DEDUCTED_UNVERIFIED | ROLLED_BACK | SHADOW_USE | RECONCILED | DISPUTED
comp_req_status     : REQUESTED | APPROVED | REJECTED | SHIPPED | RECEIVED        (Phase-2 adds PENDING_APPROVAL | IN_TRANSIT | DELIVERED | CONFIRMED)
delivery_dest       : SE_LOCATION | PLANT_WAREHOUSE
verify_phase        : PENDING | PHASE_1_PASS | PHASE_2_PASS
verify_outcome      : CLOSED | FAILED_VERIFICATION | PARTIAL_RECOVERY | CLOSED_AUTO_RECOVERY | FAILED_ACTIVATION
voucher_status      : DRAFT | SUBMITTED | ZONAL_MANAGER_REVIEW | APPROVED | REJECTED | NEEDS_CLARIFICATION | PAID
expense_category    : TRAVEL | ACCOMMODATION | PARTS | TOOLS | MEAL | OTHER
nonop_state         : REQUESTED | AWAITING_CUSTOMER_CONFIRMATION | AWAITING_ZM_CONFIRMATION | CONFIRMED | ACTIVE | EXPIRED | UNMARKED
nonop_reason        : VEHICLE_SCRAPPED | VEHICLE_SOLD | VEHICLE_ACCIDENT | COMPANY_PAUSED | DEVICE_REPLACEMENT_PENDING | COMPLIANCE_HOLD | OTHER
notify_channel      : IN_APP | PUSH | SMS | WHATSAPP | EMAIL
notify_status       : QUEUED | SENT | DELIVERED | FAILED
settings_scope      : GLOBAL | ZONE
recommender_mode    : DEFICIT | PREVENTIVE
unable_reason       : COMPANY_REFUSED | VEHICLE_UNREACHABLE | DEVICE_MISSING | OTHER
uptime_scope        : FLEET | ZONE | COMPANY | PLANT
expected_src        : REPEAT_FAILURE | PARTIAL_DIAGNOSIS | INSTALL_SETUP | WAITING_COMPONENT_RESUBMIT
dq_severity         : BLOCKING | WARNING | INFO
escalation_trigger  : AUTO | MANUAL
```
> **Promoted from `text` (Grill 2026-06-08):** `unable_reason`, `uptime_scope`, `expected_src`, `dq_severity`, `escalation_trigger` were free-text columns whose value sets are fully closed in CONTEXT; they are now native enums. `tickets.closure_type` likewise uses the existing `closure_type` enum as its column type. Genuinely-open columns (`recommendations.status`, `component_serial.status`/`current_location`, `system_settings.value_type`) remain `text`.
> **`troubleshooting_submissions.submission_type`** reuses the existing `submission_type` enum, CHECK-constrained to the subset `{TROUBLESHOOTING_FORM, COMPONENT_RESUBMIT}` (the only two types that table holds).

> **`ticket_status` union** (validated against `work_type` by a CHECK + service guard):
> TROUBLESHOOT → `OPEN | SUBMITTED | VERIFICATION_PENDING | CLOSED | CLOSED_AUTO_RECOVERY | FAILED_VERIFICATION | ESCALATED | CLOSED_NON_OPERATIONAL`
> INSTALL → `REQUESTED | SCHEDULED | ON_SITE | FITTED | ACTIVATED | CLOSED | FAILED_ACTIVATION | CLOSED_NON_OPERATIONAL`
> RECOVERY → `REQUESTED | SCHEDULED | ON_SITE | COLLECTED | RECEIVED_AT_WAREHOUSE | CLOSED | FAILED_RECOVERY`

---

> **SE-typed FK convention (Grill 2026-06-08).** Every **SE-semantic** foreign key references **`engineer_master(engineer_id)`**, not the generic `users` table — so the database itself guarantees the referenced user is a `SERVICE_ENGINEER` and the Install-CSV/backfill/admin-tooling paths can't plant a non-SE UUID in an SE slot. This applies to: `tickets.se_id`, `se_coverage.se_id`, `engineer_territory_coverage.se_id`, `se_availability.engineer_id`, `leave_requests.se_id`, `work_schedules.se_id`, `plant_batch_assignments.se_id`, `recommendations.se_id`, `se_planner.se_id`, `intraday_insertions.current_se_id`, `soft_states.se_id`, `troubleshooting_submissions.se_id`, `component_requests.se_id`, `expense_vouchers.se_id`, `se_van_stock.se_id`, `vehicle_unavailability_reports.se_id`, `inventory_transactions.se_id`. Where a per-table listing below still reads `FK→users` for one of these columns, this convention overrides it. **Role-polymorphic** actor columns stay `→ users`: `tickets.created_by`, `role_unavailability.user_id`, `zones.zonal_manager_user_id`, `audit_logs.actor_id`, `*.set_by`/`reviewed_by`/`approved_by`/`confirmed_by`/`decided_by`/`removed_by`/`updated_by`. Consequence: `engineer_master` migrates in **M1** (right after `users`), and SE onboarding inserts the `engineer_master` row before any assignment can reference the SE.

### D1 — Identity & Org

#### `users`
- **Purpose:** every system account; RBAC actor and audit subject. No `ADMIN` (Operations Head is configurator).
- **Columns:** `user_id uuid PK` · `name text NOT NULL` · `role role NOT NULL` · `zone_id bigint NULL` (NULL for fleet-wide roles) · `phone text NOT NULL` · `email text NOT NULL` · `status user_status NOT NULL default 'ACTIVE'`.
- **FK:** `zone_id → zones`. **UQ:** `(email)`, `(phone)`. **Idx:** `(role)`, `(zone_id)`.
- **Check:** `role IN (...)`; `zone_id IS NOT NULL` required when `role='ZONAL_MANAGER'` (deferred trigger — a ZM must own a zone).
- **W:** Operations Head (account mgmt). **R:** AuthService, every service (actor lookup), dashboards.
- **Frontend/API:** auth/login, user-management page, `acted_as_role` banner. **Worker:** heartbeat→`role_unavailability` for manager roles. **Audit:** yes (account create/disable). **Retention:** permanent; `DISABLED` not deleted.

#### `zones`
- **Purpose:** coarse Plant rollup; unit of ZM authority and row-level scoping.
- **Columns:** `zone_id PK` · `name text NOT NULL` · `zonal_manager_user_id uuid NULL`.
- **FK:** `zonal_manager_user_id → users`. **UQ:** `(name)`. **Idx:** `(zonal_manager_user_id)`.
- **W:** Operations Head. **R:** Recommender, dashboards, escalation routing, `ZoneScopeGuard`. **Audit:** yes. **Retention:** permanent.

#### `regions` / `districts`
- **Purpose:** Indian admin geography for Floating-SE hierarchical coverage (~700 districts).
- **`regions`:** `region_id PK` · `name text NOT NULL` · `state text NOT NULL`. **UQ:** `(name)`.
- **`districts`:** `district_id PK` · `name text NOT NULL` · `state text NOT NULL` · `region_id bigint NULL FK→regions`. **UQ:** `(name, state)`. **Idx:** `(region_id)`.
- **W:** Operations Head / seed. **R:** territory lookup, `plant_eligible_floating_se` MV. **Audit:** config-change only. **Retention:** permanent (reference).

#### `plants`
- **Purpose:** physical site; primary clustering unit; carries geography for territory membership.
- **Columns:** `plant_id PK` · `name text NOT NULL` · `zone_id bigint NOT NULL` · `district_id bigint NOT NULL` · `location geometry(Point,4326) NULL` · `lat double precision NULL` · `lon double precision NULL`.
- **FK:** `zone_id→zones`, `district_id→districts`. **Idx:** `(zone_id)`; **GIST** `(location)`. **Check:** `lat BETWEEN -90 AND 90`, `lon BETWEEN -180 AND 180`.
- **W:** Operations Head. **R:** Recommender, coverage MV, dashboards (zone→plant drill-down). **Audit:** config. **Retention:** permanent.

#### `transporters`
- **Purpose:** logistics operator at a Plant; SE's field contact for vehicle access (PII surfaced only on Ticket Detail).
- **Columns:** `transporter_id PK` · `name text NOT NULL` · `plant_id bigint NOT NULL FK→plants` · `contact_phone text NULL`.
- **Idx:** `(plant_id)`. **W:** Operations Head / integration. **R:** SE mobile Ticket Detail (required for Vehicle Unavailability Report), dashboards. **Audit:** config. **Retention:** permanent. **Security:** `contact_phone` exposed only to authorised SE/ZM on Ticket Detail.

#### `company_master`
- **Purpose:** reference of all companies; top-level scoring gate (tier) + tie-break (rank).
- **Columns:** `company_id PK` · `name text NOT NULL` · `company_tier company_tier NOT NULL` · `company_priority_rank text NOT NULL` (`A`/`B`/…) · `contract_ref text NULL` · `source text NULL` (CRM/SAP) · `ops_override bool NOT NULL default false`.
- **Idx:** `(company_tier, company_priority_rank)`. **Check:** `company_priority_rank ~ '^[A-Z]$'`.
- **W:** integration + Operations Head override. **R:** Recommender (canonical sort), reports (per-company uptime). **Audit:** yes on override. **Retention:** permanent.

#### `warehouses`  *(added — fixes orphan `warehouse_id` FK)*
- **Purpose:** master of physical stock points (Mother national/regional + one Zone Warehouse per zone).
- **Columns:** `warehouse_id PK` · `name text NOT NULL` · `warehouse_type warehouse_type NOT NULL` · `zone_id bigint NULL FK→zones` (NULL for MOTHER) · `manager_user_id uuid NULL FK→users` · `location geometry(Point,4326) NULL`.
- **UQ partial:** `(zone_id) WHERE warehouse_type='ZONE'` (one Zone Warehouse per zone). **Check:** `warehouse_type='ZONE' ⇒ zone_id IS NOT NULL`.
- **W:** Operations Head. **R:** InventoryService, Recommender (Zone-Warehouse pickup planning), Warehouse Manager dashboards. **Audit:** config. **Retention:** permanent.

---

### D2 — Assets

#### `vehicles`
- **Purpose:** a vehicle carrying 1+ devices; coordination anchor (transporter, company, plant).
- **Columns:** `vehicle_id PK` · `vehicle_no text NOT NULL` · `plant_id bigint NOT NULL FK` · `transporter_id bigint NULL FK` · `company_id bigint NOT NULL FK`.
- **UQ:** `(vehicle_no)`. **Idx:** `(plant_id)`, `(company_id)`, `(transporter_id)`.
- **W:** integration / install. **R:** TicketCreation, SE mobile, verification, QR resolve. **Audit:** integration-sourced; changes audited. **Retention:** permanent.

#### `devices`
- **Purpose:** a single GPS unit; the **per-device-id** verification anchor.
- **Columns:** `device_id bigint PK` (business id from source) · `current_vehicle_id bigint NULL FK→vehicles` · `deal_type deal_type NULL` (NULL→Ops-Head manual tag fallback) · `device_type text NULL` · `sim_id text NULL`.
- **Idx:** `(current_vehicle_id)`, `(deal_type)`. **W:** integration / install / Operations Head. **R:** DeviceState, verification, Recovery (deal_type gate), eligibility. **Audit:** deal_type override audited. **Retention:** permanent.

#### `vehicle_device_mappings`
- **Purpose:** time-windowed Vehicle↔Device with role; one vehicle → many devices; enforces "one active mapping per device".
- **Columns:** `mapping_id PK` · `vehicle_id bigint NOT NULL FK` · `device_id bigint NOT NULL FK` · `device_role device_role NOT NULL` · `from_ts timestamptz NOT NULL` · `to_ts timestamptz NULL` (NULL=active).
- **UQ partial:** `(device_id) WHERE to_ts IS NULL` — **a device has exactly one active mapping** (invariant). **Idx:** `(vehicle_id, to_ts)`, `(device_id, from_ts DESC)`. **Check:** `to_ts IS NULL OR to_ts > from_ts`.
- **W:** Install ACTIVATED, integration. **R:** DeviceState, **verification (per-device-id, never per-vehicle)**. **Audit:** yes (mapping open/close). **Retention:** permanent (history of fitments).

---

### D3 — Coverage

#### `se_coverage`
- **Purpose:** Plant coverage for Dedicated/Multi-Plant SEs (the responsibility, not the geography).
- **Columns:** `id PK` · `se_id uuid NOT NULL FK→engineer_master` · `plant_id bigint NOT NULL FK` · `coverage_type coverage_type NOT NULL` (`DEDICATED|MULTI_PLANT`).
- **UQ:** `(se_id, plant_id)`. **Idx:** `(plant_id)`. **Check:** `coverage_type <> 'FLOATING'`; a Dedicated SE may hold only one row (enforced by partial UQ `(se_id) WHERE coverage_type='DEDICATED'`).
- **W:** Operations Head. **R:** Recommender precedence, `CoverageScopeGuard` (Shared Pool), dashboards. **Audit:** config. **Retention:** permanent.

#### `engineer_territory_coverage`
- **Purpose:** Floating-SE Territory — hierarchical (state/region/district) **and/or** polygon; membership = union.
- **Columns:** `id PK` · `se_id uuid NOT NULL FK→engineer_master` · `district_id bigint NULL FK` · `region_id bigint NULL FK` · `state text NULL` · `polygon geometry(MultiPolygon,4326) NULL`.
- **Idx:** `(se_id)`, **GIST** `(polygon)`. **Check:** at least one of `district_id/region_id/state/polygon` non-null.
- **W:** Operations Head. **R:** Recommender (PostGIS `ST_Contains`), `plant_eligible_floating_se` MV refresh. **Audit:** config. **Retention:** permanent.

#### `engineer_master`
- **Purpose:** SE-only profile + activity timestamp (kept off `users` to avoid wide nullable manager rows).
- **Columns:** `engineer_id uuid PK FK→users` · `coverage_type coverage_type NOT NULL` · `zone_id bigint NOT NULL FK` · `daily_capacity int NOT NULL` · `shift_start time NULL` · `shift_end time NULL` · `preferred_notification_channel notify_channel NULL` · `last_activity_at timestamptz NULL` (SE Activity Ping; **never** a background timer) · `is_active bool NOT NULL default true`.
- **Idx:** `(zone_id)`, `(last_activity_at)`. **Check:** `daily_capacity > 0`.
- **W:** Operations Head (profile), ActivityPing handler (`last_activity_at`). **R:** `v_se_activity_status` (1h OFFLINE label) **only** — `last_activity_at` is **visibility/audit only and never gates Recommender scoring, Morning Batch, Day Plan, assignment, intra-day update, or CRITICAL insertion** (the prior 15-min intra-day Hard Filter is removed; unreachable SEs are handled by the Acceptance Timeout + reroute, not a pre-emptive ping filter). **Audit:** profile changes audited; `last_activity_at` updates not audited (telemetry). **Retention:** permanent.

---

### D4 — Ingestion

#### `snapshot_runs`
- **Purpose:** one row per Snapshot ingestion run; drives the data-as-of banner; single-in-flight guard.
- **Columns:** `run_id PK` · `started_at timestamptz NOT NULL` · `finished_at timestamptz NULL` · `status snapshot_status NOT NULL default 'RUNNING'` · `cursor text NULL` · `data_as_of timestamptz NULL` · `chunk_stats jsonb NULL`.
- **UQ partial:** `(status) WHERE status='RUNNING'` (single in-flight; backed by advisory lock). **Idx:** `(status, started_at DESC)`.
- **W:** SnapshotIngestionWorker. **R:** dashboards (data-as-of, red alert on FAILED/stale), ops alerts. **Frontend/API:** `GET /api/snapshots/latest|runs`, `POST /api/snapshots/run`. **Worker:** SnapshotIngestionWorker. **Audit:** run lifecycle (start/finish/fail). **Retention:** 13 months then archive.

#### `snapshot_run_chunks`
- **Purpose:** per-chunk retry without restarting the run.
- **Columns:** `id PK` · `run_id bigint NOT NULL FK` · `chunk_no int NOT NULL` · `status chunk_status NOT NULL default 'PENDING'` · `retry_count int NOT NULL default 0` · `error text NULL`.
- **UQ:** `(run_id, chunk_no)`. **Idx:** `(run_id, status)`. **W/R:** SnapshotIngestionWorker. **Audit:** no (engineering telemetry). **Retention:** purge with parent run.

#### `raw_device_snapshots`  *(highest volume; partitioned)*
- **Purpose:** point-in-time telemetry per device; source for inactivity, verification pings, Technical Hints.
- **Columns:** `id bigserial` · `run_id bigint NOT NULL FK` · `device_id bigint NOT NULL` · `gps_datetime timestamptz NOT NULL` · `lat double precision NULL` · `lon double precision NULL` · `mains_status smallint NULL` · `mains_voltage numeric NULL` · `gps_validity text NULL` · `gps_mode text NULL` · `ignition_status text NULL` · `speed numeric NULL` · `creg text NULL` · `cgreg text NULL` · `csq smallint NULL` · `ip_address inet NULL` · `port_no int NULL` · `sim_subscriber_name text NULL` · `unit_no text NULL` · `device_type text NULL`.
- **PK:** `(id, gps_datetime)` (partition key must be in PK). **UQ:** `(device_id, gps_datetime)` → `INSERT … ON CONFLICT DO NOTHING` makes chunk re-runs idempotent. **Idx:** `(device_id, gps_datetime DESC)` (hot path for verification + latest-ping). **Partition:** RANGE by `gps_datetime`, **monthly**.
- **W:** SnapshotIngestionWorker. **R:** DeviceStateService, VerificationWorker, Technical Hints (display). **Audit:** no. **Retention:** **hot 3 months** in PG, then detach+archive to cold storage (S3/Parquet); 13-month online window configurable.

#### `data_quality_errors`  *(engineering-owned; never surfaced)*
- **Columns:** `id PK` · `device_id bigint NULL` · `severity dq_severity NOT NULL` · `field text NULL` · `detail text NULL` · `resolved bool NOT NULL default false`. **Idx:** `(resolved, severity)`.
- **W:** DeviceStateService. **R:** engineering only. **Audit:** no. **Retention:** 90 days.

#### `pgi_history`
- **Purpose:** SAP Post-Goods-Issue events; proof of active commercial use → eligibility.
- **Columns:** `id PK` · `device_id bigint NOT NULL FK` · `pgi_date date NOT NULL` · `order_ref text NULL`.
- **Idx:** `(device_id, pgi_date DESC)`. **W:** SAP integration. **R:** `device_eligibility` MV. **Audit:** no. **Retention:** 24 months (covers eligibility windows + reporting).

---

### D5 — Device State & KPI

#### `device_states`
- **Purpose:** derived current state, one row per device (upsert); the queue/dashboard hot table.
- **Columns:** `device_id bigint PK FK→devices` · `latest_gps_datetime timestamptz NULL` · `is_inactive bool NOT NULL default false` · `inactivity_hours numeric NULL` · `sla_bucket sla_bucket NULL` · `eligible_for_uptime bool NOT NULL default false` · `has_open_failure_cycle bool NOT NULL default false` · `vehicle_id bigint NULL` · `plant_id bigint NULL` · `company_id bigint NULL` · `transporter_id bigint NULL` · `computed_at timestamptz NOT NULL`.
- **Idx:** `(is_inactive, sla_bucket)`, `(plant_id)`, `(company_id)`, `(eligible_for_uptime)`. **Check:** `inactivity_hours >= 0`.
- **W:** DeviceStateService, SoftInactiveCountWorker. **R:** TicketCreation, Recommender, dashboards, Soft Inactive Count, Fleet Uptime feed. Mirrored to Redis `DEVICE_STATE_CACHE` (15-min TTL for open-ticket devices). **Audit:** no (derived). **Retention:** live (one row/device).

#### `device_uptime_daily`  *(added — Fleet Uptime time-series; partitioned)*
- **Purpose:** per-device per-day online fraction; the integrable time-series the monthly time-weighted KPI requires (which `device_states` cannot provide as a single-row upsert).
- **Columns:** `device_id bigint NOT NULL` · `day date NOT NULL` · `online_seconds int NOT NULL default 0` · `measured_seconds int NOT NULL default 0` · `eligible bool NOT NULL` · `zone_id bigint NULL` · `company_id bigint NULL` · `plant_id bigint NULL`.
- **PK:** `(device_id, day)`. **Idx:** `(day, zone_id)`, `(day, company_id)`. **Check:** `online_seconds BETWEEN 0 AND measured_seconds`. **Partition:** RANGE by `day`, monthly.
- **W:** DeviceStateService (daily roll from `raw_device_snapshots`/`device_states` transitions). **R:** FleetUptimeMonthlyWorker. **Audit:** no. **Retention:** 24 months online; archive beyond.

#### `fleet_uptime_monthly`  *(added — persisted contractual KPI rollup)*
- **Purpose:** the stored, reproducible monthly Fleet Uptime % per reporting scope; the number on company SLA reports.
- **Columns:** `id PK` · `period_month date NOT NULL` (first-of-month) · `scope uptime_scope NOT NULL` · `scope_id bigint NULL` · `eligible_device_count int NOT NULL` · `uptime_pct numeric(5,2) NOT NULL` · `computed_at timestamptz NOT NULL` · `weight_set_ref text NULL`.
- **UQ:** `(period_month, scope, scope_id)`. **Idx:** `(period_month)`, `(scope, scope_id)`. **Check:** `uptime_pct BETWEEN 0 AND 100`.
- **W:** FleetUptimeMonthlyWorker (recompute-replace, idempotent on `(zone,month)`). **R:** `/reports`, company SLA export. **Audit:** recompute logged. **Retention:** permanent (contractual).

---

### D6 — Ticketing

#### `failure_cycles`
- **Purpose:** immutable audit record of one inactivity episode; parent of exactly one Troubleshoot Ticket; SLA primary-clock anchor.
- **Columns:** `cycle_id uuid PK` · `device_id bigint NOT NULL FK` · `state failure_cycle_state NOT NULL default 'OPEN'` · `opened_at timestamptz NOT NULL` · `closed_at timestamptz NULL` · `previous_failure_cycle_id uuid NULL FK→self` · `repeat_failure bool NOT NULL default false` · `sla_paused bool NOT NULL default false` · `sla_pause_reason sla_pause_reason NULL` · `sla_paused_at timestamptz NULL` · `sla_pause_source text NULL` · `sla_accumulated_pause_seconds bigint NOT NULL default 0` · `version int NOT NULL default 0`.
- **UQ partial:** `(device_id) WHERE state IN ('OPEN','WAITING_COMPONENT','SUBMITTED')` — **one active episode per device**. **Idx:** `(state)`, `(device_id, opened_at DESC)`, `(previous_failure_cycle_id)`. **Check:** `sla_paused = (sla_pause_reason IS NOT NULL)`; `closed_at IS NULL OR closed_at >= opened_at`.
- **W:** TicketCreation, VerificationWorker, ComponentRequest, SLA logic. **R:** Recommender, dashboards, reports. **Audit:** every transition (CONTEXT §Audit; Decision §15 acted-as-role). **Immutability:** UPDATE refused on `VERIFIED` rows except audit-neutral fields (service guard + DB trigger). **Retention:** permanent.

#### `tickets`
- **Purpose:** unified actionable work item; `work_type` discriminator; shared Recommender/Day Plan/capacity.
- **Columns:** `ticket_id uuid PK` · `work_type work_type NOT NULL` (immutable) · `status ticket_status NOT NULL` · `failure_cycle_id uuid NULL FK` (NULL for INSTALL/RECOVERY) · `device_id bigint NOT NULL FK` · `vehicle_id bigint NULL FK` · `plant_id bigint NOT NULL FK` · `company_id bigint NOT NULL FK` · `se_id uuid NULL FK→engineer_master` (current assignee) · `assignment_state assignment_state NOT NULL default 'UNASSIGNED'` · `install_trigger_source install_trigger NULL` · `created_by uuid NULL FK→users` · `created_by_role role NULL` · `closure_type closure_type NULL` · `company_tier company_tier NOT NULL` (denormalised at creation from `company_master`; powers the Platinum aging scan and the Company-Tier-gate skip report without a join) · `import_batch_ref uuid NULL` (stamped identically on all rows of one Install CSV upload — Decision §11; lets a batch be found/cancelled post-hoc) · `last_state_changed_at timestamptz NOT NULL` (set on **every** lifecycle `status` transition only — **not** on incidental edits like reassignment or note changes; the true no-progress clock for stale-lifecycle scans) · `repeat_failure bool NOT NULL default false` · `version int NOT NULL default 0`.
- **FK:** `se_id → engineer_master(engineer_id)` (SE-typed FK — guarantees the assignee is a SERVICE_ENGINEER). **UQ:** `(failure_cycle_id)` — one Ticket per Failure Cycle. **Idx:** `(status, plant_id)`, `(se_id, status)`, `(work_type, status)`, `(company_id)`, partial `(plant_id) WHERE status='OPEN' AND assignment_state='UNASSIGNED'` (Shared Pool); partial `(created_at) WHERE status='OPEN' AND assignment_state='UNASSIGNED' AND company_tier='PLATINUM'` (`ix_tk_escalate`, Platinum cross-zone auto-escalation scan); partial `(last_state_changed_at) WHERE work_type='RECOVERY' AND status NOT IN ('CLOSED','FAILED_RECOVERY')` (`ix_tk_recovery_stale`, 14-day no-progress scan — keyed on last *state* change, not `updated_at`); partial `(device_id, plant_id) WHERE status NOT IN (closed set)` (`ix_tk_device_active`, QR resolve); partial `(vehicle_id, plant_id) WHERE status NOT IN (closed set)` (`ix_tk_vehicle_active`, QR resolve). **Check:** `work_type='TROUBLESHOOT' ⇒ failure_cycle_id IS NOT NULL`; `work_type='INSTALL' ⇒ created_by IS NOT NULL AND created_by_role IS NOT NULL`; status∈work_type's allowed set (CHECK function).
- **W:** TicketCreation, Install, Recovery, verification, schedule services. **R:** Recommender, SE mobile (Day Plan, Shared Pool, scan), dashboards. **Frontend/API:** `/api/tickets/*`, `/api/me/day-plan`, `/api/me/shared-pool`. **Worker:** TicketCreation, Verification, IntraDay, RepeatFailureScan. **Audit:** every transition (+ `ticket_events`). **Retention:** permanent.

#### `install_details` · `troubleshoot_details` · `recovery_details` (1:1 children)
- **Purpose:** sub-type-specific fields, keyed `ticket_id uuid PK FK→tickets`.
- **`install_details`:** `device_serial text NULL` · `sim_serial text NULL` · `target_date date NULL` · `fitted_at timestamptz NULL` · `activated_at timestamptz NULL` (warranty anchor) · `notes text NULL`. **Check:** `activated_at IS NULL OR device_serial IS NOT NULL` (no activation without serials).
- **`troubleshoot_details`:** `diagnosis_summary text NULL` · `last_submission_id uuid NULL FK→troubleshooting_submissions`.
- **`recovery_details`:** `collected_device_serial text NULL` · `condition_notes text NULL` · `collected_at timestamptz NULL` · `received_at_warehouse_at timestamptz NULL` · `warehouse_id bigint NULL FK` · `unable_reason_code unable_reason NULL` · `closure_reason text NULL`.
- **W:** Install/Troubleshoot/Recovery services. **R:** verification, dashboards, reports. **Audit:** closure fields mandatory-audited (CONTEXT §Recovery). **Retention:** permanent.

#### `expected_components`  *(added — Decision §12 multi-row child)*
- **Purpose:** components the system predicts a Ticket needs; Hard-Filter input + Expected-Component leg.
- **Columns:** `id PK` · `ticket_id uuid NOT NULL FK` · `component_id bigint NOT NULL FK` · `source expected_src NOT NULL` · `quantity int NOT NULL default 1` · `resolved bool NOT NULL default false`.
- **UQ:** `(ticket_id, component_id)`. **Idx:** `(ticket_id) WHERE resolved=false`. **W:** TicketCreation, RepeatFailureScan, ComponentRequest. **R:** Recommender Hard Filter, Component-Blocked Queue. **Audit:** no. **Retention:** with ticket.

#### `ticket_events`  *(append-only)*
- **Purpose:** Ticket lifecycle history (complements `audit_logs`, narrower/faster for the history UI).
- **Columns:** `event_id bigserial PK` · `ticket_id uuid NOT NULL FK` · `from_state text NULL` · `to_state text NOT NULL` · `actor_id uuid NULL FK→users` · `actor_role role NULL` · `acted_as_role role NULL` · `reason_code text NULL` · `at timestamptz NOT NULL default now()`.
- **Idx:** `(ticket_id, at)`. **W:** all Ticket-mutating services. **R:** history UI, reports (plant clearance, starve depth). **Audit:** is itself audit-adjacent. **Retention:** permanent.

---

### D7 — Soft State

#### `soft_states`
- **Purpose:** temporary SE field-progress signals; **not** a lifecycle state, **not** a lock; multiple SEs may hold concurrently; primary input to derived SE Activity Status.
- **Columns:** `soft_state_id bigserial PK` · `ticket_id uuid NOT NULL FK` · `se_id uuid NOT NULL FK→engineer_master` · `type soft_state_type NOT NULL` · `onsite_source onsite_source NULL` (ON_SITE only) · `set_at timestamptz NOT NULL default now()` · `timeout_at timestamptz NULL` (VIEWED only) · `resolved_at timestamptz NULL` · `resolved_by text NULL` (`SE|ZM|SYSTEM`) · `resolution_reason text NULL` (mandatory for ZM force-resolve).
- **UQ partial:** `(ticket_id, se_id, type) WHERE resolved_at IS NULL` (`ux_ss_active`) — one active soft state of each type per SE per ticket (multiple *different* SEs may still hold concurrently; a double-tap/retry can't create a duplicate). **Idx:** partial `(ticket_id) WHERE resolved_at IS NULL`, `(se_id, resolved_at)`; partial `(timeout_at) WHERE resolved_at IS NULL AND type='VIEWED'` (`ix_ss_viewed_timeout`, SoftStateTimeoutWorker); partial `(set_at) WHERE resolved_at IS NULL` (`ix_ss_stale`, stale-work warning sweep). **Check:** `type='VIEWED' ⇒ timeout_at IS NOT NULL`; `type<>'VIEWED' ⇒ timeout_at IS NULL` (ON_SITE/TROUBLESHOOT_STARTED never time-expire); `onsite_source IS NULL OR type='ON_SITE'`.
- **W:** SE mobile, ZM (force-resolve), SYSTEM (valid closure). **R:** ZM dashboard (Activity Status, override conflict checks). **Frontend/API:** `/api/tickets/{id}/soft-state*`. **Audit:** ZM force-resolve audited (`OVERRIDE_AFTER_ON_SITE`). **Retention:** keep resolved rows ≥ 1 year for audit trail, then archive.

---

### D8 — Scheduling / Recommender

#### `work_schedules`
- **Purpose:** primary scheduling entity; groups batches for an SE over a date/range; auto-dispatched (no approval gate).
- **Columns:** `schedule_id bigserial PK` · `se_id uuid NOT NULL FK→engineer_master` · `zone_id bigint NOT NULL FK` · `date_from date NOT NULL` · `date_to date NOT NULL` · `status schedule_status NOT NULL default 'ACTIVE'` · `source text NOT NULL` (`SYSTEM_GENERATED|ZM_MANUAL`) · `dispatched_at timestamptz NULL` · `last_overridden_by uuid NULL` · `last_overridden_at timestamptz NULL`.
- **Idx:** `(se_id, date_from)`, `(zone_id, status)`. **Check:** `date_to >= date_from`; **no** `DRAFT/PENDING_REVIEW/APPROVED` value exists in `schedule_status`.
- **W:** BatchAssignmentWorker, ScheduleService, ZonalOverride. **R:** SE mobile Day Plan, ZM dashboard. **Frontend/API:** `/api/schedules/*`, `/api/me/day-plan`. **Worker:** BatchAssignment, IntraDay. **Audit:** override audited. **Retention:** 13 months then archive.

#### `plant_batch_assignments`
- **Purpose:** a Plant's open Tickets assigned as a unit to one SE — the Work Schedule building block.
- **Columns:** `batch_id bigserial PK` · `schedule_id bigint NOT NULL FK` · `plant_id bigint NOT NULL FK` · `se_id uuid NOT NULL FK→engineer_master` · `status batch_status NOT NULL default 'AUTO_ASSIGNED'` · `stop_sequence int NULL` · `override_reason text NULL`.
- **Idx:** `(schedule_id)`, `(se_id, status)`, `(plant_id)`. **Check:** `status IN ('AUTO_ASSIGNED','OVERRIDDEN','COMPLETED','PARTIAL')`.
- **W:** BatchAssignment, ScheduleService, ZonalOverride. **R:** SE mobile, ZM dashboard, batch-completion report. **Frontend/API:** `/api/batches/{id}/override`. **Audit:** override reason-coded + audited. **Retention:** with schedule.

#### `batch_assignment_tickets`
- **Purpose:** join Tickets into a batch with order; "one active batch membership per ticket".
- **Columns:** `id PK` · `batch_id bigint NOT NULL FK` · `ticket_id uuid NOT NULL FK` · `sort_order int NOT NULL` · `deferred_to_date date NULL` · `removed_at timestamptz NULL` · `removed_by uuid NULL`.
- **UQ partial:** `(ticket_id) WHERE removed_at IS NULL` — a ticket is in one active batch at a time. **Idx:** `(batch_id, sort_order)`. **W/R:** as parent. **Audit:** remove/defer audited. **Retention:** with batch.

#### `recommendations`  *(append-only; explainability)*
- **Purpose:** system-generated SE↔Ticket binding committed directly as Formal Assignment; "why suggested?" record; intra-day retry chain.
- **Columns:** `recommendation_id bigserial PK` · `ticket_id uuid NOT NULL FK` · `se_id uuid NULL FK→engineer_master` · `company_tier company_tier NULL` · `device_bucket sla_bucket NULL` · `score_breakdown jsonb NOT NULL` (weighted components + multipliers + `weight_set_ref`) · `processing_rank int NULL` · `status text NOT NULL` · `path rec_path NOT NULL` · `retry_chain jsonb NULL`.
- **Idx:** `(ticket_id)`, `(se_id)`. **W:** BatchAssignment, IntraDay. **R:** ZM "why suggested?" panel, starve-depth report, audit. **Audit:** immutable — corrections create new rows. **Retention:** 13 months then archive.

#### `se_planner`
- **Purpose:** ZM-authored plant-vs-date visit intent; bias signal to Morning Batch (not a hard constraint).
- **Columns:** `id PK` · `se_id uuid NOT NULL FK→engineer_master` · `plant_id bigint NOT NULL FK` · `planned_date date NOT NULL`.
- **UQ:** `(se_id, plant_id, planned_date)`. **Idx:** `(planned_date)`. **W:** ZM. **R:** BatchAssignment (bias), Day Plan. **Audit:** no. **Retention:** 6 months.

#### `intraday_insertions`
- **Purpose:** SE-Acceptance flow for urgent CRITICAL/HIGH_CRITICAL insertions; timeout/reroute/escalate.
- **Columns:** `id PK` · `ticket_id uuid NOT NULL FK` · `current_se_id uuid NULL FK→engineer_master` · `state insertion_state NOT NULL default 'OFFERED'` · `offered_at timestamptz NOT NULL` · `acceptance_deadline timestamptz NOT NULL` · `decline_reason_code decline_reason NULL` · `retry_no int NOT NULL default 0`.
- **Idx:** `(ticket_id, retry_no)`, `(state)`. **W:** IntraDayWorker. **R:** ZM Intra-day Queue, SE accept/decline. **Frontend/API:** `/api/insertions/{id}/accept|decline`. **Worker:** IntraDay (Acceptance Timeout, ×3 retry → escalate). **Audit:** yes. **Retention:** 13 months.

#### `cross_zone_escalations`
- **Purpose:** Platinum auto-escalation + manual cross-zone requests; capacity-planning signal.
- **Columns:** `escalation_id bigserial PK` · `ticket_id uuid NOT NULL FK` · `trigger escalation_trigger NOT NULL` · `trigger_reason text NULL` · `home_zone_id bigint NOT NULL FK` · `target_zone_id bigint NULL FK` · `requesting_role role NULL` · `approving_role role NULL` · `decision escalation_decision NULL` · `decided_at timestamptz NULL`.
- **Idx:** `(home_zone_id)`, `(ticket_id)`. **W:** IntraDay, ZM, CSM. **R:** Operations Head reports, dashboards. **Frontend/API:** `/api/tickets/{id}/escalate-cross-zone`. **Audit:** yes. **Retention:** permanent (governance).

#### `recommender_runtime_state`  *(added — Soft Inactive Count + deficit/preventive mode sink)*
- **Purpose:** the home for the twice-daily **Soft Inactive Count** and the **`DEFICIT`/`PREVENTIVE`** mode the Recommender reads at run start. `device_states` is per-device and cannot hold a fleet/zone aggregate; this table is the only sink. Daily rows also serve as the §15 Q4 Soft-Inactive-Count trend series.
- **Scope of influence (hard boundary):** this is a **planning/scoring bias only** — it tunes *what the Recommender emphasises* (deficit clearing vs. preventive backlog) and weight emphasis within a batch run. It **must never override the canonical assignment gates**: Company Tier → Device (SLA) Bucket order (Decision §17), SE coverage scope, SE availability (`AVAILABLE`), Daily Capacity, `ON_TRIP` readiness blocking, component availability (Common Kit + expected-component Hard Filter), or ZM override authority. Mode never promotes an ineligible candidate, never reorders the tier/bucket gate, and never assigns outside coverage.
- **Columns:** `id bigserial PK` · `scope text NOT NULL` (`FLEET|ZONE`) · `scope_id bigint NULL` (zone_id when `scope='ZONE'`) · `computed_at timestamptz NOT NULL` · `soft_inactive_count int NOT NULL` · `eligible_count int NOT NULL` · `mode recommender_mode NOT NULL` · `threshold_pct numeric NOT NULL`.
- **UQ:** `(scope, scope_id, computed_at)`. **Idx:** `(scope, scope_id, computed_at DESC)`. **Check:** `scope='ZONE' ⇒ scope_id IS NOT NULL`; `soft_inactive_count >= 0`; `eligible_count >= 0`.
- **W:** SoftInactiveCountWorker (twice daily; idempotent on `(scan_slot, date)`). **R:** BatchAssignmentWorker (mode gate at run start), `/reports` (Soft Inactive trend). **Audit:** no (operational telemetry). **Retention:** 13 months then archive.

---

### D9 — Availability

#### `se_availability`
- **Purpose:** single time-windowed availability table; only `AVAILABLE` lets the Recommender include the SE.
- **Columns:** `id PK` · `engineer_id uuid NOT NULL FK→engineer_master` · `from_ts timestamptz NOT NULL` · `to_ts timestamptz NULL` · `status availability_status NOT NULL` · `reason_code avail_reason NULL` · `set_by uuid NULL FK→users` · `set_by_role role NULL` · `activity_sourced bool NOT NULL default false` (heartbeat OFFLINE; excluded from leave reports) · `notes text NULL`.
- **Constraint:** EXCLUDE on `(engineer_id WITH =, tstzrange(from_ts,to_ts) WITH &&)` per status family (no overlapping windows). **Idx:** GIST `(engineer_id, tstzrange(from_ts, coalesce(to_ts,'infinity')))`. **Check:** SE may only self-write `SOFT_UNAVAILABLE`/`OFFLINE` (service guard — SE cannot write `ON_LEAVE`/`WEEKLY_OFF`).
- **W:** ZM, SE (soft-unavailable only), LeaveAvailability, heartbeat (OFFLINE). **R:** Recommender Hard Filter, `v_se_activity_status`, dashboards. **Frontend/API:** `/api/me/soft-unavailable`, leave decision. **Audit:** ZM-set leave audited with `set_by_role`. **Retention:** 24 months.

#### `leave_requests`
- **Purpose:** SE-initiated planned absence; ZM approval writes a time-windowed `se_availability` row.
- **Columns:** `request_id bigserial PK` · `se_id uuid NOT NULL FK→engineer_master` · `leave_type leave_type NOT NULL` · `start_date date NOT NULL` · `end_date date NOT NULL` · `reason text NULL` · `status leave_status NOT NULL default 'SUBMITTED'` · `decided_by uuid NULL FK` · `decided_reason text NULL`.
- **Idx:** `(se_id, status)`. **Check:** `end_date >= start_date`; SE cannot self-approve (service: `decided_by <> se_id`). **W:** SE mobile, ZM. **R:** LeaveAvailability, dashboards. **Frontend/API:** `/api/leave-requests/*`. **Audit:** decision audited. **Retention:** 24 months.

#### `role_unavailability`
- **Purpose:** backup-cascade availability for ZM/CSM/Operations Head (distinct routing semantics from `se_availability`).
- **Columns:** `id PK` · `user_id uuid NOT NULL FK` · `role role NOT NULL` · `from_ts timestamptz NOT NULL` · `to_ts timestamptz NULL` · `set_by uuid NULL FK` · `reason text NULL` · `source text NOT NULL` (`SELF|HIGHER_ROLE|HEARTBEAT`).
- **Idx:** `(user_id, from_ts)`, `(role)`. **W:** self, higher role, heartbeat. **R:** escalation routing, acting-role resolution (`acted_as_role`). **Audit:** yes (activation up/down notifications). **Retention:** 24 months.

---

### D10 — Readiness

#### `vehicle_readiness_state`
- **Purpose:** current confidence-scored reachability per vehicle (derived from signals).
- **Columns:** `vehicle_id bigint PK FK` · `readiness readiness NOT NULL default 'UNKNOWN'` · `confidence numeric NULL` · `last_signal_at timestamptz NULL` · `computed_at timestamptz NOT NULL`.
- **Idx:** `(readiness)`. **W:** ReadinessService. **R:** Recommender Hard Filter (`ON_TRIP` drop; `STALE`/`UNKNOWN` = conflict signal, not drop), dashboards. **Audit:** no (derived). **Retention:** live.

#### `vehicle_availability_signal`  *(append-only evidence)*
- **Purpose:** raw readiness evidence; confidence = trust × freshness-decay; >120min ⇒ STALE.
- **Columns:** `id PK` · `vehicle_id bigint NOT NULL FK` · `source text NOT NULL` · `signal text NOT NULL` · `trust_score numeric NULL` · `received_at timestamptz NOT NULL`.
- **Idx:** `(vehicle_id, received_at DESC)`. **W:** ingestion, ZM, SE submission, geofence. **R:** ReadinessService. **Audit:** no. **Retention:** 90 days.

#### `vehicle_unavailability_reports`
- **Purpose:** the **only** vehicle-side SLA-pause trigger (raw readiness never pauses).
- **Columns:** `id PK` · `ticket_id uuid NOT NULL FK` · `se_id uuid NOT NULL FK→engineer_master` · `reason_code veh_unavail_reason NOT NULL` · `transporter_contacted bool NOT NULL` · `transporter_name text NULL` · `transporter_contact text NULL` · `expected_available_from timestamptz NULL` · `expected_available_to timestamptz NULL` · `notes text NULL` · `se_lat double precision NULL` · `se_lon double precision NULL` · `confirmed_by uuid NULL FK` · `resumed_at timestamptz NULL`.
- **Idx:** `(ticket_id)`, `(expected_available_to) WHERE resumed_at IS NULL` (resurfacing scan). **W:** SE mobile, ScheduleService. **R:** ZM/CSM/Operations Head dashboards, SLA pause logic, VehicleUnavailResurfaceWorker. **Frontend/API:** `/api/tickets/{id}/vehicle-unavailable|vehicle-availability`. **Worker:** VehicleUnavailResurface (hourly). **Audit:** pause/resume audited. **Retention:** with ticket.

---

### D11 — Forms & Idempotency

#### `troubleshooting_submissions`
- **Purpose:** SE form submission; 1-to-many child of a Ticket (one cycle → one ticket → 1+ submissions); carries Phase-1 verification GPS anchor.
- **Columns:** `submission_id uuid PK` · `ticket_id uuid NOT NULL FK` · `failure_cycle_id uuid NOT NULL FK` · `submission_type submission_type NOT NULL` (**CHECK** in `{TROUBLESHOOTING_FORM, COMPONENT_RESUBMIT}` — the only two types this table holds; a resubmit is another submission on the same cycle, never a separate table) · `client_submission_id uuid NOT NULL` · `se_id uuid NOT NULL FK→engineer_master` · `se_gps_lat double precision NULL` · `se_gps_lon double precision NULL` · `presence_source presence_source NOT NULL` · `onsite_capture_gps geometry(Point,4326) NULL` · `component_unavailable bool NOT NULL default false` · `component_unavailable_item bigint NULL FK→component_master` · `diagnosis_notes text NULL` · `submitted_at timestamptz NOT NULL` · `photo_refs text[] NULL`.
- **UQ:** `(se_id, client_submission_id)` (storage-level idempotency for troubleshoot forms). **Idx:** `(ticket_id, submitted_at DESC)`, `(failure_cycle_id)`. **Check:** `component_unavailable ⇒ component_unavailable_item IS NOT NULL`.
- **W:** SE mobile, OfflineSync. **R:** VerificationWorker (Phase-1 anchor), audit, SE-productivity report. **Frontend/API:** `/api/tickets/{id}/troubleshoot`. **Audit:** yes. **Retention:** permanent.
- **Component-wait / resubmit flow (Decision §8):**
  1. **Initial form** → `client_submission_id = A`, `submission_type = TROUBLESHOOTING_FORM`. If submitted with `component_unavailable = true`, the cycle goes `OPEN → WAITING_COMPONENT` (no verification queued) and a `component_requests` row is auto-created **in the same tx, reusing the form's `client_submission_id = A`** — guarded by a second `offline_submission_receipts(se, COMPONENT_REQUEST, A)` row so a form retry re-derives the same request instead of opening a second one.
  2. **Resubmit** (after the part arrives + ZM-confirmed binding) → a **new** `client_submission_id = B`, `submission_type = COMPONENT_RESUBMIT`, `component_unavailable = false`. Cycle `WAITING_COMPONENT → SUBMITTED`.
  3. **VerificationWorker reads the latest `COMPONENT_RESUBMIT`** on the cycle for its Phase-1 GPS anchor (`verification_runs.submission_id` points at it); the initial submission never reached verification.
  - The two ledger rows `(se, TROUBLESHOOTING_FORM, A)` and `(se, COMPONENT_RESUBMIT, B)` are independently idempotent (distinct `submission_type` **and** distinct `client_submission_id`).

#### `submission_components`
- **Purpose:** components used in a submission (drives inventory + Shadow Use forensics).
- **Columns:** `id PK` · `submission_id uuid NOT NULL FK` · `component_id bigint NOT NULL FK` · `quantity_used int NOT NULL`.
- **UQ:** `(submission_id, component_id)`. **Check:** `quantity_used > 0`. **W:** SE mobile. **R:** InventoryService, Shadow Use. **Audit:** via inventory. **Retention:** permanent.

#### `offline_submission_receipts`  *(canonical idempotency ledger; append-only)*
- **Purpose:** server-side idempotency across all submission types.
- **Columns:** `id PK` · `se_id uuid NOT NULL` · `submission_type submission_type NOT NULL` · `client_submission_id uuid NOT NULL` · `result_ref text NULL` (created entity id) · `outcome receipt_outcome NOT NULL` · `responded_at timestamptz NOT NULL default now()`.
- **UQ:** `(se_id, submission_type, client_submission_id)` — **the canonical idempotency key** (CONTEXT §client_submission_id). **Idx:** UQ serves lookups. **W/R:** IdempotencyInterceptor, OfflineSync. **Audit:** no. **Retention:** 12 months (covers offline retention windows).

---

### D12 — Inventory

#### `component_master`
- **Columns:** `component_id PK` · `name text NOT NULL` · `category text NULL` · `serial_tracked bool NOT NULL default false` (GPS/SIM = true). **UQ:** `(name)`. **W:** Operations Head. **R:** everywhere component-referenced. **Retention:** permanent.

#### `component_serial`
- **Purpose:** serial-number tracking for serial-tracked GPS/SIM.
- **Columns:** `id PK` · `component_id bigint NOT NULL FK` · `serial_no text NOT NULL` · `current_location text NULL` (warehouse/SE/installed ref) · `status text NULL`. **UQ:** `(component_id, serial_no)`. **W:** Warehouse Manager, Install. **R:** Recovery verification, warehouse reconcile. **Audit:** movement audited. **Retention:** permanent.

#### `common_kit_definition`
- **Columns:** `id PK` · `component_id bigint NOT NULL FK` · `min_qty int NOT NULL` · `active bool NOT NULL default true`. **UQ:** `(component_id)`. **Check:** `min_qty > 0`. **W:** Operations Head. **R:** Recommender Common-Kit Hard Filter. **Audit:** config. **Retention:** permanent.

#### `se_van_stock`
- **Purpose:** components physically carried per SE; Common-Kit source; decremented on consumption (incl. Shadow Use).
- **Columns:** `id PK` · `se_id uuid NOT NULL FK→engineer_master` · `component_id bigint NOT NULL FK` · `qty int NOT NULL default 0`. **UQ:** `(se_id, component_id)`. **Check:** `qty >= 0`. **W:** InventoryService (via transactions only; read-only to SE). **R:** Recommender Hard Filter, reports. **Audit:** via `inventory_transactions`. **Retention:** live.

#### `warehouse_stock`
- **Columns:** `id PK` · `warehouse_id bigint NOT NULL FK→warehouses` · `component_id bigint NOT NULL FK` · `qty int NOT NULL default 0`. **UQ:** `(warehouse_id, component_id)`. **Check:** `qty >= 0`. **W:** Warehouse Manager, InventoryService. **R:** Recommender (expected-component leg: van OR Zone Warehouse), reports. **Audit:** via transactions. **Retention:** live.

#### `inventory_transactions`  *(append-only ledger)*
- **Purpose:** every inventory movement; references parent submission lineage so retries never double-move; carries Shadow Use.
- **Columns:** `txn_id bigserial PK` · `type inv_txn_type NOT NULL` · `status inv_txn_status NOT NULL` · `component_id bigint NOT NULL FK` · `quantity_delta int NOT NULL` (sign = direction) · `se_id uuid NULL FK→engineer_master` · `ticket_id uuid NULL FK` · `submission_id uuid NULL FK` · `warehouse_id bigint NULL FK→warehouses` · `rejection_reason text NULL` · `created_by uuid NULL FK`.
- **Idx:** partial `(status) WHERE status='SHADOW_USE'` (Shadow Use Queue), `(ticket_id)`, `(se_id)`, `(submission_id)`. **W:** InventoryService, OfflineSync. **R:** Warehouse Manager queues, reports. **Frontend/API:** `/api/inventory/shadow-use-queue`, `/reconcile`. **Audit:** every row is audit-grade; reconcile audited. **Retention:** permanent (financial/forensic).
- **Lifecycle:** accepted form → `PRE_VERIFICATION`; GPS VERIFIED → `DEDUCTED`; FAILED → ZM picks `ROLLED_BACK`|`DEDUCTED_UNVERIFIED`; 409 w/ components → `SHADOW_USE` + van stock decremented regardless.

---

### D13 — Component Requests

#### `component_requests`
- **Purpose:** formal warehouse request on `component_unavailable=true`; pauses SLA (`WAITING_COMPONENT`); sized for Phase-2 courier model.
- **Columns:** `request_id uuid PK` · `ticket_id uuid NOT NULL FK` · `failure_cycle_id uuid NOT NULL FK` · `client_submission_id uuid NOT NULL` · `se_id uuid NOT NULL FK→engineer_master` · `component_id bigint NOT NULL FK` · `quantity_requested int NOT NULL` · `status comp_req_status NOT NULL default 'REQUESTED'` · `delivery_destination delivery_dest NULL` · `approved_by uuid NULL FK` · `reject_reason text NULL` · `shipped_at timestamptz NULL` · `received_at timestamptz NULL` · `tracking_ref text NULL` (v2) · `in_transit_at timestamptz NULL` (v2) · `delivered_at timestamptz NULL` (v2) · `version int NOT NULL default 0`.
- **UQ:** `(se_id, client_submission_id)`. **Idx:** `(ticket_id)`, `(status)`. **`client_submission_id` is the originating troubleshooting form's UUID** (the auto-created request reuses it; distinguished from the form in `offline_submission_receipts` by `submission_type = COMPONENT_REQUEST`) so a form retry never opens a duplicate request. **W:** SE mobile, Warehouse Manager, ComponentRequestService. **R:** ZM dashboard (read-only), SLA pause logic, ComponentSlaWorker. **Frontend/API:** `/api/component-requests/*`. **Worker:** ComponentSla (7-day → ZM Action Required). **Audit:** decision/ship/receipt audited. **Retention:** permanent.

---

### D14 — Verification

#### `verification_runs`
- **Purpose:** three-phase auto-GPS verification; fraud flag; PARTIAL_RECOVERY badge source.
- **Columns:** `run_id bigserial PK` · `ticket_id uuid NOT NULL FK` · `submission_id uuid NULL FK` (NULL for auto-recovery) · `device_id bigint NOT NULL` · `started_at timestamptz NOT NULL` · `se_gps_lat double precision NULL` · `se_gps_lon double precision NULL` · `phase verify_phase NOT NULL default 'PENDING'` · `phase1_passed_at timestamptz NULL` · `phase2_passed_at timestamptz NULL` · `first_ping_distance_meters numeric NULL` · `fraud_flag bool NOT NULL default false` · `pings_received_count int NOT NULL default 0` · `outcome verify_outcome NULL` · `outcome_at timestamptz NULL`.
- **UQ partial:** `(ticket_id) WHERE outcome IS NULL` (`ux_vr_active`) — **one in-flight verification run per ticket** (re-entrant 5-min scan can't fork a second run). **Idx:** `(device_id)`. **W:** VerificationWorker. **R:** Ticket close logic, ZM dashboard, fraud-flags view, reports. **Frontend/API:** `/api/tickets/{id}/verification`, `/api/verification/fraud-flags`. **Worker:** Verification (5-min scan, 24h window). **Audit:** outcome audited. **Retention:** permanent.

---

### D15 — Vouchers

#### `expense_vouchers`
- **Columns:** `voucher_id uuid PK` · `se_id uuid NOT NULL FK→engineer_master` · `client_submission_id uuid NOT NULL` · `status voucher_status NOT NULL default 'DRAFT'` · `plant_id bigint NULL FK` · `ticket_id uuid NULL FK` · `vehicle_id bigint NULL FK` · `total_amount numeric(12,2) NOT NULL default 0` · `reviewed_by uuid NULL FK` · `review_notes text NULL` · `paid_batch_ref text NULL` · `paid_at timestamptz NULL`.
- **UQ:** `(se_id, client_submission_id)`. **Idx:** `(status)`, `(se_id)`. **Check:** SE cannot self-approve; `status='PAID' ⇒` previously APPROVED. **W:** SE mobile, ZM (review), Operations Head (mark PAID). **R:** Finance Excel export, reports. **Frontend/API:** `/api/vouchers/*`. **Audit:** review/pay audited. **Retention:** 7 years (financial).

#### `expense_voucher_items`
- **Columns:** `item_id bigserial PK` · `voucher_id uuid NOT NULL FK` · `category expense_category NOT NULL` · `amount numeric(12,2) NOT NULL` · `merchant_vendor_name text NULL` · `expense_datetime timestamptz NULL` · `photo_ref text NULL`.
- **Idx:** `(voucher_id)`. **Check:** `amount >= 0`; ≥1 photo across items mandatory (service-enforced). **W:** SE mobile. **R:** ZM review (per-category limit check), export. **Audit:** with voucher. **Retention:** 7 years.

---

### D16 — Non-Op & Recovery

#### `non_operational_markings`
- **Purpose:** dual-confirmation exclusion of a Device from Fleet Uptime; on CONFIRMED blocks cycles, closes in-flight tickets, spawns Recovery for RECURRING deals.
- **Columns:** `marking_id uuid PK` · `device_id bigint NOT NULL FK` · `state nonop_state NOT NULL default 'REQUESTED'` · `initiated_by_role role NULL` · `awaiting_role role NULL` · `confirmed_by_role role NULL` · `confirmed_at timestamptz NULL` · `override_confirm bool NOT NULL default false` · `reason_code nonop_reason NOT NULL` · `notes text NULL` · `effective_from timestamptz NULL` · `effective_to timestamptz NULL` · `customer_confirm_token text NULL` (high-entropy, **stored hashed**; used only on the manager-initiated → `AWAITING_CUSTOMER_CONFIRMATION` branch) · `customer_confirm_token_expires_at timestamptz NULL` (default `now() + non_op_confirm_token_ttl_days`, config default 7) · `customer_confirm_token_used_at timestamptz NULL` (set on consumption; confirmation rejected if expired or already used) · `version int NOT NULL default 0`.
- **Idx:** `(device_id, state)`, `(state, effective_to)`. **Check:** `reason_code='OTHER' ⇒ notes IS NOT NULL`; one active marking per device (partial UQ `(device_id) WHERE state IN ('CONFIRMED','ACTIVE')`).
- **W:** ZM, Operations Head, customer (tokenized), system. **R:** `device_eligibility` MV, TicketCreation block, Recovery auto-create, NonOpExpiryWorker. **Worker:** NonOpExpiry (daily; effective_to → EXPIRED). **Audit:** every transition + override-confirm flagged. **Retention:** permanent (governance).

---

### D17 — Notify, Audit, Config

#### `notifications`
- **Columns:** `notification_id bigserial PK` · `notification_event_id text NOT NULL` (the domain event that triggered this delivery) · `recipient_user_id uuid NOT NULL FK` · `event_type text NOT NULL` · `channel notify_channel NOT NULL` · `delivery_status notify_status NOT NULL default 'QUEUED'` · `payload jsonb NULL` · `fallback_step int NULL` · `sent_at timestamptz NULL`.
- **UQ:** `(notification_event_id, channel)` — the `NotificationWorker` idempotency key (LLD §6); blocks duplicate rows under at-least-once redelivery. **Idx:** `(recipient_user_id, sent_at DESC)`, `(delivery_status)`. **W:** NotificationWorker. **R:** dashboards, SE mobile, audit. **Worker:** Notification (fallback chain; WhatsApp first-class on SE Acceptance). **Audit:** delivery logged. **Retention:** 6 months.

#### `audit_logs`  *(immutable; append-only)*
- **Purpose:** immutable record of every state change/approval/override/close; written in the same DB tx as the mutation.
- **Columns:** `audit_id bigserial PK` · `entity_type text NOT NULL` · `entity_id text NOT NULL` · `action text NOT NULL` · `actor_id uuid NULL FK` · `actor_role role NULL` · `acted_as_role role NULL` · `reason text NULL` · `before jsonb NULL` · `after jsonb NULL` · `at timestamptz NOT NULL default now()`.
- **Idx:** `(entity_type, entity_id, at)`, `(actor_id, at)`, `(acted_as_role)` (backup-acting report). **Grants:** INSERT+SELECT only; **no UPDATE/DELETE**. **W:** AuditService (all services, in-tx). **R:** reports, compliance, dashboards. **Audit:** is the audit. **Retention:** permanent (optionally monthly-partitioned for volume).

#### `system_settings`
- **Purpose:** typed registry — the home for every "configurable default".
- **Columns:** `key text PK` · `value jsonb NOT NULL` · `scope settings_scope NOT NULL` · `zone_id bigint NULL FK` · `value_type text NOT NULL` · `updated_by uuid NULL FK` · `updated_at timestamptz NOT NULL default now()`.
- **Check:** `scope='ZONE' ⇒ zone_id IS NOT NULL`. **W:** Operations Head. **R:** all services. **Audit:** config changes audited. **Retention:** permanent. *(Registry contents = LLD §7 table: inactivity_threshold_hours=24, verify_phase1_radius_m=500, acceptance_timeout_min=10, component_wait_escalation_days=7, recovery_no_progress_escalation_days=14, deficit_mode_threshold_pct=2, non_op_default_window_days=90/365, non_op_confirm_token_ttl_days=7, platinum_autoescalation_*, etc.)*

#### `sla_config` / `priority_rule_config`
- **`sla_config`:** `id PK` · `scope text NOT NULL` (`bucket|company_tier`) · `key text NOT NULL` · `submit_within_minutes int` · `verify_within_minutes int` · `escalate_after_minutes int`. **UQ:** `(scope, key)`. **R:** SLA engine.
- **`priority_rule_config`:** `id PK` · `weight_set_ref text NOT NULL` · `component text NOT NULL` · `weight numeric NOT NULL` · `active bool NOT NULL default true` · `effective_from timestamptz`. **Idx:** `(weight_set_ref, active)`. Each batch run records the active `weight_set_ref` in `recommendations.score_breakdown`. **W:** Operations Head. **R:** Recommender. **Audit:** config. **Retention:** permanent (versioned).

---

## 7. Views and Materialized Views

### Materialized views (precomputed; refreshed)

| MV | Columns | Definition | Refresh trigger | Why MV not table/view |
|---|---|---|---|---|
| `plant_eligible_floating_se` | `plant_id, se_id` | Precomputed `ST_Contains(polygon, plant.location)` ∪ district/region/state membership over `engineer_territory_coverage` | Nightly + on coverage edit | Per-request `ST_Contains` over ~700 districts × 40 SEs is too slow on the Recommender hot path (Decision §6) — collapse to an index lookup |
| `device_eligibility` | `device_id, eligible_for_uptime, as_of_date` | `pgi_history` active PGI ≤15d **AND NOT** `non_operational_markings` CONFIRMED/ACTIVE | Daily + on PGI/Non-Op change | The Fleet-Uptime denominator; recomputing per query would scan PGI history each read |
| `mv_zone_dashboard_rollup` | `zone_id, bucket counts, open_tickets, blocked, waiting_component, at_risk` | Aggregate over `device_states` + `tickets` + `component_requests` per zone | On relevant writes / 1-min cadence; Redis-cached by zone | Dashboard aggregates are read-heavy, write-light; MV + cache hits the p95<500ms target |

### Query-time views (always-fresh; never stored)

| View | Purpose | Why a view, not a column |
|---|---|---|
| `v_se_activity_status` | Derives `AVAILABLE/ON_SITE/BUSY/SHIFT_ENDING/OFFLINE` from `se_availability.status` + active `soft_states` + `engineer_master.last_activity_at` + shift | CONTEXT is explicit: **never stored** — would go stale the instant a soft-state or heartbeat changes |
| `v_shared_pool` | `tickets` filtered to `status=OPEN AND assignment_state=UNASSIGNED AND plant_id ∈ caller's coverage` | Shared Pool is a scoped query, not an entity; coverage-scoped at read time by `CoverageScopeGuard` |
| `v_sla_clocks` | Primary elapsed = `(now−opened_at) − accumulated_pause_seconds`; secondary = `now−opened_at` | Both are pure functions of stored anchors; storing them would require constant updates and could hide true aging |
| `v_technical_hints` | Latest `raw_device_snapshots` row per device mapped to advisory hint rules | CONTEXT hard constraint: advisory only, must never be stored as a domain field or affect lifecycle |

`device_states.sla_bucket` is a **stored derived field** (not a view): denormalised for fast queue filtering, but authoritative only at `computed_at` and always recomputable from `inactivity_hours`. Stored because every queue/dashboard query filters on it; a view would re-derive on every read of the hottest table.

---

## 8. Prisma Schema Draft

Prisma is the single schema source of truth. Postgres-only features (PostGIS geometry, partial unique indexes, exclusion constraints, partitioning, triggers, MVs) are layered with `@@index`, `Unsupported(...)`, and hand-written SQL in the same migration folders. Representative, not exhaustive — illustrative of the conventions every model follows.

```prisma
generator client { provider = "prisma-client-js" }
datasource db   { provider = "postgresql"; url = env("DATABASE_URL") }

// ---------- enums (subset) ----------
enum Role { OPERATIONS_HEAD CENTRAL_SERVICE_MANAGER ZONAL_MANAGER WAREHOUSE_MANAGER SERVICE_ENGINEER }
enum WorkType { TROUBLESHOOT INSTALL RECOVERY }
enum FailureCycleState { OPEN WAITING_COMPONENT SUBMITTED VERIFIED FAILED REPEAT ESCALATED }
enum SlaPauseReason { WAITING_COMPONENT VEHICLE_UNAVAILABLE }
enum AssignmentState { UNASSIGNED FORMALLY_ASSIGNED }
enum BatchStatus { AUTO_ASSIGNED OVERRIDDEN COMPLETED PARTIAL }   // no PENDING_REVIEW/APPROVED
enum AvailabilityStatus { AVAILABLE ON_LEAVE OFF_SHIFT WEEKLY_OFF SOFT_UNAVAILABLE OFFLINE }
enum InvTxnType { MOTHER_TO_ZONE ZONE_TO_SE_RESTOCK TICKET_CONSUMPTION SHADOW_USE FAULTY_COMPONENT_RETURNED STOCK_ADJUSTMENT VERIFICATION_ROLLBACK }
enum InvTxnStatus { PRE_VERIFICATION DEDUCTED DEDUCTED_UNVERIFIED ROLLED_BACK SHADOW_USE RECONCILED DISPUTED }
// … (full enum registry from §6 modelled identically)

model FailureCycle {
  cycleId                    String            @id @default(uuid()) @map("cycle_id")
  deviceId                   BigInt            @map("device_id")
  state                      FailureCycleState @default(OPEN)
  openedAt                   DateTime          @map("opened_at")
  closedAt                   DateTime?         @map("closed_at")
  previousFailureCycleId     String?           @map("previous_failure_cycle_id")
  repeatFailure              Boolean           @default(false) @map("repeat_failure")
  slaPaused                  Boolean           @default(false) @map("sla_paused")
  slaPauseReason             SlaPauseReason?   @map("sla_pause_reason")
  slaPausedAt                DateTime?         @map("sla_paused_at")
  slaAccumulatedPauseSeconds BigInt            @default(0) @map("sla_accumulated_pause_seconds")
  version                    Int               @default(0)
  createdAt                  DateTime          @default(now()) @map("created_at")
  updatedAt                  DateTime          @updatedAt @map("updated_at")
  device                     Device            @relation(fields: [deviceId], references: [deviceId])
  previous                   FailureCycle?     @relation("repeat", fields: [previousFailureCycleId], references: [cycleId])
  repeats                    FailureCycle[]    @relation("repeat")
  ticket                     Ticket?
  @@index([state])
  @@index([deviceId, openedAt(sort: Desc)])
  @@index([previousFailureCycleId])
  @@map("failure_cycles")
  // RAW MIGRATION (defence in depth, not expressible in Prisma):
  //   CREATE UNIQUE INDEX ux_fc_one_active ON failure_cycles(device_id)
  //     WHERE state IN ('OPEN','WAITING_COMPONENT','SUBMITTED');
  //   CREATE TRIGGER trg_fc_immutable BEFORE UPDATE ON failure_cycles ...  -- refuse edits to VERIFIED
}

model Ticket {
  ticketId             String          @id @default(uuid()) @map("ticket_id")
  workType             WorkType        @map("work_type")
  status               String                                   // ticket_status union; CHECK gates by work_type
  failureCycleId       String?         @unique @map("failure_cycle_id")
  deviceId             BigInt          @map("device_id")
  vehicleId            BigInt?         @map("vehicle_id")
  plantId              BigInt          @map("plant_id")
  companyId            BigInt          @map("company_id")
  seId                 String?         @map("se_id")
  assignmentState      AssignmentState @default(UNASSIGNED) @map("assignment_state")
  installTriggerSource String?         @map("install_trigger_source")
  createdById          String?         @map("created_by")
  createdByRole        Role?           @map("created_by_role")
  closureType          ClosureType?    @map("closure_type")
  companyTier          CompanyTier     @map("company_tier")
  importBatchRef       String?         @map("import_batch_ref")
  lastStateChangedAt   DateTime        @map("last_state_changed_at")
  repeatFailure        Boolean         @default(false) @map("repeat_failure")
  version              Int             @default(0)
  failureCycle         FailureCycle?   @relation(fields: [failureCycleId], references: [cycleId])
  // se_id FK targets engineer_master(engineer_id), not users (SE-typed FK convention)
  @@index([status, plantId])
  @@index([seId, status])
  @@index([workType, status])
  @@map("tickets")
  // RAW: partial index for Shared Pool — WHERE status='OPEN' AND assignment_state='UNASSIGNED';
  // RAW: ix_tk_escalate (Platinum cross-zone), ix_tk_recovery_stale (14d, on last_state_changed_at), ix_tk_device_active/ix_tk_vehicle_active (QR);
  // RAW: CHECK (work_type='TROUBLESHOOT') = (failure_cycle_id IS NOT NULL) for TS;
  //      CHECK install requires created_by/created_by_role; CHECK status ∈ work_type set
}

model SeAvailability {
  id              BigInt              @id @default(autoincrement())
  engineerId      String              @map("engineer_id")
  fromTs          DateTime            @map("from_ts")
  toTs            DateTime?           @map("to_ts")
  status          AvailabilityStatus
  reasonCode      String?             @map("reason_code")
  setBy           String?             @map("set_by")
  setByRole       Role?               @map("set_by_role")
  activitySourced Boolean             @default(false) @map("activity_sourced")
  notes           String?
  @@index([engineerId, fromTs])
  @@map("se_availability")
  // RAW: EXCLUDE USING gist (engineer_id WITH =, tstzrange(from_ts, COALESCE(to_ts,'infinity')) WITH &&)
}

model EngineerTerritoryCoverage {
  id        BigInt  @id @default(autoincrement())
  seId      String  @map("se_id")
  districtId BigInt? @map("district_id")
  regionId  BigInt? @map("region_id")
  state     String?
  polygon   Unsupported("geometry(MultiPolygon,4326)")?
  @@index([seId])
  @@map("engineer_territory_coverage")
  // RAW: CREATE INDEX gix_etc_polygon ON engineer_territory_coverage USING gist (polygon);
}

model RawDeviceSnapshot {
  id          BigInt   @default(autoincrement())
  runId       BigInt   @map("run_id")
  deviceId    BigInt   @map("device_id")
  gpsDatetime DateTime @map("gps_datetime")
  lat         Float?
  lon         Float?
  // … telemetry fields …
  @@id([id, gpsDatetime])                 // partition key in PK
  @@unique([deviceId, gpsDatetime])
  @@index([deviceId, gpsDatetime(sort: Desc)])
  @@map("raw_device_snapshots")
  // RAW: PARTITION BY RANGE (gps_datetime); monthly child partitions + detach/archive job
}
```

**Project-wide Prisma conventions:** snake_case `@map`; native Postgres enums; additive-only enum evolution (never renumber/reuse); all multi-table mutations + their audit row in one `prisma.$transaction([...])`; `version` checked in `WHERE` of every hot-row update (409 on mismatch); partial-unique/exclusion/partition/MV/trigger via raw SQL in the same migration folder; `Unsupported("geometry…")` + `$queryRaw` for geo.

---

## 9. PostgreSQL Features Outside Prisma

Layered via hand-written SQL in `prisma/migrations/*/migration.sql` alongside the generated DDL.

| Feature | Where | SQL sketch |
|---|---|---|
| **PostGIS** | `plants.location`, `warehouses.location`, `engineer_territory_coverage.polygon`, `troubleshooting_submissions.onsite_capture_gps` | `CREATE EXTENSION postgis; … geometry(Point\|MultiPolygon,4326)`; GIST indexes; `ST_Contains` in `$queryRaw` |
| **Partial UNIQUE indexes** | one active cycle/device, one active mapping/device, one active batch membership/ticket, one in-flight snapshot run, one Zone Warehouse/zone, one active Non-Op/device, one Dedicated coverage/SE, **one in-flight verification run/ticket (I22), one active soft state per (ticket, se, type) (I24)** | `CREATE UNIQUE INDEX … WHERE <predicate>` |
| **Exclusion constraint** | `se_availability` non-overlap per engineer | `EXCLUDE USING gist (engineer_id WITH =, tstzrange(from_ts,COALESCE(to_ts,'infinity')) WITH &&)` |
| **Range partitioning** | `raw_device_snapshots`, `device_uptime_daily` (monthly); optionally `audit_logs` | `PARTITION BY RANGE (gps_datetime\|day\|at)` + monthly child creation + detach/archive |
| **Immutability triggers** | `failure_cycles` (no edits to VERIFIED), `audit_logs`/`ticket_events`/`inventory_transactions` (no UPDATE/DELETE) | `BEFORE UPDATE/DELETE … RAISE EXCEPTION`; REVOKE UPDATE,DELETE grants |
| **CHECK constraints** | enum/work_type coupling, geo bounds, qty≥0, amount≥0, date ordering, OTHER-requires-notes | `ALTER TABLE … ADD CONSTRAINT … CHECK (...)` |
| **Generated column (optional)** | `inactivity_hours` could be `GENERATED ALWAYS` if `latest_gps_datetime` lived on the row — kept service-computed to allow threshold config | — |
| **Materialized views** | §7 (3 MVs) | `CREATE MATERIALIZED VIEW … ; REFRESH MATERIALIZED VIEW CONCURRENTLY …` |
| **Advisory locks** | single in-flight snapshot run | `pg_try_advisory_lock(hashtext('snapshot_run'))` |
| **`jsonb`** | `score_breakdown`, `retry_chain`, `chunk_stats`, `notifications.payload`, `audit_logs.before/after`, `system_settings.value` | GIN index where queried |
| **Append-only grants** | audit/event/ledger tables | `REVOKE UPDATE, DELETE ON … FROM app_role` |

---

## 10. Data Integrity Invariants

Enforced at the strongest available layer (DB constraint > trigger > service guard). Each maps to a CONTEXT rule.

| # | Invariant | Enforcement | Authority |
|---|---|---|---|
| I1 | Exactly **one active Failure Cycle per device** | partial UQ on `failure_cycles(device_id) WHERE state∈(OPEN,WAITING_COMPONENT,SUBMITTED)` | CONTEXT §Failure Cycle |
| I2 | **One Ticket per Failure Cycle** | UQ `tickets(failure_cycle_id)` | §Relationships |
| I3 | **One active Vehicle↔Device mapping per device** | partial UQ `(device_id) WHERE to_ts IS NULL` | §Device Role |
| I4 | A VERIFIED cycle is **immutable** | trigger refusing UPDATE except audit-neutral fields | Decision §9; §Failure Cycle |
| I5 | Verification tracks the **named device_id**, never the vehicle | `verification_runs.device_id` from Ticket/submission; service rule | §Device Role |
| I6 | **No batch-approval state** can exist | enum omits `PENDING_REVIEW/APPROVED`; CHECK | Decision §7 |
| I7 | Idempotency: at most one record per `(se_id, submission_type, client_submission_id)` | UQ on `offline_submission_receipts` + per-table storage UQ | §client_submission_id |
| I8 | Inventory never double-moves on retry | txn references parent submission lineage; idempotent guard | Decision §13 |
| I9 | **Shadow Use decrements van stock regardless** of 409 | service writes `inv_txn(status=SHADOW_USE)` + decrement; both in one tx | Decision §13 |
| I10 | SLA pauses for **exactly two** reasons | `sla_pause_reason` enum has 2 values; raw readiness cannot write it | §SLA |
| I11 | SE cannot self-author `ON_LEAVE`/`WEEKLY_OFF` | service guard + audit `set_by_role`; leave decided_by≠se_id | Decision §10 |
| I12 | One in-flight snapshot run | partial UQ + advisory lock | §Snapshot |
| I13 | Non-Op takes effect only at **CONFIRMED** (dual-party) | state machine + partial UQ one active marking/device | Decision §14 |
| I14 | Recovery auto-created only for **RECURRING** deals + qualifying reason | service rule on `devices.deal_type` + `reason_code` | Decision §14 |
| I15 | Install needs serials before ACTIVATED | CHECK `activated_at IS NULL OR device_serial IS NOT NULL` | §Install Ticket; Decision §4 |
| I16 | Manual Recovery close records full audit (`closure_type`, reason, prev_state, serial) | mandatory columns + audit; CSM only while acting | §Recovery closure authority |
| I17 | Audit row written **in the same tx** as every mutation | `$transaction`; append-only grants | §Audit, §15 |
| I18 | Zone scoping: ZM reads/writes own zone only | `ZoneScopeGuard` + FK `zone_id`; 403 otherwise | §8 RBAC |
| I19 | SE sees only covered Plants | `CoverageScopeGuard` over `se_coverage`/`plant_eligible_floating_se` | §Shared Pool |
| I20 | Fleet Uptime denominator = **Eligible Devices only** | `fleet_uptime_monthly` fed by `device_eligibility` MV | Decision §5 |
| I21 | Optimistic concurrency on hot rows | `version` in UPDATE WHERE on tickets/cycles/component_requests/non_op | §2 conventions |
| I22 | **One in-flight verification run per ticket** | partial UQ `verification_runs(ticket_id) WHERE outcome IS NULL` | Decision §9 |
| I23 | Notification delivery idempotent under at-least-once | UQ `notifications(notification_event_id, channel)` | LLD §6 worker key |
| I24 | No duplicate active soft state (same SE, type, ticket) | partial UQ `soft_states(ticket_id, se_id, type) WHERE resolved_at IS NULL` | §Soft State |
| I25 | SE-typed FKs reference only Service Engineers | FK → `engineer_master(engineer_id)` | §SE coverage; Grill 2026-06-08 |

---

## 11. Indexing Strategy

Indexes are derived from the actual hot queries (Recommender candidate scan, queue/dashboard filters, verification ping lookup, Shared Pool, idempotency lookup).

| Query / access path | Index | Table |
|---|---|---|
| Latest ping & Phase-1/2 ping scan for a device | `(device_id, gps_datetime DESC)` | raw_device_snapshots |
| Chunk re-run idempotency | UQ `(device_id, gps_datetime)` | raw_device_snapshots |
| Inactive-device queue by bucket | `(is_inactive, sla_bucket)`; `(plant_id)`; `(company_id)`; `(eligible_for_uptime)` | device_states |
| Recommender candidate (open unassigned) | partial `(plant_id) WHERE status='OPEN' AND assignment_state='UNASSIGNED'` | tickets |
| SE Day Plan / "assigned to me" | `(se_id, status)` | tickets |
| Canonical sort precompute | `(company_tier, company_priority_rank)` | company_master |
| Active failure episode lookup | partial UQ `(device_id) WHERE state∈(...)`; `(state)` | failure_cycles |
| Active soft states on a ticket | partial `(ticket_id) WHERE resolved_at IS NULL` | soft_states |
| Idempotency resolve | UQ `(se_id, submission_type, client_submission_id)` | offline_submission_receipts |
| Shadow Use Queue | partial `(status) WHERE status='SHADOW_USE'` | inventory_transactions |
| Active verification runs (5-min scan) | partial `(ticket_id) WHERE outcome IS NULL` | verification_runs |
| Floating-SE plant membership | UQ `(plant_id, se_id)` (MV) | plant_eligible_floating_se |
| Territory `ST_Contains` | GIST `(polygon)` | engineer_territory_coverage |
| SE availability window intersection | GIST `(engineer_id, tstzrange(...))` | se_availability |
| Vehicle-unavailability resurfacing | partial `(expected_available_to) WHERE resumed_at IS NULL` | vehicle_unavailability_reports |
| Component-wait escalation scan | `(status)`, `(ticket_id)` | component_requests |
| Audit lookups & backup-acting report | `(entity_type, entity_id, at)`, `(actor_id, at)`, `(acted_as_role)` | audit_logs |
| Monthly KPI rollup | `(day, zone_id)`, `(day, company_id)` | device_uptime_daily |
| Platinum cross-zone auto-escalation scan | partial `(created_at) WHERE OPEN AND UNASSIGNED AND company_tier='PLATINUM'` | tickets |
| Recovery 14-day no-progress scan | partial `(last_state_changed_at) WHERE work_type='RECOVERY' AND status NOT IN ('CLOSED','FAILED_RECOVERY')` | tickets |
| QR resolve (device / vehicle) | partial `(device_id, plant_id)`, `(vehicle_id, plant_id)` WHERE active | tickets |
| VIEWED soft-state timeout sweep | partial `(timeout_at) WHERE resolved_at IS NULL AND type='VIEWED'` | soft_states |
| Stale-work warning sweep | partial `(set_at) WHERE resolved_at IS NULL` | soft_states |
| Notification idempotency | UQ `(notification_event_id, channel)` | notifications |
| Recommender mode lookup | `(scope, scope_id, computed_at DESC)` | recommender_runtime_state |

**Principles:** partial indexes for the "active subset" of every state-machine table (keeps them small and hot); GIST only where geospatial/range; composite leading-column matches the most selective filter; `jsonb` GIN only where the payload is queried (not on write-only audit blobs). Avoid over-indexing the append-only ledgers — they are write-heavy.

---

## 12. Partitioning and Retention Strategy

| Table | Partition | Online window | Archive / purge | Reason |
|---|---|---|---|---|
| `raw_device_snapshots` | RANGE `gps_datetime`, monthly | 3 months hot (configurable to 13) | detach → S3/Parquet cold store; verification needs only recent pings | ~50k devices × multiple pings/day — the single largest table |
| `device_uptime_daily` | RANGE `day`, monthly | 24 months | archive beyond; KPI history kept in `fleet_uptime_monthly` | feeds monthly KPI; daily grain not needed long-term online |
| `audit_logs` | optional RANGE `at`, monthly | indefinite online | never delete (permanent); partition only for vacuum/index manageability | compliance — append-only, never purged |
| `snapshot_run_chunks` | none | purge with parent run | — | engineering telemetry |
| `data_quality_errors` | none | 90 days | purge | silent engineering queue |
| `vehicle_availability_signal` | none | 90 days | purge | evidence rows; only latest matter |
| `notifications` | none | 6 months | purge | delivery records |
| `recommendations`, `work_schedules`, `intraday_insertions` | none | 13 months | archive | operational history for reports |
| `expense_vouchers/items`, `inventory_transactions` | none | 7 years | legal/financial hold | reimbursement + parts accounting |
| `fleet_uptime_monthly`, `audit_logs`, `non_operational_markings`, `failure_cycles`, `tickets`, `cross_zone_escalations` | none | permanent | — | contractual / governance |
| `offline_submission_receipts` | none | 12 months | purge after offline-retention window safely past | idempotency only needs to outlive client retries |

**Mobile-side retention (not server tables, but schema-relevant):** offline queue `DELIVERED` compacted post-sync; `FAILED` never auto-deleted without SE ack; cached completed tickets cleared after `offline_cache_retention_days` (7–15). Server mirrors outcomes in `offline_submission_receipts`.

---

## 13. Migration Plan

Maps to the LLD implementation phases; each phase is a self-contained, forward-only migration set (additive Prisma + hand-written SQL for partitions/constraints/MVs/triggers). Seed data and back-population noted.

| Phase | Migration content | Constraints/SQL added | Seed / backfill |
|---|---|---|---|
| **M0 — Foundation** | `CREATE EXTENSION postgis`; all enums (incl. `recommender_mode`/`unable_reason`/`uptime_scope`/`expected_src`/`dq_severity`/`escalation_trigger`); D1 Identity & Org, D17 settings/audit/notifications; `users/zones/regions/districts/plants/transporters/company_master/warehouses` | append-only grants on `audit_logs`; **`notifications` idempotency UQ I23**; zone-scope groundwork | seed roles, zones, districts (~700), settings registry with launch defaults (incl. `non_op_confirm_token_ttl_days`) |
| **M1 — Assets & Ingestion** | D2 assets; D4 ingestion incl. `raw_device_snapshots` **partitioned**; D5 `device_states`; **`engineer_master` (moved up from D3 so SE-typed FKs resolve)** | range partition + monthly child job; `(device_id,gps_datetime)` UQ; advisory-lock run guard | first Snapshot run; vehicle/device/mapping import; **SE `engineer_master` rows at onboarding** |
| **M2 — Ticketing core** | D6 `failure_cycles/tickets/*_details/expected_components/ticket_events`; partial UQ I1–I3; immutability trigger I4 | one-active-cycle UQ; work_type CHECKs; VERIFIED-immutability trigger; **`tickets.company_tier`/`import_batch_ref`/`last_state_changed_at` cols; `se_id`→`engineer_master` FK; `ix_tk_escalate`/`ix_tk_recovery_stale`/QR partial idx** | — |
| **M3 — Coverage & Recommender** | D3 coverage (`se_coverage`/`engineer_territory_coverage`; `engineer_master` already in M1); D8 scheduling incl. **`recommender_runtime_state`**; MVs `plant_eligible_floating_se`, `device_eligibility` | GIST polygon idx; MV refresh jobs; Shared-Pool partial idx; **`recommender_runtime_state` UQ** | seed `se_coverage`/territory; `priority_rule_config` weight set v1 |
| **M4 — Field loop** | D7 soft_states; D11 forms & idempotency; D14 verification | idempotency UQ I7; **`troubleshooting_submissions.submission_type` CHECK; soft_states UQ I24 + aging idx; verification one-active-run UQ I22**; presence CHECKs | — |
| **M5 — Inventory & components** | D12 inventory (incl. `warehouses` FK now satisfied); D13 component_requests | Shadow-Use partial idx; qty CHECKs; component-request version | seed `component_master`, `common_kit_definition`, opening stock |
| **M6 — Availability, readiness, SLA, intra-day** | D9 availability (exclusion constraint I11); D10 readiness; `intraday_insertions`, `cross_zone_escalations` | `se_availability` EXCLUDE; resurfacing partial idx | — |
| **M7 — Non-Op / Recovery / Vouchers / KPI** | D16 non_op (**incl. `customer_confirm_token_expires_at`/`_used_at`**); `recovery_details`; D15 vouchers; D5 `device_uptime_daily` (partitioned) + `fleet_uptime_monthly`; `mv_zone_dashboard_rollup` | one-active-marking UQ I13; uptime partition; KPI uniqueness | first monthly KPI backfill from `device_uptime_daily` |

**Reversibility:** framework swap (Express ⇄ anything) is reversible and touches no schema. Enum changes are additive-only (never renumber). Partitioning and immutability triggers are introduced before the tables carry production volume so no rewrite is needed. MVs can be dropped/rebuilt without data loss (derived).

---

## 14. Schema Risks and Tradeoffs

| Risk / tradeoff | Decision | Mitigation |
|---|---|---|
| **Fleet Uptime time-weighting source** | Added `device_uptime_daily`; `device_states` is current-only | If daily roll proves lossy, fall back to integrating over `raw_device_snapshots` directly within the 3-month window; KPI rows in `fleet_uptime_monthly` are recompute-replace so a better algorithm can re-derive history while raw partitions remain |
| **`ticket_status` is a wide union** keyed by `work_type` | Single `tickets` table (Decision §4) over three tables | CHECK + service guard couple status to work_type; sub-type fields isolated in child tables; reports always filter by work_type |
| **`raw_device_snapshots` volume** | Monthly partitions, 3-month hot window | Detach+archive job; verification only ever reads recent pings; incremental-sync evaluated at 100k devices |
| **Denormalised `sla_bucket`/`repeat_failure` on hot tables** | Stored for query speed | Always recomputable; `computed_at` makes staleness visible; mirror in Redis with TTL |
| **MV refresh lag** (`device_eligibility`, `plant_eligible_floating_se`) | Nightly + on-change refresh | `REFRESH … CONCURRENTLY`; on-edit triggers; eligibility lag bounded to a day, acceptable for a monthly KPI |
| **Shared Pool as a view, not a table** | No materialisation | Coverage-scoped partial index on `tickets` keeps it fast; avoids a sync-divergence bug class |
| **Soft states are non-locking** | Multiple SEs may hold concurrently | Shadow Use + 409 handle the race at submission, not via locks (Decision §13) — matches the deliberate shared-pool flexibility |
| **Two SLA clocks** | Anchors + accumulated-pause stored; elapsed derived | `v_sla_clocks` view; secondary clock RBAC-gated to managers only |
| **Append-only ledgers grow unbounded** | audit/inventory/events permanent | Optional monthly partitioning for vacuum; never on the hot write path of business tables |
| **`device_id` is a business bigint PK** (not surrogate) | Matches source-of-truth identity, simplifies per-device-id verification | Accept coupling to AutoPlant id space; documented in §2 conventions |
| **Phase-2 Component Request columns reserved now** | `tracking_ref/in_transit_at/delivered_at` nullable today | Additive enum expansion path documented; no migration churn at Phase-2 |

---

## 15. Open Schema Questions

Only items where the answer would change **table shape, relation, enum, constraint, index, migration, or permission**. Everything else was decided with a documented default (§2). The five "business-blocked" config items from LLD §19 are **not** here — they live in `system_settings` and do not alter schema.

| # | Question | Why it could change schema | Interim decision (so build is unblocked) |
|---|---|---|---|
| Q1 | Does Fleet Uptime need a **per-device monthly** breakdown row, or only fleet/zone/company/plant scopes? | Would add a 5th `scope` value / change `fleet_uptime_monthly` grain & PK | Modelled 4 scopes (`FLEET/ZONE/COMPANY/PLANT`); per-device derivable from `device_uptime_daily` on demand — **no per-device monthly table** unless reporting demands it |
| Q2 | Should `device_uptime_daily` store raw seconds or a normalised fraction, and is the daily grain sufficient for "time-weighted"? | Column types / precision of the contractual KPI | Stored `online_seconds/measured_seconds` (lossless, integrable); daily grain assumed sufficient — confirm SLA contract wording |
| Q3 | **SLA resume trigger** — ZM-confirmed binding (Decision §8) vs resume-on-receipt | Adds/removes the `sla_resume_on_receipt` config switch; affects which event writes `resumed_at` | Following Decision §8 (ZM-confirmed binding) as authoritative; config switch reserved (LLD §19 Q3) |
| Q4 | ~~Should **Soft Inactive Count** be persisted as a time-series?~~ | — | **Resolved (Grill 2026-06-08):** added `recommender_runtime_state`; its per-run rows are both the mode sink and the PRD §29 trend series. |
| Q5 | Do **Recovery Tickets** need their own `unable_to_collect` event sub-states beyond `recovery_details.unable_reason_code`? | Could promote to a child events table | Held in `recovery_details` + `ticket_events`; sufficient at current scale |
| Q6 | Is **per-zone SLA config** (vs global) required day one? | `sla_config` would need a `zone_id` scope column + composite UQ | Modelled global (`scope=bucket|company_tier`); zone scope additive if Operations needs per-zone SLA |
| Q7 | Should `component_serial.current_location` be a typed FK (warehouse/SE/device) rather than free text? | Would replace a text column with a polymorphic relation or 3 nullable FKs | Kept as text+status for v1; promote to typed FKs if serial chain-of-custody reporting is required |
| Q8 | Does the **Install CSV bulk upload** need a provenance table (`install_upload_batches`) beyond the `tickets.import_batch_ref` stamp? | Would add a table recording uploader/filename/rejected-rows | **Interim (Grill 2026-06-08):** transactional all-or-nothing validation + per-ticket `created_by` audit + `import_batch_ref` (groups one upload's rows) satisfy Decision §11; add the full table only if re-downloadable error reports / upload history become a requirement |

---

*End of Database Schema Blueprint. Implementation-ready for `schema.prisma` + PostgreSQL migrations. Canonical authority: CONTEXT.md → PRD-fsm-admin-dashboard.md → fsm-business-technical-workflow.md → backend LLD. Root `prd.md` and superseded ADRs are historical only.*
