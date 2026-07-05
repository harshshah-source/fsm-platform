# Issue 97 — Implementation Progress

Tracer-bullet TDD execution of
[`97-autoplant-ingestion-pipeline-operational.md`](./97-autoplant-ingestion-pipeline-operational.md).
Branch: `feat/autoplant-integration`. One slice = one PR-sized commit; `main` stays green at every step.

## Status board

| Slice | Title (review ref) | State | Commit | Tests |
|---|---|---|---|---|
| 1 | MySQL fail-fast timeouts (A4) | ✅ done (uncommitted) | — | 5 new · 825/830 suite |
| 2 | Stale-run reaper, both run tables (A2) | ⬜ not started | — | — |
| 3 | PARTIAL-cursor lower-bound fix (A3) | ⬜ not started | — | — |
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

## Slice 2 — Stale-run reaper (review A2) — next
Shared reaper marks `RUNNING` rows older than `INGESTION_STALE_RUN_MIN` → `FAILED` before `startRun()`
takes the lock, for **both** `master_sync_runs` and `snapshot_runs`; then delete the CLI snapshot-only
`deleteMany({status:'RUNNING'})` workaround.
