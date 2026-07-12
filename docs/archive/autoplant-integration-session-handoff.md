# AutoPlant Integration — Session Handoff

> ⚠️ **SUPERSEDED (marked 2026-07-10 by the SYSTEM-STATE audit).** Superseded by
> `docs/HANDOFF-autoplant-ingestion-2026-07-07.md` and `.scratch/fsm-platform-v1/issues/97-PROGRESS.md`.
> Retained for history only.

> **Purpose:** let a fresh session continue exactly where this one stopped.
> **Date:** 2026-07-04 · **Branch:** `feat/autoplant-integration` · **Working tree:** uncommitted changes (not committed yet).
> **Companion docs:** `backend-autoplant-deep-analysis.md` (the full backend/AutoPlant analysis),
> `autoplant-production-integration.md` (8-phase blueprint), `autoplant-integration-progress-tracker.md`,
> `docs/autoplant/` (production DESCRIBEs + sample data).

---

## 1. Goal & where we are

**Goal:** get live AutoPlant production data flowing into the FSM backend so the admin dashboards show
real inactivity data. AutoPlant is a read-only production MySQL reachable over OpenVPN.

**Status:** Connection works, master data is syncing into local Postgres, and the R6 zone-mapping layer
(the thing that gated everything) is built, tested, and running. **Remaining for first-light dashboards:**
map the zones, then run the telemetry drain + device-state recompute (`pipeline` mode).

**One-line state:** masters sync ✅ (749 real plants, 39 companies, 7.6k transporters, ~17.8k DEPLOYED
vehicles, ~17.9k devices — all in local Postgres); telemetry drain + recompute ⏳ (not run yet); zone
mappings ⏳ (all plants currently in the UNZONED holding zone, queue populated and waiting to be mapped).

---

## 2. Connection facts (verified)

- **VPN:** OpenVPN. Host **`10.0.0.25`**, port `3306`. The client's VPN-assigned IP was `10.0.0.222`.
- **Credentials:** in `apps/backend/.env` (gitignored). User = `bi_enroute_readonly` (read-only).
  Schemas: **`ap_widgets`** (live telemetry — `tb_vehiclemaster`) + **`ap_masters`** (masters — `mst_*`).
  Env vars: `AUTOPLANT_MYSQL_HOST/PORT/USER/PASSWORD/DB_WIDGETS/DB_MASTERS/SSL`.
  - ⚠️ Earlier gotcha (already fixed): the `.env` had a stray `=` inside the username
    (`"=bi_enroute_readonly"`). If auth fails again, check for that / stray quotes.
- **DBA constraint (CONFIRMED HARD RULE, 2026-07-04):** `10.0.0.25` is the company's **production**
  database. Every query MUST carry a `LIMIT` **below 100** — the team made this compulsory, not
  guidance. All reads are paginated/chunked at **≤ 90 rows/query**; keep that cap in any new query work.
- **Verify connectivity:** `cd apps/backend && npm run build && npm run autoplant:ping`
  (prints `tb_vehiclemaster` = 59,585 rows, `mst_plant` = 27,537 rows, 3 sample telemetry rows).
- **Timezone:** AutoPlant server is `SYSTEM` tz = **IST**; source datetimes are naive IST (+330).
  The FSM normalizer's `+330 → UTC` assumption is correct (`AUTOPLANT_UTC_OFFSET_MIN`).

---

## 3. Production data facts (verified against `10.0.0.25`)

- **`mst_plant`**: composite PK **(`plant_id`, `plant_code`)** → `plant_id` is NOT unique (this caused a
  join fan-out bug — see §6). `company_id` NOT NULL (the reliable ownership edge → plant-first sync).
  ACTIVE plants ≈ 1,074 rows → **749 distinct `plant_id`**. `plant_state` is ~90% junk (blank/`NA`/`123`);
  `zone_name` is dirtier-but-more-populated and **self-contradictory** (e.g. `karnataka` labelled North).
