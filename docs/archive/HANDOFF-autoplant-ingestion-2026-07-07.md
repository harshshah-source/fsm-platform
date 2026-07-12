# Handoff — FSM AutoPlant Ingestion Remediation

> **ARCHIVED 2026-07-12 — consumed handoff.** Superseded by `docs/SYSTEM-STATE-2026-07.md` (the ingestion↔partition pairing rule is mirrored in INDEX.md's activation checklist + SYSTEM-STATE §6.2).
> ℹ️ **Partially closed since (noted 2026-07-10):** the pending items here were subsequently
> owned/landed by #108 (business sweeps), #112 (eligibility mode), #113 (dispatch cron). The
> ingestion↔partition pairing rule in §4 item 5 remains authoritative (mirrored in INDEX.md).

**Date:** 2026-07-07
**Repo:** `D:\fms_adminDashbooard\fsm-platform-greenfield`
**Branch:** `feat/autoplant-integration` (5 new commits, **not pushed**)
**Scope of this session:** diagnosing and fixing why AutoPlant ingestion never populated dashboards, ending in 5 committed+built slices and a proven end-to-end run.

---

## 1. What was done (committed — read the commits, don't re-derive)

Five focused commits on `feat/autoplant-integration` (newest first). Full rationale is in each commit message + code comments; do not duplicate:

```
3642b2f perf(autoplant): batch master-sync upserts, drop the per-row findUnique storm
53855cf perf(device-state): set-based recompute over device_states, no telemetry scan (R4-B)
10e5174 feat(ingestion): maintain device_states.latest_gps_datetime at ingest, set-based (R4-A)
65aa6e2 feat(ingestion): real daily partitioning + configurable retention (R3)
a438d20 fix(autoplant): cold snapshot scan pages by stable device_id, not the mutating latest_gps_datetime
```

These implement R1-plan items from `.scratch/fsm-platform-v1/ARCHITECTURE-REMEDIATION-PLAN.md` (R3, R4) plus the reader fix and master-sync batching. Build passes (`npm run build`, tsc exit 0); `dist/` now carries the fix (was stale/old before).

Key files touched (see `git show <hash>`): `src/ingestion/autoplant/autoplant-source-reader.ts`, `src/ingestion/partition-planner.ts`, `src/ingestion/partition-maintenance.service.ts`, `prisma/migrations/20260706130000_partition_raw_device_snapshots_daily/`, `src/ingestion/snapshot-ingestion.service.ts`, `src/device-state/device-state.service.ts`, `src/device-state/sla-bucket.ts`, `src/ingestion/autoplant/master-sync.service.ts`, `src/ingestion/ingestion.module.ts`, `src/settings/settings.service.ts`.

---

## 2. Established facts (proven with evidence — treat as settled, don't re-investigate)

- **Device identity contract is CORRECT.** `ap_masters.mst_vehicle.device_id` == `ap_widgets.tb_vehiclemaster.device_id`: 48,258/48,258 shared vehicles agree, 0 diff, 1:1 in both tables. `device_id` is the canonical join key. FSM joins on it correctly. The earlier "vendor-code vs IMEI mismatch" was dirty-but-consistent source data (e.g. vehicle-reg stored as device_id in BOTH tables) + a partial prior sync — not an architecture problem. **Do not redesign the identity layer.**
- **The empty-dashboards root cause** was NOT identity/join/recompute-logic. Snapshot run 456 (old cold-scan) wrote 576k rows for a ~60k fleet then **orphaned RUNNING** (readChunk threw after chunk 6,406; worker has no try/finally around the read, so `finishRun` never ran). Because recompute runs only after a successful snapshot, `device_states.latest_gps_datetime` stayed null → null buckets → empty dashboards.
- **The fix is verified end-to-end against production data.** After reaping 456 and running the pipeline with the fixed reader: cold scan terminated in 600 chunks → run 457 SUCCESS with cursor+data_as_of set → device_states 17,715/18,895 have latest_gps, 17,712 bucketed, 5,152 inactive → dashboard rollup non-empty (OpsHead/CSM = 5,152 visible rows).

---

## 3. Current runtime/DB state (dev DB `fsm` @ localhost:5433)

- `snapshot_runs`: run 456 = FAILED (reaped, journal untouched 576,540→576,540), run 457 = SUCCESS.
- `device_states`: populated & derived (computed 2026-07-06 ~13:33).
- Dashboards for **OpsHead/CSM show data**; **ZM dashboards only for mapped zones** — most inactive devices are in the `UNZONED` holding zone because `zone_mappings` is barely configured (only West mapped). This is the R6 operational gap (admin must work the zone-mapping queue), NOT a code bug.
- The dev DB is **polluted** (hundreds of leftover `Zone <hash>` / `Z-*` test zones, mixed test/real data). A clean-DB run is preferable for any pristine verification.
- Master sync uses `deploymentStatuses:['DEPLOYED']` → ~18k devices; `tb_vehiclemaster` has ~60k, so undeployed devices are correctly deferred at ingest (expected WARN logs).

---

## 4. Open work / what a next session should consider (NOT done)

Priority order (severity from the audit — see conversation, not re-listed here):

1. **Push the 5 commits** if desired (`git push`) — I did not push (not asked).
2. **CRITICAL — worker `try/finally`** (`src/ingestion/snapshot-ingestion.worker.ts`, run loop ~line 65-107): `readChunk` at :66 is uncaught and `finishRun` is only after the loop, so a mid-scan read failure still orphans a run (exactly what happened to 456). The reader fix stops the *runs-forever* orphan but NOT the *read-error* orphan. Fix before enabling the unattended scheduler. This is remediation-plan R2 (partially unaddressed) + audit High #4.
3. **CRITICAL — acting half is unwired.** `TicketCreationService.createForInactiveEligible` has no non-test caller; recommender/dispatch/verification/intraday have no scheduler. With the scheduler enabled the platform ingests but creates zero tickets. Blocked on the `pgi_history` eligibility business decision (review B7) — an escalation, not a code task.
4. **HIGH — no heartbeat; stale-run reaper threshold (30m) == telemetry cron (30m)** — a run >30m gets reaped alive → concurrent runs. Add `heartbeat_at` + make reaper liveness-based (remediation R2).
5. **HIGH — partition maintenance is default-OFF + a separate flag** (`PARTITION_MAINTENANCE_ENABLED`). Enabling ingestion without it → after 3 days pings fall to DEFAULT partition and retention never runs. Consider folding under the ingestion enable flag.
6. **MEDIUM** — no forced periodic full-scan/reconciliation (remediation R10 §3); reconciliation counts include FSM seed rows (noisy); `tb_vehiclemaster.device_id` is indexed (`idx_device_id`) but **non-unique** (~1,200 dupes) so the cold keyset could skip a dup at a page boundary — low risk, worth a tiebreak eventually.
7. **Pre-existing uncommitted files that are NOT mine** — left untouched: `src/ingestion/snapshots.controller.ts` (chunk-size env override) and untracked `state-zone-map.ts`, `state-map-zone-resolver.ts`, `zone-mapping-*`, `dashboard-total-devices`, `device-list`, `warehouse-stock`, `ticket-forms-read`, `dev-zone-resolver`. Whoever owns them should commit separately. Also many pre-existing `apps/admin/*` modifications from before this session.

---

## 5. Gotchas / environment notes for the next agent

- **Prisma 7 has no bundled engine** — `new PrismaClient()` fails; must pass `new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })` (see `src/prisma/prisma.service.ts`). For quick DB probes, write a `.ts` file **inside `apps/backend/`** (module resolution) and run `npx tsx file.ts`; the generated client is TS, so plain `node` can't load it.
- **`dist/` can be stale** — `npm run start` runs `node dist/main.js`. Always `npm run build` after source changes or it runs old code (this bit us: the pre-fix `dist` had the old reader).
- **Running the pipeline manually against working-tree src** (guarantees uncommitted/fresh code): construct the real services and call them via a `tsx` script — pattern used this session (reap via `SnapshotRunService.reapStaleRuns()`, then `MasterSyncService.sync()` → `SnapshotIngestionWorker.run({chunkSize:90})` → `DeviceStateService.recompute()`). The temp runner was deleted; reconstruct from `src/ingestion/autoplant/integration-sync.service.ts` (`runPipeline`) + module wiring in `src/ingestion/ingestion.module.ts`.
- **AutoPlant is reachable** (VPN up as of this session); creds are in `apps/backend/.env` (do NOT echo them). ≤90 rows/query DBA cap applies to **reads from AutoPlant**, not writes to Postgres.
- **Full cold scan ~60k devices ≈ 600 chunks ≈ 3-4 min** over VPN; master sync ~1 min; recompute seconds. Run long ops in background and poll the log.
- **Tests:** run targeted (`npx vitest run test/<file>`), NOT the full suite — there's a known OOM on full runs on this 8GB box (see memory `backend-suite-oom-worker-kills`). e2e run against the sibling `fsm_test` DB, not `fsm`.
- Memory file `autoplant-branch-uncommitted-layer` notes the branch tip doesn't build alone — relevant to commit hygiene.

---

## 6. Suggested skills for the next session

- **`/code-review`** (or `/review`) — review the 5 committed slices against repo standards + the originating remediation-plan/issue before pushing.
- **`/tdd`** — for the worker `try/finally` fix and any heartbeat/reaper work (repo is strict red-green-refactor; see `docs/agents/workflow.md`).
- **`diagnose`** — if a fresh pipeline run orphans again (read-error path), for a disciplined repro→instrument loop.
- **`field-ops-director`** — to sanity-check the zone-mapping/UNZONED behavior and the acting-half gating against field-service reality before wiring tickets.
- Do NOT use identity/architecture-redesign framing — that question is closed (Section 2).

---

## 7. Key reference paths (read these, not this doc's summary of them)

- Remediation plan: `.scratch/fsm-platform-v1/ARCHITECTURE-REMEDIATION-PLAN.md` (R1-R10)
- Issue 97 (ingestion operational): `.scratch/fsm-platform-v1/issues/97-autoplant-ingestion-pipeline-operational.md`
- Issue 96 (master sync): `.scratch/fsm-platform-v1/issues/96-autoplant-master-sync.md`
- AutoPlant source schema docs: `docs/autoplant/`
- Project context / agent rules: `CLAUDE.md`, `docs/agents/workflow.md`
- Prisma schema: `apps/backend/prisma/schema.prisma`
