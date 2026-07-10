# Handoff — AutoPlant Production Integration (2026-07-02)

Continue implementing the AutoPlant production ingestion pipeline, **one phase at a time, TDD**.
This doc is a pointer sheet — the real content lives in the artifacts referenced below. Read them first.

## Where the design lives (read before coding)
- **Blueprint:** `docs/architecture/autoplant-production-integration.md` — phase roadmap (§11), file-level
  checklist (§12), Prisma review (§7, incl. rows 1/1a device_id, 2 transporters, 3 source ids, 3a plant org
  attrs, 4/4a status+company_type), risks (§14, esp. R13 tier/rank, R14 scoping).
- **Org/Zone decision:** `docs/architecture/zone-architecture-investigation.md` — **§Revision 3** is the current
  conclusion (mirror authoritative `mst_plant` org hierarchy as `source_*` attributes; FSM operational Zone stays
  FSM-owned). **R3.10** = open business questions; **R3.11** = why the zone *partition* is unprovable from evidence
  + read-only SQL (P1–P5) to *inform* it. **Do not invent the partition or a state→zone table.**
- **Source data reference:** `docs/autoplant_databaseData.md` (ap_widgets + ap_masters structure & samples).
- **Domain authority:** `CONTEXT.md` (Snapshot, Device, Zone, Technical Hint, Data Layers).

## Branch & commits
- Branch **`feat/autoplant-integration`** (off `main` @ `c3195d0`), **not merged**. Two commits:
  - `64ef534` — Phase 1: two-schema connectivity (`ap_widgets`+`ap_masters`), TDD.
  - `d619aa7` — Phase 2a: additive org-mirror schema + migration `20260702120000_add_autoplant_org_mirror`.
- Read `git show 64ef534 d619aa7` for exact diffs — not repeated here.

## Done ✅
- **Phase 1** — `AutoPlantMysqlClient` config now carries `dbWidgets`/`dbMasters`; `autoplant-ping` proves both
  schemas. `test/autoplant-config.spec.ts` (5 tests).
- **Phase 2a** — additive/non-breaking: `company_master`(+source_company_id,company_type,status),
  `plants`(+source_plant_id + org-mirror attrs + status), `vehicles`(+status), new `transporters` +
  `master_sync_runs` tables. Verified: migrate deploy clean, client regenerated, `tsc --noEmit` green,
  org/dashboard e2e 11/11.
- **Phase 2b** — `device_id BigInt → String` (breaking; migration `20260702130000_device_id_bigint_to_string`).
  All 9 models retyped (`Device`@id, `DeviceState`@id, `RawDeviceSnapshot`, `FailureCycle`, `Ticket`,
  `PgiHistory`, `DeviceDowntimeSummaryMonthly` composite PK, `NonOperationalMarking`, `VerificationRun`) +
  `SourceSnapshotRow.deviceId`. Migration drops+re-adds the 5 device FKs, retypes the RANGE-partitioned raw
  table + composite-PK summary via `::text` (hand-written raw SQL). HTTP parsers (devices + non-op controllers,
  install single+CSV) now accept opaque string ids (leading-zero IMEIs / alphanumeric vendor ids; no numeric
  reject — `device-detail-controller` "non-numeric→400" test updated to "alphanumeric→404"). `canonical-sort`
  device tiebreak is now lexicographic (deterministic; single-digit fixtures unaffected). Verified: migrate
  deploy clean, `tsc --noEmit` 0 errors, no BigInt device refs in `src`, **full suite 737 passed** (fixtures
  churned bigint→String across ~100 test files; `book8-dataset.spec` self-skips without the gitignored CSV).
  Env note: the dev DB had ~30k orphaned book8 devices from an earlier failed run bloating `recompute` past
  the 5s test timeout — truncated the device spine (`TRUNCATE ... CASCADE`) as a one-off env reset.

