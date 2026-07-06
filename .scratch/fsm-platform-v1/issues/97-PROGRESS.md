# Issue 97 — Implementation Progress

Tracer-bullet TDD execution of
[`97-autoplant-ingestion-pipeline-operational.md`](./97-autoplant-ingestion-pipeline-operational.md).
Branch: `feat/autoplant-integration`. One slice = one PR-sized commit; `main` stays green at every step.

## Status board

| Slice | Title (review ref) | State | Commit | Tests |
|---|---|---|---|---|
| 1 | MySQL fail-fast timeouts (A4) | 🔵 committed `7bfad51` | `7bfad51` | 5 new · 825/830 suite |
| 2 | Stale-run reaper, both run tables (A2) | ✅ done | — | 6 new · 831/836 suite |
| 3 | PARTIAL-cursor lower-bound fix (A3) | ✅ done | — | 4 new · 835/840 suite |
| 4 | Itemised master-sync skip accounting (A5) | ✅ done | — | 6 new · 841/846 suite |
| 5 | Reconciliation counts in health (A6) | ✅ done | — | 7 new · 0 failures over 3 full runs |
| 6 | Overlap-safe telemetry tick | ✅ done | — | 3 new · 851/856 suite (clean run) |
| 7 | In-process `@nestjs/schedule` scheduler (A1) | ⬜ not started | — | — |

Legend: ⬜ not started · 🟡 in progress · ✅ done (tests + tsc + build green) · 🔵 merged

## Conventions in play
- Test runner: `npm test` (vitest run) in `apps/backend`; globals on; `test/setup-env.ts` clears
  `AUTOPLANT_MYSQL_*` so the client is UNCONFIGURED in tests (unset ⇒ mock is the safe default).
- Test DB: isolated `fsm_test` on PG16/5433 (global-setup migrates+seeds).
- Done bar per slice: new tests green · full backend e2e green (no regression) · `tsc --noEmit` clean ·
  read-only guard + `<100`-row cap unviolated · migrations no drift.

---

## Slice 1 — MySQL fail-fast timeouts (review A4)

**Goal.** A hung AutoPlant read (VPN half-failure) fails within a bounded time instead of pinning the
run open forever. Pool gets a `connectTimeout`; every `query()` gets a per-statement timeout.

**Design (testable seam).**
- `readQueryTimeoutMs(env)` / `readConnectTimeoutMs(env)` — standalone env readers (defaults 30000 /
  10000 ms). Kept OUT of `AutoPlantMysqlConfig` so the existing exact-match `autoplant-config.spec`
  stays green (config nullability is about *credentials present*; the timeout is always known).
- `buildPoolOptions(cfg, env)` — pure; carries `connectTimeout`.
- `withQueryTimeout(work, ms, sql)` — pure; rejects if `work` doesn't settle in `ms`.
- `AutoPlantMysqlClient.execute()` — `protected` seam wrapping the raw pool call, overridable in tests
  to simulate a hung/failed driver; `query()` = read-only guard → `withQueryTimeout(execute(...))`.

