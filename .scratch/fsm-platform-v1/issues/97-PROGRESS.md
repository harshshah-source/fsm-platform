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
| 4 | Itemised master-sync skip accounting (A5) | ⬜ not started | — | — |
| 5 | Reconciliation counts in health (A6) | ⬜ not started | — | — |
| 6 | Overlap-safe telemetry tick | ⬜ not started | — | — |
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

## Slice 4+ — not started
See the issue file §5 for slices 4–7. Order: A5 skips → A6 reconciliation → overlap-safe tick →
A1 scheduler.