- **`mst_vehicle`**: PK `vehicle_no`. `device_id` nullable (leading-zero IMEIs, alphanumerics — String
  identity is load-bearing). **`company_id` is unreliable (0 in prod)** → resolve company via the plant.
  `deployment_status`: DEPLOYED **17,846**, UNDEPLOYED 29,768, MAINTENANCE 75, ACTIVE 40.
- **`ap_widgets.tb_vehiclemaster`** (telemetry, 59,585 rows): has `device_id`, `latest_gps_datetime`
  (naive IST), `latitude/longitude`, `speed`, `IGNITION_STATUS`, `DEVICE_TYPE`, `gpssignal` (JSON:
  `power.mainstatus`/`mainvoltage`), plus `plant_id/plant_name/transporter_*/vehicle_deployment_status`.
  Full DESCRIBE captured; the snapshot reader's columns all exist.
- **No declared FKs** on the business master tables (only audit/Quartz) → integrity is by convention;
  FSM's defensive skip-if-parent-missing posture is correct.
- **Eligibility signal (for Stage B / tickets):** AutoPlant has no PGI. Use **`deployment_status =
  'DEPLOYED'`** as the interim "serviceable fleet" proxy (business call to confirm with Ops).

---

## 4. Architectural decision (this session)

**Replace the hardcoded state→zone code map with a data-driven, admin-owned translation layer.**
AutoPlant owns the RAW value (`mst_plant.zone_name`); FSM owns the OPERATIONAL mapping to a Zone, as
DATA (same posture as `sla_rule_config`/`priority_rule_config`). Three-tier resolver precedence:

1. **Plant-level override** (`plant_zone_overrides` by `source_plant_id`) — pins a specific plant.
2. **Value map** (`zone_mappings`, MAPPED rows only) on the normalized `zone_name`.
3. **PENDING → UNZONED** — unmapped/ambiguous values are never guessed: the plant lands in the seeded
   `UNZONED` holding zone (still visible) and the raw value is auto-discovered as a PENDING queue row.

Key properties: `plants.zone_id` stays **NOT NULL** (no breaking migration — pending plants go to
UNZONED). Master-sync is **insert-only on `zone_id`** (anti-drift); admin edits take effect only via the
FSM-owned **`reapply`** operation that recomputes `plants.zone_id` from current mappings/overrides.

---

## 5. What was built (files)

### Step 1 — R6 data-driven zone-mapping layer (DONE, tested)
- `prisma/schema.prisma` — added `ZoneMapping`, `PlantZoneOverride` models + `ZoneMappingStatus` enum
  (PENDING/MAPPED/IGNORED); Zone back-relations.
- `prisma/migrations/20260704120000_add_zone_mapping_layer/migration.sql` — **applied to local Postgres.**
- `src/ingestion/autoplant/mapping-table-zone-resolver.ts` — `MappingTableZoneResolver implements
  PlantZoneResolver`; `normalizeZoneKey()` (collapses West Zone/WEST/West→`west`, blank/NA→`__blank__`).
- `src/org/zone-mapping.service.ts` — CRUD, `listPending`, `mapValue`, `ignoreValue`, override CRUD,
  and **`reapply`** (recomputes `plants.zone_id`; the one sanctioned FSM-owned write to zone_id).
- `src/org/zone-mapping.controller.ts` — `OPERATIONS_HEAD` admin API (`/api/org/zone-mappings*`,
  `/api/org/plant-zone-overrides*`, `POST /api/org/zone-mappings/reapply`).
- `src/org/org.module.ts` (+`ZoneMappingService`), `src/app.module.ts` (+`ZoneMappingAdminController`).
- `src/org/org-seed.ts` — now seeds **5 zones: North, South, East, West, UNZONED**.
- Tests: `test/zone-mapping-normalize.spec.ts` (3), `test/zone-mapping-resolver.e2e-spec.ts` (5) — green.
- `test/setup-env.ts` + `vitest.config.ts` — clears `AUTOPLANT_MYSQL_*` in tests so a live `.env`
  doesn't break the "unconfigured" env-shape tests (fixes 2 env-driven failures).