**Behaviors to test (vertical, one at a time).**
1. `query()` rejects within the timeout when the driver never settles (hung VPN). ← tracer
2. Happy path: a fast query still resolves and returns rows (timeout doesn't interfere).
3. Read-only guard still rejects a non-read query before the driver is touched (regression).
4. `buildPoolOptions()` carries `connectTimeout` (default + env override).
5. `readQueryTimeoutMs()` default 30000, honours `AUTOPLANT_QUERY_TIMEOUT_MS`.

### Cycle log
- **Cycle 1 (tracer).** RED: `query()` on a hung driver returned the not-configured error, not a
  timeout. GREEN: added `readQueryTimeoutMs`/`readConnectTimeoutMs`/`buildPoolOptions`/`withQueryTimeout`
  + `protected execute()` seam; `query()` = guard → `withQueryTimeout(execute(), readQueryTimeoutMs())`.
  → hung read now rejects `/timed out/i` within 50ms.
- **Cycles 2–5.** Happy-path read still returns rows (timeout inert); read-only guard fires before
  `execute()` (non-read never touches the driver); `buildPoolOptions` carries `connectTimeout`
  (10000 default, env override); `readQueryTimeoutMs` default 30000 + `AUTOPLANT_QUERY_TIMEOUT_MS`
  override (garbage → default).
- **REFACTOR.** None needed — behavior already lives in pure functions + one thin protected seam.

**Result.** `test/autoplant-mysql-timeout.spec.ts` 5/5 green · full backend suite **825 passed / 5
skipped / 0 failed** · `tsc --noEmit` clean. Read-only guard + `<100`-row cap untouched; existing
`autoplant-config.spec` unchanged (timeout kept out of the config shape by design).

**Deviation from the issue's slice-1 note.** The issue suggested extracting the timeout constant *into*
`readAutoPlantMysqlConfig()`. Kept it in sibling readers (`readQueryTimeoutMs`/`readConnectTimeoutMs`)
instead so config nullability stays "credentials present" and the exact-match config spec needed no
edit. Same env-overridable outcome, smaller blast radius.

**Files touched:** `src/ingestion/autoplant/autoplant-mysql.client.ts`,
`test/autoplant-mysql-timeout.spec.ts` (new). Ready to commit as one slice.

---

## Slice 2 — Stale-run reaper (review A2) — DONE

**Design.** Shared threshold helper `src/ingestion/stale-run.ts` (`readStaleRunMs` from
`INGESTION_STALE_RUN_MIN`, default 30 min; `ORPHANED_RUN_ERROR`, `DEFAULT_STALE_RUN_MIN`). Each run
service owns a table-specific `reapStaleRuns(now)` (the tables diverge — `master_sync_runs` has an
`error` column, `snapshot_runs` does not), called at the top of `startRun()` before the guard.

**Done in this session (implementation — all in place):**
- `src/ingestion/stale-run.ts` — new shared helper. ✅
- `master-sync-run.service.ts` — `reapStaleRuns()` (status→FAILED, finishedAt, error=ORPHANED) + called
  first in `startRun()`. ✅
- `snapshot-run.service.ts` — `reapStaleRuns()` (status→FAILED, finishedAt; no error col) + called
  first in `startRun()`. ✅
- `test/stale-run-reaper.e2e-spec.ts` — **1 of 6 tests written** (master reap → proceed). GREEN.

### Cycle log
- **Cycle 1 (tracer, prior session).** master: orphaned RUNNING (startedAt = 1h ago) is reaped →
  FAILED; next `startRun()` opens a fresh run instead of 409-ing.
- **Cycles 2–6 (this session; impl already in place, each test green on first run).**
  2. master: fresh RUNNING NOT reaped → 409 `RUN_IN_PROGRESS`, row still RUNNING.
  3. master: reaped row carries `error === ORPHANED_RUN_ERROR` + non-null `finishedAt`
     (via `reapStaleRuns()` directly).
  4. snapshot: orphaned RUNNING reaped (FAILED + finishedAt; no error col) → `startRun()` proceeds.
  5. snapshot: fresh RUNNING still 409s, row untouched.
  6. pure `readStaleRunMs`: default 30·60000; `INGESTION_STALE_RUN_MIN='5'` → 300000; garbage/negative
     → default; `DEFAULT_STALE_RUN_MIN === 30`.
- **REFACTOR.** Deleted the now-redundant CLI workaround in `autoplant-sync.ts`
  (`prisma.snapshotRun.deleteMany({status:'RUNNING'})`) — the reaper inside `startRun()` supersedes it.

**Result.** `test/stale-run-reaper.e2e-spec.ts` 6/6 green · full backend suite **831 passed / 5
skipped / 0 failed** · `tsc --noEmit` clean.

**Files touched:** `src/ingestion/stale-run.ts` (new), `master-sync-run.service.ts`,
`snapshot-run.service.ts`, `autoplant-sync.ts` (workaround removed),
`test/stale-run-reaper.e2e-spec.ts` (new).

---

## Slice 3 — PARTIAL-cursor lower-bound fix (review A3)

**Design.** `snapshot_runs.cursor` gets explicit dual semantics in `SnapshotIngestionWorker.run()`:
`dataAsOf` stays the conservative DISPLAY watermark (high-water of succeeded chunks; banner never
advances on lost data); the persisted resume cursor becomes, on PARTIAL only, the **first failed
chunk's `min(gpsDatetime)`** so the next run re-reads that window (`>=` resume in
`AutoPlantSourceReader`; `(device_id, gps_datetime)` ON CONFLICT absorbs the overlap). SUCCESS
(cursor = dataAsOf) and FAILED (both null) unchanged.

### Cycle log
- **Cycle 1 (tracer).** RED: PARTIAL run persisted cursor `T(2)` (succeeded high-water) instead of
  failed chunk's `T(1)`. GREEN: track `firstFailedLowerBound` (new `minDate` helper); finish with
  `resumeCursor = PARTIAL ? firstFailedLowerBound : dataAsOf`. Asserted dataAsOf stays `T(2)`.
- **Cycle 2.** SUCCESS pinned: cursor === dataAsOf high-water (regression, new explicit assertion).
- **Cycle 3.** FAILED pinned: null dataAsOf AND null cursor.
- **Cycle 4 (e2e).** Two-run sequence with a resume-aware reader mirroring the real `>=` resume:
  run 1 PARTIAL (middle window lost) → run 2 re-reads `>= T(1)`, inserts exactly the lost ping
  (`inserted === 1`, overlap deduped), every source row present exactly once.
