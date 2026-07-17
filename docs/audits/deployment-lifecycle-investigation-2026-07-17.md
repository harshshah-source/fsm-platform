# Deployment-Status Lifecycle Gap — Investigation & Design Proposal (2026-07-17)

**Method:** READ-ONLY. Code evidence as file:line; production AutoPlant evidence via bounded
SELECTs (LIMIT ≤ 90 per non-aggregate query, GROUP BY aggregates, IN() batches ≤ 90 ids — the
same DBA cap the sync itself honours). FSM evidence from the local Postgres mirror. No writes
anywhere. Trigger: `ap_masters.mst_vehicle` shows RR_D-series devices at plant 30783
(transporters 16112/17056/…) `deployment_status = UNDEPLOYED` — including **RR_D20710475,
which FSM dispatched in batch 59**.

**Verdict up front: the departure blind spot is real, structural, and large.** FSM never
observes a `DEPLOYED → UNDEPLOYED` transition. Every one of FSM's 20,856 vehicles reads
`DEPLOYED` while AutoPlant currently has only 15,652 DEPLOYED fleet-wide; ~33 % of a random
FSM-device sample is UNDEPLOYED at source *today*, and **49.7 % of the devices on live
dispatch batches are no longer deployed (or no longer exist) in AutoPlant**. Companion issue:
[#128](../../.scratch/fsm-platform-v1/issues/128-device-deployment-lifecycle.md).

---

## 1. Findings (Phase 1)

### 1.1 What master sync actually filters on

- Master sync reads `ap_masters.mst_vehicle` with the deployment filter **pushed into SQL**:
  `WHERE v.deployment_status IN ('DEPLOYED')` —
  `autoplant-master-source.ts:203` (`readVehicleMasters`, `inClause('v.deployment_status', …)`),
  default `deploymentStatuses = ['DEPLOYED']` at `autoplant-master-source.ts:67`.
  Production wiring passes the same: `ingestion.module.ts:99` and the standalone runner
  `autoplant-sync.ts:53`.
- The reader SQL (assembled in `pageAll`, `autoplant-master-source.ts:107-109`):

  ```sql
  SELECT v.vehicle_no AS vehicle_no, v.device_id AS device_id, v.plant_id AS plant_id,
         p.company_id AS company_id, v.transporter_id AS transporter_id,
         v.deployment_status AS deployment_status, NULL AS device_type
    FROM `ap_masters`.`mst_vehicle` v
    LEFT JOIN (SELECT plant_id, MIN(company_id) AS company_id
                 FROM `ap_masters`.`mst_plant` GROUP BY plant_id) p ON p.plant_id = v.plant_id
   WHERE (v.deployment_status IN ('DEPLOYED')) [AND v.vehicle_no > ?]
   ORDER BY v.vehicle_no LIMIT 90
  ```

- The **telemetry** reader (`autoplant-source-reader.ts:83-86`) scans
  `ap_widgets.tb_vehiclemaster` with **no deployment filter at all** — every pinging device is
  journalled regardless of status.
- `vehicles.status` is a **verbatim mirror** of `mst_vehicle.deployment_status`
  (`master-mapping.ts:255`, `status: cleanStr(row.deployment_status)`), present in both the
  `create` and `update` sets — so it *would* refresh on every sync… for rows the sync reads.

**Do the two source tables agree?** For the sampled plant-30783 RR_D devices — yes, all 15
are `UNDEPLOYED` in both `mst_vehicle.deployment_status` and
`tb_vehiclemaster.vehicle_deployment_status`. Fleet-wide (aggregate join on `device_id`):

| mst_vehicle | tb_vehiclemaster | n |
|---|---|---|
| UNDEPLOYED | UNDEPLOYED | 32,459 |
| DEPLOYED | ACTIVE | 8,025 |
| DEPLOYED | DEPLOYED | 7,629 |
| UNDEPLOYED | ACTIVE | 429 |
| MAINTENANCE | MAINTENANCE | 157 |
| ACTIVE | ACTIVE | 39 |
| DEPLOYED/UNDEPLOYED | DEPLOYED/UNDEPLOYED | 4 |
| UNDEPLOYED | DEPLOYED | 2 |
| ACTIVE | DEPLOYED | 1 |

They agree on UNDEPLOYED ~98.7 % of the time; `tb_vehiclemaster` additionally labels about
half of mst's DEPLOYED as `ACTIVE` (likely "on trip"). `mst_vehicle.deployment_status` — the
column the sync already uses — is the conservative master signal. Note the dirty vocabulary:
`DEPLOYED/UNDEPLOYED` (4 rows) and `MAINTENANCE` (157) exist; any lifecycle design must treat
*unknown* values explicitly (the 2026-07-05 engineering review line 584 flagged exactly this).

### 1.2 The departure blind spot — proven in code

`MasterSyncService.sync()` (`master-sync.service.ts:109-297`) iterates **only the rows the
filtered read returned** (`for (const v of vehicleMasters)`, `:240`) and upserts them
(`:254-260`). There is **no** code path that touches an FSM `vehicles`/`devices` row *absent*
from the read: no reconciliation pass, no departure diff, no status sweep. Grep confirms the
only writer of `vehicles.status` is the upsert built from `mapVehicle` — which is only ever
constructed for rows in the DEPLOYED read. Consequence: once a vehicle leaves
`deployment_status='DEPLOYED'`, its FSM mirror row is *never written again* — it is frozen at
the last in-scope value, `'DEPLOYED'`, forever. The FSM distribution proves it:
`SELECT status, COUNT(*) FROM vehicles GROUP BY 1` → **DEPLOYED: 20,856 — the only value in
the table.**

Sampled RR_ devices (plant 30783): 15/15 `UNDEPLOYED` in both source tables; **13 of 15 exist
in FSM as `DEPLOYED`** (plant DEPOT_CBT / source_plant_id 30783) — including RR_D20710475.
The other two (RR_D20710201, RR_D20710210; last GPS 2026-06-19) departed before FSM's first
sync ever saw them, so they were simply never mirrored — the same filter, seen from the other
side.

### 1.3 Drift quantified (bounded sampling)

- AutoPlant now: DEPLOYED 15,652 · UNDEPLOYED 32,892 · MAINTENANCE 157 · ACTIVE 40 ·
  `DEPLOYED/UNDEPLOYED` 4. In ACTIVE plants only: DEPLOYED 15,652 · UNDEPLOYED 32,638.
  (2026-07-04 handoff recorded DEPLOYED 17,846 — a net −2,194 in ~2 weeks; the fleet churns
  ~150+/day, so drift re-accumulates fast.)
- FSM: 20,856 vehicles, all `DEPLOYED`; 20,925 devices. **Floor:** FSM carries ≥ 5,204 more
  "DEPLOYED" rows than AutoPlant has deployed vehicles.
- Random sample, 90 FSM devices → AutoPlant now: **DEPLOYED 57 (63 %) · UNDEPLOYED 30 (33 %) ·
  absent-by-device_id 3 (3 %)**. Point estimate: **~6,900 of 20,856 FSM vehicles (~37 %) are
  stale-DEPLOYED or gone** (95 % CI roughly 27–47 %; consistent with the ≥ 5,204 floor plus
  fitment churn).
- Plant 30783 alone: 700 UNDEPLOYED vs 307 DEPLOYED at source.

### 1.4 Downstream blast radius in FSM

All measured on the live mirror, `eligibility_mode = 'all-deployed'`,
`inactivity_threshold_hours = 24`:

| Surface | Evidence | Impact |
|---|---|---|
| **Eligibility** | `device-state.service.ts:60-62`: all-deployed mode = `COALESCE(v.status IN ('ACTIVE','DEPLOYED'), false)`; every `device_states` row is `eligible_for_uptime = true` (20,925/20,925) | The eligibility gate is a **no-op**: the mirror contains only 'DEPLOYED', so departed devices stay eligible and the fleet-uptime denominator is inflated ~37 % |
| **Ticket creation** | `ticket-creation.service.ts:33-39` gates on `isInactive && eligibleForUptime` | Departed devices stop pinging → age into inactivity → auto-ticketed. **18,188 OPEN tickets**; sample of 255 open-ticket devices → 43 UNDEPLOYED (16.9 %) + 9 absent (3.5 %) ⇒ **~3,700 open tickets (~20 %) target departed/vanished devices** |
| **Inactive counts** | 6,000 `is_inactive` devices; sample of 90 → **34 UNDEPLOYED + 18 absent = 58 %** | The inactive population — the pipeline's fuel gauge and the ZM/OH dashboard "inactive" tally — is **majority departed devices**, not broken fleet |
| **SLA buckets** | Sample of 90 bucketed devices → 13 UNDEPLOYED + 4 absent (19 %) | SLA aging (WARNING 12,960 · LONG_PENDING 4,902 · …) counts warehouse devices as SLA breaches |
| **Dispatch / Day Plans** | 1,738 devices on live (non-COMPLETED) batches, checked **exhaustively**: **875 DEPLOYED · 739 UNDEPLOYED (42.5 %) · 6 MAINTENANCE · 118 absent (6.8 %)** | **≈ half the live dispatch workload is wasted truck rolls.** Batch 59 verified: RR_D20710475 on an OPEN ticket, batch AUTO_ASSIGNED, `removed_at` null — dispatched to a device that left the fleet |
| **Ingest WARNs** | `snapshot-ingestion.service.ts:104-110` — "device_id(s) not yet in devices" | Reconciled: **8,336 UNDEPLOYED devices pinged in the last 48 h** (aggregate on `tb_vehiclemaster`); the telemetry scan journals them but the DEPLOYED-only master sync never mirrors them ⇒ perpetual WARNs. Not a bug in the WARN — it is the blind spot's other face |
| **~1,200 duplicate device_ids note** | `HANDOFF-autoplant-ingestion-2026-07-07.md:60` | **Stale.** `tb_vehiclemaster` today: **0 duplicate device_ids** (aggregate HAVING COUNT>1). The keyset-tiebreak worry can be retired |

The "absent by device_id" class (3–7 % everywhere, 118 on live batches) matters for design:
`mst_vehicle` is keyed by `vehicle_no`; when a device is unfitted/refitted its `device_id`
can disappear from the table entirely — so even a status-wide sync read will not report it.
Departure detection must handle *absence*, not just observed UNDEPLOYED.

---

## 2. Design proposal (Phase 2) — FSM-owned deployment lifecycle

Mirrors the #119 plant-deactivation posture: **observe the source, never delete, reversible,
audited, sync-durable** (`plant-deactivation.service.ts` — side table + partial unique, open
work cancelled with a reason code, reactivation stamps history, downstream reads one
exclusion set).

### 2a. How FSM learns about departures — options

| | Option A — widen the sync read (mirror all statuses, manage only DEPLOYED) | Option B — separate periodic reconciliation pass | Option C — absence diff only |
|---|---|---|---|
| Mechanism | Drop the `deploymentStatuses` SQL filter (keep the in-memory scope for plants). Every sync mirrors `vehicles.status` verbatim **for vehicles FSM already knows**; lifecycle transitions derive from the *observed* status flip | Keep DEPLOYED-only sync; a scheduled job re-reads `mst_vehicle (device_id, deployment_status)` for FSM-known devices in ≤ 90-id IN() batches and applies transitions | After each SUCCESS sync, any FSM-operational device **not seen** in the DEPLOYED read ⇒ mark departed |
| AutoPlant query budget (≤ 90-row cap) | Vehicle read grows ⌈15.7k/90⌉ ≈ 175 → ⌈48.5k/90⌉ ≈ **540 queries, once daily**. For scale: the 30-min telemetry scan already pages the whole ~61k-row `tb_vehiclemaster` (~680 queries/run, ~32k/day) — this adds ~1 % | ~⌈20.9k/85⌉ ≈ **246 queries/day** extra, plus a second scheduler/service to operate | **0 extra queries** |
| Departure signal quality | **Observed** source status (never inferred); UNDEPLOYED vs MAINTENANCE vs junk distinguishable; re-deploy detected the same way | Observed, but a second code path that can disagree with sync timing | **Inferred** — conflates UNDEPLOYED with plant-went-INACTIVE, zone-unresolved, partial read, source hiccup. A bad read mass-marks the fleet departed unless heavily guard-railed |
| Extra benefit | None taken — see the **insert-scope pin** below (an earlier draft of this table proposed mirroring the whole ~48.5k catalog to also silence the ingest WARNs; that was rejected 2026-07-17 and the WARNs stay) | None beyond the fix | None beyond the fix |
| R10 §3 relation | This *is* the "no forced periodic full-scan" gap closed as part of sync itself | This is the literal R10 §3 reconciliation job | Doesn't close it |

**DECIDED 2026-07-17 (operator): Option A approved**, plus the *absence diff* from Option C as
a safety net for the vanished-device_id class (§1.4): after a **SUCCESS** full read, an
FSM-operational device whose `device_id` was absent from the entire read is marked departed
with reason `MISSING_FROM_SOURCE` — bounded by a per-run guardrail (abort the departure pass,
alert, if it would mark > N % of the fleet in one run; a partial/failed read never marks
anything). Option A observes rather than infers, and its cost is one extra daily ~365-query
read — noise next to the existing telemetry cadence.

> **INSERT-SCOPE PIN (operator decision, 2026-07-17 — load-bearing).** Widening the READ must
> **not** widen the CREATE. FSM continues to create vehicles/devices **only** for rows whose
> observed status is DEPLOYED/ACTIVE; the wider read exists solely to observe status
> transitions on entities FSM **already knows** (mark departures, auto-restore on re-deploy).
> A never-deployed device stays out of FSM entirely. Rationale: mirroring the full ~48.5k
> catalog would balloon `vehicles` from ~21k to ~48k and silently change the meaning of every
> dashboard total, fleet denominator and "known fleet" count in the product — a far larger
> semantic change than the WARN-noise benefit it would buy. **This supersedes the earlier draft
> of this section**, which proposed the whole-fleet registry; that reasoning optimised log
> hygiene over the stability of the fleet denominator and was rejected.
>
> Consequences accepted: (1) the "device_id not yet in devices" ingest WARNs **persist** for
> never-known pinging devices (~8.3k/48h) — log hygiene, tracked separately, not a lifecycle
> concern; (2) the mechanism is unaffected — with the read widened, *absence from the read*
> still means "genuinely gone from `mst_vehicle`" regardless of insert scope, so the safety net
> keeps its meaning; (3) re-deployment of a never-known device still works — it reappears as
> DEPLOYED and the status-based create rule mirrors it normally.

### 2b. What "departed" means downstream (per table)

**Model.** Keep `vehicles.status` a pure verbatim AutoPlant mirror (now including UNDEPLOYED
etc.) **for the ~21k vehicles FSM knows** — never-deployed vehicles are not created (insert-scope
pin, 2a). Add an FSM-owned side table — posture-identical to `plant_deactivations`:

```
device_departures
  id, device_id FK, observed_status,            -- UNDEPLOYED | MAINTENANCE | MISSING_FROM_SOURCE | <verbatim unknown>
  reason,                                        -- SOURCE_STATUS | ABSENT_FROM_READ
  departed_at, detected_by_run_id,               -- master_sync_runs FK — every transition traceable to a run
  restored_at, restored_by_run_id,               -- NULL while active
  cancelled_tickets_count                        -- if the cancel decision (below) is taken
  partial unique (device_id) WHERE restored_at IS NULL   -- one active departure per device
```

Master sync **never deletes** from it; only the lifecycle pass inserts/stamps. A device is
*operationally departed* iff it has an active row. `device_states` (recomputed wholesale
anyway) gets a denormalised `is_departed boolean` so every downstream read stays one predicate,
no join fan-out.

Per surface:

- **`vehicles` / `devices`:** untouched rows-wise; `vehicles.status` finally truthful. No FSM
  lifecycle column on the mirror tables themselves — lifecycle lives in the side table
  (anti-drift: master-sync's update set stays source-only, R4 preserved).
- **`device_states`:** departed devices are **excluded from operational derivations** —
  `is_inactive = false`, `sla_bucket = NULL`, `eligible_for_uptime = false`, `is_departed =
  true`. Raw telemetry columns (`latest_gps_datetime`) keep updating if the device pings — a
  warehouse device isn't broken, and it isn't invisible either.
- **Eligibility:** ineligible in **both** modes (like the Non-Op exclusion,
  `device-state.service.ts:57-66`): `pgi` mode AND-s `NOT is_departed`; `all-deployed` mode
  self-corrects via the truthful mirror *and* gets the explicit exclusion (defence in depth,
  and it covers MISSING_FROM_SOURCE which the mirror alone cannot).
- **Open tickets — YOUR DECISION (flagged):**
  - *(i) Cancel with reason* — on departure detection, cancel the device's open tickets
    (status → CLOSED, `reasonCode: DEVICE_UNDEPLOYED`, parent failure cycle terminated), exactly
    the #119 semantics (`plant-deactivation.service.ts:76`, `cancelOpenTickets`). Clean queue,
    honest SLA clocks, audited counts; if the device returns *and is genuinely inactive*, the
    next pipeline run creates a fresh ticket (nothing resurrected).
  - *(ii) Suppress* — keep tickets OPEN but excluded from dispatch/recommender/SLA/dashboards
    while departed; auto-resume on re-deploy. Preserves ticket history continuity, but leaves
    ~3,700 zombie rows distorting any query that forgets the predicate, and SLA aging across a
    warehouse stay is meaningless anyway.
  - **DECIDED 2026-07-17 (operator): (i) cancel with reason `DEVICE_UNDEPLOYED`** — exact #119
    semantics, audited, reversible-by-recreation on return.
- **Dispatch / recommender:** hard-filter drop `DEVICE_DEPARTED` in candidate selection
  (defence in depth even with tickets cancelled — covers the detection lag window), recorded in
  the decision trace's drop buckets like every other hard filter. Day-Plan/batch building never
  sees them.
- **Dashboards (ZM/OH):** a separate **"Departed/undeployed" tally** per zone — sibling of the
  #119 deactivated-plant tally — *subtracted* from fleet/inactive/SLA denominators, never
  silently dropped (totals must still reconcile: fleet = operational + departed).
- **Transparency pages:** integration-health shows per-run departures/restores; the device
  detail page shows lifecycle status + departure history.

### 2c. Re-deployment

Source shows `DEPLOYED` again → the same sync observes it → mirror updates, active
`device_departures` row is stamped `restored_at`/`restored_by_run_id`, audit row written,
`device_states` recompute re-includes the device. Everything downstream resumes with **no
manual step and nothing destroyed**. If it is still genuinely inactive, the normal pipeline
re-tickets it (same as #119 reactivation).

### 2d. ZM/OH visibility & audit trail

- Every transition writes an audit row (`audit_logs` via `AuditService.withAudit`, the #119
  pattern): `DEVICE_DEPARTED` / `DEVICE_REDEPLOYED`, entity DEVICE, metadata = observed
  status, reason, sync run id, cancelled-ticket count. Actor = system (sync-detected) —
  distinguishable from any future manual marking.
- ZM dashboard: per-zone departed count next to the inactive/deactivated tallies. OH: fleet-wide
  card + the integration-health per-run delta ("this sync: +212 departed, 37 restored").
- `master_sync_runs.entity_stats` grows `departures`/`restores` counters so the existing runs
  surface shows the churn without a new page.

### 2e. Migration / backfill of the CURRENT stale rows

No destructive steps; ordering matters:

1. **Schema** — additive only: `device_departures` + partial unique; `device_states.is_departed`.
2. **Dry run (report-only)** — run the widened read + lifecycle pass with writes off; emit the
   would-be departure list (~6,9k expected) grouped by zone/plant for OH eyeball + your sign-off.
   This is also the guardrail calibration run.
3. **First live sync** — mirror refresh flips `vehicles.status` truthful (normal upsert path,
   anti-drift intact); lifecycle pass inserts `device_departures` rows (reason SOURCE_STATUS,
   run id stamped) — **audited, reversible** (restore path exists from day one).
4. **Ticket decision applied** — per your 2b choice; if cancel: one audited batch per device,
   `DEVICE_UNDEPLOYED` reason, counts recorded on the departure row (#119 exactly). Live
   batches self-clean: their tickets close, `batch_assignment_tickets` keeps history.
5. **`device_states` recompute** — inactive/SLA/eligibility counts collapse to the true fleet;
   dashboards start showing the departed tally.
6. **Rollback story** — restoring = stamping `restored_at` (data), not schema; cancelled
   tickets are terminal-with-reason like every #119 cancellation, and re-ticketing is automatic
   for genuinely inactive devices. Nothing needs un-deleting because nothing is deleted.

Scheduler flags and `eligibility_mode` untouched throughout.

---

## 3. Decisions taken (operator, 2026-07-17)

1. **Sync strategy (2a): Option A approved** — widen the vehicle read to all statuses + the
   absence-diff safety net with its guardrails (mark nothing on partial/failed reads; abort +
   alert on a > N % swing). **Insert scope pinned:** widening the read does **not** widen the
   create — FSM creates only DEPLOYED/ACTIVE devices; never-deployed devices stay out of FSM.
   See the insert-scope pin box in §2a (it supersedes this document's first draft).
2. **Open-ticket handling (2b): cancel with reason `DEVICE_UNDEPLOYED`** — exact #119 semantics.
3. **Backfill (2e): approved as designed** — dry-run first, counts reviewed by the operator
   (expected ~6.9k departed, ~3,700 tickets cancelled) **before** the live pass. Dashboards are
   expected to shrink substantially: that is honesty, not regression. Capture before/after in
   `docs/SYSTEM-STATE-2026-07.md`, as the zone application did.
4. **Unknown vocabulary:** treat any status ∉ {DEPLOYED, ACTIVE} as departed-equivalent, but log
   + surface unknown values (`DEPLOYED/UNDEPLOYED` ×4 exists today).

Scheduler flags and `eligibility_mode` remain untouched.

Issue: [#128](../../.scratch/fsm-platform-v1/issues/128-device-deployment-lifecycle.md) ·
Evidence scripts (read-only, scratchpad): `p1-queries.js`, `p1-blast.js`, `p1-agree.js`,
`p1-inactive.js` (session 2026-07-17).