### Step 2 — master-sync wiring + pipeline (DONE, tested; live-run validated)
- `src/ingestion/autoplant/autoplant-master-source.ts` — **refactored**: keyset pagination at ≤90/query
  (`pageAll`), source-side scope filters (`plantStatuses=['ACTIVE']`, `deploymentStatuses=['DEPLOYED']`),
  and **fan-out fixes** (see §6): plants deduped by `plant_id` (JS); vehicle company via a
  **`GROUP BY plant_id` subquery** (not a raw join).
- `src/device-state/device-state.module.ts` — gives `DeviceStateService` a Nest home (was in no module).
- `src/ingestion/autoplant/integration-sync.service.ts` — orchestrator: master-sync → snapshot → recompute.
- `src/ingestion/autoplant/integration-sync.controller.ts` — `OPERATIONS_HEAD`: `POST
  /api/integration/sync-masters` and `POST /api/integration/run-pipeline` (503 when AutoPlant unconfigured).
- `src/ingestion/ingestion.module.ts` — **wired `MasterSyncService`** with its 3 ports
  (`MASTER_SYNC_SOURCE`→paginated `AutoPlantMasterSource` when configured, else empty no-op source;
  `PLANT_ZONE_RESOLVER`→`MappingTableZoneResolver`; `MASTER_SYNC_SCOPE`={plantStatuses:['ACTIVE']}),
  `IntegrationSyncService`, `IntegrationSyncController`, imports `DeviceStateModule`.
- `src/ingestion/snapshots.controller.ts` — snapshot `POST /run` now bounds chunk size to ≤99
  (env `AUTOPLANT_SNAPSHOT_CHUNK_SIZE`, default 90).
- `src/ingestion/autoplant/autoplant-sync.ts` + `package.json` — **`npm run autoplant:sync`** standalone
  runner (masters-only by default; `pipeline` arg adds telemetry drain + recompute). Seeds zones first.
- Tests: `test/autoplant-master-source-pagination.spec.ts` (6), updated `test/autoplant-master-source.spec.ts`
  (5), `test/integration-sync-api.e2e-spec.ts` (2) — green.

---

## 6. The fan-out bug (found + fixed + validated)