- **REFACTOR.** Cursor-semantics naming folded into GREEN (`resumeCursor` local + A3 comment block).

**Result.** `test/snapshot-partial-cursor.e2e-spec.ts` 4/4 green · full backend suite **835 passed /
5 skipped / 0 failed** · `tsc --noEmit` clean.

**Files touched:** `src/ingestion/snapshot-ingestion.worker.ts`,
`test/snapshot-partial-cursor.e2e-spec.ts` (new).

---

## Slice 4 — Itemised master-sync skip accounting (review A5)

**Design.** New additive table `master_sync_rejects` (migration `20260705120000`,
`(run_id, entity, source_key, reason)` + composite index) enumerating every skipped natural key.
`EntityStat` gains optional `skippedByReason` (total `skipped` unchanged — existing specs untouched).
In `MasterSyncService.sync()`: one `skip(entity, sourceKey, reason)` helper at all 5 existing skip
sites (no new business rules); rejects buffered and flushed in ONE batched `createMany` per run,
capped at 5000 rows, best-effort (try/catch + warn — accounting never fails the sync), flushed on
both SUCCESS and FAILED paths.

**Reason vocabulary (one code per pre-existing skip site):**
plants `OUT_OF_SCOPE_STATUS` · `ZONE_UNRESOLVED` | companies `NO_INSCOPE_PLANT` |
vehicles `PLANT_NOT_SYNCED` · `COMPANY_NOT_SYNCED` | devices `VEHICLE_NOT_SYNCED` · `NO_FITTED_DEVICE`
(device rejects keyed by device id when present, else vehicle_no).

### Cycle log
- **Cycle 1 (tracer).** RED: `skippedByReason` undefined. GREEN: migration + model + `skip()`/
  `flushRejects()` infra, wired at the plants-status site.
- **Cycles 2–5.** RED→GREEN per site: plants ZONE_UNRESOLVED → companies NO_INSCOPE_PLANT →
  vehicles PLANT/COMPANY_NOT_SYNCED split → devices VEHICLE_NOT_SYNCED/NO_FITTED_DEVICE split.
- **Cycle 6 (failure mode).** `createMany` mocked to reject → sync still SUCCESS, counters persisted
  on the run row, only the itemised rows lost (WARN logged).
- **REFACTOR.** Folded into GREEN — every skip site is already a single `skip()` call.

**Suite incident (unrelated to this slice, diagnosed + recovered).** The first done-bar run failed
1 test: a vitest worker crashed ("Worker exited unexpectedly") on `reports-controller.e2e-spec.ts`
BEFORE its `afterAll`, leaking its recomputed May-2026 `device_downtime_summary_monthly` row (device
9393900); `fleet-uptime-report.e2e-spec.ts` — whose fleet total is a GLOBAL eligible-count — then saw
4 devices instead of 3. Cleaned the leaked fixture rows by hand (summary/cycle/state/device +
`P-rep-%` plant + `Co-rep-%` company), re-ran both specs green, re-ran the full suite.
*Latent fragility to keep in mind:* any worker crash skips `afterAll` cleanup, and
global-count assertions (fleet total) are sensitive to any leak for the same month. The crash
recurred once more on a different, DB-free file (`schedules-route-conflicts`) — environmental
(memory pressure), not test-specific; the third run was clean with every file accounted.

**Result.** `test/master-sync-skip-accounting.e2e-spec.ts` 6/6 green · full backend suite
**841 passed / 5 skipped / 0 failed** (Slice-5 RED tracer excluded from this bar by design) ·
`tsc --noEmit` clean · migration `20260705120000` applies with no drift.

**Files touched:** `prisma/schema.prisma` + `prisma/migrations/20260705120000_add_master_sync_rejects/`,
`master-sync-run.service.ts` (EntityStat), `master-sync.service.ts`,
`test/master-sync-skip-accounting.e2e-spec.ts` (new).

---

## Slice 5 — Reconciliation counts in health (review A6)

**Design.** `GET /api/integration/health` gains a `reconciliation` block: per entity
(`plants`, `vehicles`) `{ sourceCount, fsmCount, drift }` + top-level `reconciled` and the threshold
in play. Source side: new `MasterSourceCounts` seam (in `health.service.ts`), implemented by
`AutoPlantMasterSource` as single-row `COUNT(*)` reads (`COUNT(DISTINCT plant_id)` mirrors the
composite-PK dedup) that reuse the class's own `table()`/`inClause()` fragments — the reconciliation
query structurally cannot diverge from the sync query, and the `<100`-row cap is trivially met.
`AutoPlantHealthService` takes the counts dep as an optional 3rd ctor arg (two-arg call sites stay
valid); unconfigured/unreachable → `reconciled: null` + `error` (degraded, freshness untouched).
Threshold `INGESTION_RECON_MAX_DRIFT` (absolute rows, default 0) — informational ops knob, not a
business rule. Module wiring: the real master source doubles as the counts dep
(`instanceof AutoPlantMasterSource`); the empty unconfigured source leaves counts null.

