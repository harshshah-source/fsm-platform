# Issue 97 — Session Handoff (2026-07-05)

**Task:** Implement Issue 97 (complete the AutoPlant ingestion pipeline) via `/tdd`, one slice per
commit. Branch: `feat/autoplant-integration`. Backend at `apps/backend`.

**Read first:** [`97-autoplant-ingestion-pipeline-operational.md`](./97-autoplant-ingestion-pipeline-operational.md)
(the issue, §5 = the 7 slices) and [`97-PROGRESS.md`](./97-PROGRESS.md) (live status board + cycle log).
This file is the "resume here" pointer; PROGRESS.md has the detail.

---

## Where things stand

- **Slice 1 (MySQL fail-fast timeouts, A4) — DONE & COMMITTED.**
  - `docs` commit `3b86657` (issue design) + code commit `7bfad51`.
  - `autoplant-mysql.client.ts` gained `readQueryTimeoutMs`/`readConnectTimeoutMs`/`buildPoolOptions`/
    `withQueryTimeout` + a `protected execute()` seam. `test/autoplant-mysql-timeout.spec.ts` (5 tests).
  - Verified: 5/5 new · full backend suite **825 pass / 5 skip / 0 fail** · `tsc --noEmit` clean.

- **Slice 2 (stale-run reaper, A2) — IN PROGRESS, PAUSED. Implementation complete, tests partial.**
  - **Uncommitted** working-tree changes (confirmed via `git status`):
    - `?? apps/backend/src/ingestion/stale-run.ts` (new shared helper — `readStaleRunMs`,
      `DEFAULT_STALE_RUN_MIN=30`, `ORPHANED_RUN_ERROR`).
    - `M  apps/backend/src/ingestion/autoplant/master-sync-run.service.ts` (added `reapStaleRuns()`,
      called first in `startRun()`; reaps → FAILED + `finishedAt` + `error=ORPHANED_RUN_ERROR`).
    - `M  apps/backend/src/ingestion/snapshot-run.service.ts` (added `reapStaleRuns()`, called first in
      `startRun()`; reaps → FAILED + `finishedAt`; **no `error` column** on `snapshot_runs`).
    - `?? apps/backend/test/stale-run-reaper.e2e-spec.ts` (**1 of 6 tests**, GREEN).
    - `M  .scratch/fsm-platform-v1/issues/97-PROGRESS.md` (board + Slice-2 plan).
  - Tracer test passing: `npx vitest run test/stale-run-reaper.e2e-spec.ts` → 1/1 green.

---

## ⚠️ Do this first (dangling edit)