`mst_plant`'s composite PK (`plant_id`,`plant_code`) means `plant_id` repeats. The original
`LEFT JOIN mst_plant ON plant_id` multiplied each vehicle ~2×, and plant reads ~1.3× → the **first**
live sync processed 981 plant-rows (749 distinct) and 78,755 vehicle-rows, took 6.5 min, and risked a
nondeterministic company assignment (last plant_code's company wins).

**Fix:** plants deduped by `plant_id` in JS after paging; vehicle company via a `GROUP BY plant_id`
subquery (deterministic `MIN(company_id)`, no fan-out). **Validated by a 2nd live run:** plants
updated 749 (not 981), vehicles updated 17,876 (not 72,535), **~2 min** (faster, not slower).

---

## 7. Live runs done this session (against production, read-only)

- `master_sync_runs` **113** — first run (pre-fix), SUCCESS, showed the fan-out inflation.
- `master_sync_runs` **114** — post-fix, SUCCESS, clean stats. **This is the current state.**
- Local Postgres now holds the AutoPlant org graph. NOTE: the local DB also contains pre-existing
  book8/test-fixture rows, so raw `vehicle.count()` (~36.6k) mixes synthetic + real; the AutoPlant fleet
  is the ~17.8k DEPLOYED set. A clean `prisma migrate reset` + reseed + resync would isolate real data
  (optional, not required for the dashboard).

**The real pending zone-mapping queue (from run 114):**

| key | raw | plants |
|---|---|---|
| `__blank__` | (null) | 476 |
| `west` | West Zone | 389 |
| `south` | SOUTH | 51 |
| `north` | North | 40 |
| `east` | East | 22 |
| `central` | Central | 2 |
| `sdf` | sdf | 1 |

All 749 plants are currently in **UNZONED** (zero mappings applied yet — by design).

---

## 8. How to run things

```bash
cd apps/backend
npm run build                     # compile (required before the scripts below — they run from dist/)
npm run autoplant:ping            # connectivity smoke test
npm run autoplant:sync            # masters only (org graph + pending zone queue) — light, ~2 min
npm run autoplant:sync pipeline   # + telemetry drain (~662 queries @ ≤90) + device-state recompute — heavier

# migrations / db
npx prisma migrate status
npx prisma migrate deploy         # apply pending migrations (zone-mapping migration already applied)

# tests
node node_modules/vitest/vitest.mjs run                         # full suite
node node_modules/vitest/vitest.mjs run test/<file>.spec.ts     # one file
```

Admin API (as `OPERATIONS_HEAD`, once `npm start` is running):
`GET /api/org/zone-mappings/pending` · `POST /api/org/zone-mappings/:id/map {fsmZoneId}` ·
`POST /api/org/zone-mappings/:id/ignore` · `PUT /api/org/plant-zone-overrides {sourcePlantId,fsmZoneId,reason}` ·
`POST /api/org/zone-mappings/reapply` · `POST /api/integration/run-pipeline`.

---

## 9. NEXT STEPS (in order)

1. **Full test suite is GREEN (2026-07-05): 820 passed / 5 skipped / 0 failed.** This required
   **isolating the test DB** — see §12. Before isolation the live master-sync had loaded ~17.9k real
   devices into the shared dev Postgres, so full-fleet ops (`DeviceStateService.recompute`,
   fleet-uptime aggregation) blew past the 5s per-test timeout. The suite now runs against a sibling
   `fsm_test` database (dev `fsm` DB with its synced fleet is untouched — real data + green suite
   coexist). Re-run any time with `node node_modules/vitest/vitest.mjs run`.
2. **Commit** the working tree (nothing has been committed this session). Suggested message theme:
   "feat(autoplant): data-driven zone-mapping layer + master-sync wiring + paginated source (Step 1+2)".
3. **Map the zones** (admin decision, but the 4 directional ones are unambiguous):
   `west→West`, `north→North`, `south→South`, `east→East`. Leave `__blank__` PENDING (stays UNZONED),
   `ignore` `sdf`. `central` (2 plants) has no FSM Central zone → decide (UNZONED, or nearest) with Ops.
   Do it via the admin API, or seed via a small script. Then `POST /api/org/zone-mappings/reapply`
   (or it applies naturally on the next sync for new plants).
4. **Run the full pipeline** to light up inactivity dashboards:
   `npm run autoplant:sync pipeline`. This drains `tb_vehiclemaster` telemetry (~662 bounded queries,
   several minutes) into `raw_device_snapshots`, then recomputes `device_states`
   (inactivity_hours / sla_bucket / plant+company denormalized). After this, `zoneOverview` and
   `companyPlantOverview` dashboards show real data.
5. **Verify the dashboard** reads real data (device_states → plants → zones → company_master joins).
6. **(Stage B — later) Ticket creation / Critical Queue:** needs an eligibility rule. AutoPlant has no
   PGI; interim = `deployment_status='DEPLOYED'` (edit `device-state/eligibility.ts` +
   `DeviceStateService` to feed it, or seed `pgi_history`). Confirm the rule with Ops Head first.
7. **(Phase 7 — later) Scheduler:** no cron yet (`@nestjs/schedule`/BullMQ not installed) — the pipeline
   is manual-trigger only. Choosing the scheduler tech is an architecture-HITL decision.

---

## 10. Open items / gotchas / decisions still owned by humans

- **Zone map ratification (R6):** the value→zone mappings are now data (admin-owned), but *which* zone
  each value maps to (esp. `central`, `__blank__` 476 plants) is an Ops-Head call. `west/north/south/east`
  are safe.
- **Company tier/rank (R13):** every synced company defaults to `SILVER`/`C` (no source in AutoPlant).
  Recommender canonical sort degenerates until a real tier feed (CRM/Ops) lands. Not a dashboard blocker.
- **`central` zone:** 2 plants label themselves Central; the FSM 4-zone model has no Central.
- **DBA "< 100 rows/query": CONFIRMED as a compulsory hard cap** (team directive, 2026-07-04 —
  `10.0.0.25` is production). All current reads honour ≤90. Never ship a query against it without a
  `LIMIT` below 100.
- **Scope decision (confirmed this session):** first-light = ACTIVE plants + DEPLOYED vehicles.
- **Local DB has test residue** (book8 fixtures) mixed with real AutoPlant data. Optional
  `prisma migrate reset` for a clean demo.
- **Snapshot telemetry drain** currently reads ALL of `tb_vehiclemaster` (59k rows), including
  non-DEPLOYED; only synced (DEPLOYED) devices get a `device_states` row, so extra pings are ingested but
  unused. Optional optimization: scope the snapshot read to synced devices.

---

## 11. Verification snapshot (end of session)

- `tsc --noEmit`: clean.
- `npm run build`: clean.
- Targeted tests green: zone-mapping normalize (3), zone-mapping resolver e2e (5), master-source
  pagination (6), master-source (5), integration-sync e2e (2), + the 2 previously-failing env tests.
- Full suite: **820 passed / 5 skipped / 0 failed (2026-07-05)** against the isolated test DB (§12).
- Two live master-sync runs succeeded against production; data present in local Postgres.

---

## 12. Test-DB isolation (2026-07-05) — why the suite is green again

**Problem:** the e2e suite shares one local Postgres via `DATABASE_URL`. After the live master-sync
loaded the real AutoPlant org graph (~17.9k devices) into the dev `fsm` DB, the full-fleet operations
timed out (`DeviceStateService.recompute` does an unscoped `device.findMany()` + a per-device upsert
loop; fleet-uptime `computeMonth` scans all eligible states). 17 of 19 failures were 5s timeouts; the
other 2 were direct data collisions (`AP03TC0959` is a real device → 404 became 200; ZM zone report
empty). **The branch code was sound — only the loaded data broke the suite.**

**Fix:** the suite now runs against a **sibling `fsm_test` database** on the same PG16/5433 server, so
the dev DB (and its synced fleet, for the dashboards) is never touched.
- `apps/backend/test/test-db-url.ts` — derives the URL (`…/fsm` → `…/fsm_test`; `TEST_DATABASE_URL` overrides).
- `apps/backend/test/global-setup.ts` — vitest `globalSetup`: `prisma migrate deploy` + `seedOrgReferenceData` against `fsm_test` once.
- `apps/backend/test/setup-env.ts` — overrides `process.env.DATABASE_URL` per worker (also still clears `AUTOPLANT_MYSQL_*`).
- `apps/backend/vitest.config.ts` — registers `globalSetup`.
- `apps/backend/.env.example` — documents the one-time superuser bootstrap.

**One-time bootstrap:** `fsm` is not a superuser (`rolcreatedb=false`), so `fsm_test` + PostGIS were
created as superuser. Local PG16 on 5433 allows a **passwordless `postgres` superuser (trust auth on
localhost)**; used to `CREATE DATABASE fsm_test OWNER fsm` + `CREATE EXTENSION postgis`. (Migrations
reference the bare `geometry` type, so PostGIS must exist per-database — it cannot be a separate schema.)

**Two latent fresh-DB bugs the clean test DB exposed — both fixed in `src/org/org-seed.ts` (so a fresh
dev/CI/prod seed is also correct):**
1. `component_master.component_id` is BIGSERIAL, but the Common-Kit rows seed EXPLICIT ids 1–4, which
   never advances the sequence → the next `componentMaster.create()` (no id) generated id=1 and hit a
   unique-constraint error. Fixed with a `setval(pg_get_serial_sequence(...), MAX(component_id))`.
2. `plant_eligible_floating_se` matview is created `WITH NO DATA` → any `SELECT` raises Postgres 55000
   ("has not been populated") until the first refresh. Seed now runs one plain `REFRESH MATERIALIZED
   VIEW` (0 rows is a valid populated state; `REFRESH … CONCURRENTLY` works thereafter).