## Next phases (in order)
1. ~~**Phase 2b — `device_id BigInt → String`**~~ ✅ **DONE** (see Done section above).
2. **Phase 3 — AutoPlant `SourceReader`** over `tb_vehiclemaster`+`gpssignal` (IST→UTC via `normalize.ts`,
   cursor-resume `(gps_datetime, device_id)` per `ARCHITECTURE-REMEDIATION-PLAN.md` R10). Rebind `SOURCE_READER`.
3. **Phase 4 — Master synchronizer** (upsert company/plant/transporter/vehicle/device by `source_*_id`). **This
   phase also lands** `plants.zone_id → nullable` (+ its ~16 cross-zone/planner/override ripples) and the
   Vehicle→Transporter FK — both deferred out of 2a on purpose.
4. Snapshot ingestion wiring → device-state generation → dashboard validation.

## Deferred / open (do NOT implement without sign-off)
- **Operational zone assignment, ZM routing, recommendation routing, ticket ownership** — business-rule-gated.
- **Zone partition** (how many FSM zones, which states) — Ops-Head decision; see zone doc R3.10 Q8 / R3.11.
- **Master scoping** — which `mst_company`/`mst_plant` rows are FSM's fleet (mst_company mixes shippers+transporters
  +test+inactive; mst_plant has test/inactive plants) — zone doc R3.8/R3.10 Q1–Q2.
- **Company tier/rank** — absent in AutoPlant (Risk R13).
- Run the read-only SQL (blueprint §5 / zone doc R3.11 P1–P5) against production to inform the above.

## Environment quirks (important)
- Dev DB: **PG16 + PostGIS @ `localhost:5433`** (`DATABASE_URL` in `apps/backend/.env`, not committed). PG18/5432
  references are stale.
- The dev DB user **cannot create a shadow database** → `prisma migrate dev` fails (P3014). This repo **hand-authors
  `migration.sql` + `prisma migrate deploy`** (existing pattern; migrations contain raw SQL for partitioning/PostGIS).
- `prisma migrate diff --from-config-datasource` is **unusable** — it wants to drop the raw-SQL GiST/partition/partial
  objects Prisma can't model. Diff from migrations needs a shadow DB. So: hand-write migrations.
- Prisma 7 CLI: `db execute` needs `--file`/`--stdin` (careful with args). For ad-hoc DB checks/DDL, a throwaway
  `pg`-client `.cjs` run from `apps/backend/` (so `require('pg')` resolves) with `node -r dotenv/config` is reliable —
  delete it after (do not commit).
- Generated Prisma client (`apps/backend/src/generated/prisma`) is **untracked** (regenerated on build) — don't commit.
- Tests: Vitest, `.spec.ts` = unit (no DB), `.e2e-spec.ts` = need PG (serial, `fileParallelism:false`).

## Shared-branch caveat
`main`'s working tree carries a concurrent agent's uncommitted changes (FE + a `ZoneWarehouseStock` model in
`schema.prisma`, plus an untracked `20260701000000_add_zone_warehouse_stock` migration). The Phase-2a commit's
`schema.prisma` **includes that `ZoneWarehouseStock` model** (git can't split a file non-interactively; it matches
its already-committed migration). Watch for this at merge time. Use partial-commit pathspecs; don't sweep the FE
agent's files.

## Suggested skills
- **`/tdd`** — the project's red-green-refactor protocol (CLAUDE.md). Use for every phase (2b onward): write the
  failing test first, then implement. Per-slice TDD report format per `docs/agents/workflow.md`.
- **`/verify`** — after a non-trivial phase, exercise the flow end-to-end (e.g. `autoplant:ping`, a bounded snapshot
  run) rather than trusting tests alone.
- **`/code-review`** — before merging the branch to `main`.
- Workflow note (`docs/agents/workflow.md`): **AFK by default** — auto-proceed routine RED/GREEN/REFACTOR; stop only
  for architecture / business-rule / creds/infra / destructive events. The deferred items above are exactly the
  "stop and ask" cases.