### Cycle log
- **Cycle 1 (tracer).** RED (observed in the full-suite run: `reconciliation` undefined). GREEN:
  `ReconciliationHealth` + `reconciliationHealth()` in the health service; per-entity diff vs
  `prisma.plant.count()` / `prisma.vehicle.count()`.
- **Cycle 2.** Drift: source ahead by 3 → `drift: 3`, `reconciled: false` at default threshold 0.
- **Cycle 3.** Degraded ×2: no counts dep (unconfigured) and a throwing count (VPN drop) → both
  `reconciled: null` + error, freshness intact, no crash.
- **Cycle 4.** Threshold: `INGESTION_RECON_MAX_DRIFT=5` tolerates |3| → `reconciled: true`; pure
  `readReconMaxDrift` (default/override/garbage/negative).
- **Cycle 5.** `AutoPlantMasterSource.countPlants()`/`countVehicleMasters()`: exactly one physical
  single-row COUNT each, schema-qualified, same filters+params as the paged reads.
- **Wiring.** Health provider factory injects `MASTER_SYNC_SOURCE`, passes it as counts when it is
  the real `AutoPlantMasterSource`. Verified by the booting `integration-health-api` e2e.
- **REFACTOR.** Structural from the start — counts reuse the source's own filter fragments (the
  issue's stated refactor goal), so nothing left to extract.

**Files touched:** `health.service.ts`, `autoplant-master-source.ts`, `ingestion.module.ts`,
`test/integration-reconciliation.e2e-spec.ts` (new).

**Done-bar (environmental caveat, recorded honestly).** Three consecutive full-suite runs after
Slice 5: **zero test failures** (846 / 844 / 847 passed of 853; the deltas are files whose vitest
FORK was OOM-killed by Windows — box at ~1.5 GB free RAM — before reporting). The kill victim was a
different file each run (install-lifecycle+recovery → install-lifecycle → territory-coverage), every
victim passes standalone, and the union of the runs covers all 222 files green. `maxForks=1` and a
1.4 GB heap cap did not prevent the kills; they are infrastructure, not code. Each crash skips that
spec's `afterAll` — leaked fixtures (fixed device ids 9344900 / 9362001 + P-ilc/Co-ilc/P-recc/Co-recc
rows) were cleaned by hand before each subsequent run. *If a future session sees a unique-constraint
error in `install-lifecycle-controller` / `recovery-controller` seeds, suspect this leak first.*

---

## Slice 6 — Overlap-safe telemetry tick

**Design.** `IntegrationSyncService.ingestTelemetry({ chunkSize=90 })` — snapshot ingest +
device-state recompute, NO master sync. Returns a discriminated `TelemetryTickResult`:
`{ skipped: false, snapshot, deviceState }` or `{ skipped: true, reason: 'RUN_IN_PROGRESS' }`.
The 409-swallow lives in a shared private `skipOnOverlap(work)` helper — the Slice-7 masters cron
handler reuses it around `syncMasters()`, while the HTTP triggers keep propagating 409 verbatim.
Only the guards' `RUN_IN_PROGRESS` ConflictException is swallowed; any other failure propagates.

### Cycle log
- **Cycle 1 (tracer).** RED: `ingestTelemetry` not a function. GREEN: method + `skipOnOverlap` +
  `TelemetryTickResult`. Asserted: snapshot SUCCESS, recompute called once, master sync NEVER called.
- **Cycle 2.** Overlap: seeded fresh RUNNING snapshot run → `{ skipped: true, reason:
  'RUN_IN_PROGRESS' }`, recompute NOT called (no half-work), in-flight row untouched.
- **Cycle 3.** Non-overlap failure (`source exploded`) propagates — only RUN_IN_PROGRESS is a skip.
- **REFACTOR.** Built in — the swallow is already the shared helper the issue asked to extract.

**Files touched:** `integration-sync.service.ts`, `test/telemetry-tick.e2e-spec.ts` (new).

**Result.** 3/3 green · full backend suite **851 passed / 5 skipped / 0 failed — fully clean run,
all 223 files accounted** (the overnight attempt's one hook-timeout was the starved machine, spec
green standalone; the morning rerun was clean, which also retroactively clears Slice 5's
environmental caveat) · `tsc --noEmit` clean.

---

## Slice 7 — not started
In-process `@nestjs/schedule` scheduler (review A1): two env-gated cron handlers (masters daily,
telemetry short-interval via `ingestTelemetry`), dormant when disabled or AutoPlant unconfigured.