`test/stale-run-reaper.e2e-spec.ts` has its **import block already extended** with
`DEFAULT_STALE_RUN_MIN, ORPHANED_RUN_ERROR, readStaleRunMs` from `../src/ingestion/stale-run`, but the
**test bodies that use them are not written yet** — so those imports are currently unused. `npm test`
still passes (SWC strips types, doesn't check unused imports), but finish the tests so the imports are
real. Don't remove the imports; add the tests.

## Finish Slice 2 (exact steps)

1. **Write the 5 remaining tests** in `test/stale-run-reaper.e2e-spec.ts` (impl already supports all —
   these should go green immediately; still add them one at a time and run between):
   - master: fresh (non-stale) RUNNING is NOT reaped → `MasterSyncRunService.startRun()` throws 409
     `ConflictException` with `{ code: 'RUN_IN_PROGRESS' }` (pattern in
     `master-sync-run-lifecycle.e2e-spec.ts:48`).
   - master: reaped orphan row has `error === ORPHANED_RUN_ERROR` and non-null `finishedAt`.
   - snapshot: orphaned RUNNING (create with `startedAt: HOUR_AGO()`) is reaped →
     `SnapshotRunService.startRun()` proceeds (fresh runId).
   - snapshot: fresh RUNNING still 409s.
   - pure `readStaleRunMs`: `readStaleRunMs({})` === `30*60000`; `{ INGESTION_STALE_RUN_MIN: '5' }` →
     `300000`; garbage → default; `DEFAULT_STALE_RUN_MIN === 30`.
   - Seed an old RUNNING row via `prisma.<table>.create({ data: { status: 'RUNNING', startedAt: HOUR_AGO() } })`
     — `startedAt` is settable on create (it only *defaults* to now()). `HOUR_AGO` helper already in the spec.
   - Test isolation: `beforeEach` already `deleteMany({status:'RUNNING'})` on both tables; `afterEach`
     cleans `created[]`. Push every created/seeded runId into `created`.

2. **REFACTOR:** delete the now-redundant CLI workaround at `src/ingestion/autoplant/autoplant-sync.ts:84`
   (`await prisma.snapshotRun.deleteMany({ where: { status: 'RUNNING' } });`). The reaper inside
   `startRun()` supersedes it. Verify `tsc` still clean.

3. **Done-bar:** `npx vitest run` (full suite, ~6 min) → expect 830 pass +6 new / 5 skip / 0 fail;
   `npx tsc --noEmit` clean.

4. **Update** `97-PROGRESS.md` board (Slice 2 → done) + cycle log, then **commit**:
   `feat(autoplant): stale-run reaper for both run tables (Issue 97 Slice 2 / review A2)`
   with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
   Commit these files only: `stale-run.ts`, both run services, the spec, the CLI file, `97-PROGRESS.md`.

---

## Then continue: Slices 3–7 (issue §5)

Order: **3** PARTIAL-cursor lower-bound fix (`snapshot-ingestion.worker.ts`) → **4** itemised master-sync
skip accounting + `master_sync_rejects` migration → **5** reconciliation counts in `/api/integration/health`
→ **6** overlap-safe telemetry tick (`IntegrationSyncService.ingestTelemetry()`, swallow 409) → **7**
in-process `@nestjs/schedule` scheduler (new dep; env-gated OFF by default; dormant when AutoPlant
unconfigured). Each is a standalone commit; `main` stays green throughout.

## Working conventions (verified this session)
- Run one spec: `npx vitest run test/<file>.spec.ts` from `apps/backend`. Full suite: `npx vitest run`
  (~380s, `fileParallelism:false`). Typecheck: `npx tsc --noEmit`.
- Test DB: isolated `fsm_test` on PG16/5433 (global-setup migrates+seeds). `test/setup-env.ts` clears
  `AUTOPLANT_MYSQL_*` so the client is UNCONFIGURED in tests.
- Vitest globals on (`describe/it/expect` need no import); prefer explicit imports for helpers.
- **Commit hygiene:** the branch carries UNRELATED pre-existing edits — notably `M .scratch/…/INDEX.md`
  (status updates to issues 69/70/73/78/91/96 that predate this work) and many `M apps/admin/**` files.
  Do NOT sweep those into Issue-97 commits; stage explicit pathspecs only. (My Issue-97 line IS in
  INDEX.md but left uncommitted alongside those pre-existing edits — commit it only if you also mean to
  commit the rest of that file, or extract just the 97 hunk.)
- Line-ending warnings (LF→CRLF) on commit are normal on this Windows checkout; harmless.

## Key facts
- No `@nestjs/schedule` / BullMQ / Redis in `apps/backend/package.json` (Slice 7 adds `@nestjs/schedule`).
- `snapshot_runs.status` is an enum (`SnapshotStatus`), no `error` column; `master_sync_runs.status` is a
  String with an `error` column. Both have `startedAt @default(now())` and the `WHERE status='RUNNING'`
  partial-unique in-flight guard.
- Acting half (ticket creation → recommender → dispatch) is OUT OF SCOPE for Issue 97 — gated on the
  eligibility business decision (review B7, empty `pgi_history`). Don't wire it here.
