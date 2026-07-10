# Progress — Issue 04: Snapshot ingestion + data-as-of banner

> Build date: 2026-06-19 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All buildable acceptance criteria green. AC#7 (<10-min target) is satisfied at
> the design level — the real AutoPlant read connection is deferred behind the `SOURCE_READER` seam
> (HITL / external-access), so no representative-volume benchmark was run.
> Backend **96 tests / 30 files** green (35 of them snapshot-specific across 7 files), admin
> **11 tests / 4 files** green, both `tsc --noEmit` clean (local PostgreSQL 18, no Docker).

## Summary

The Snapshot ingestion slice end-to-end: a `SnapshotIngestionWorker` drains GPS telemetry from the
AutoPlant source (behind a cursor-based `SourceReader` seam) in idempotent chunks into the
range-partitioned `raw_device_snapshots`, tracking each run in `snapshot_runs` (+
`snapshot_run_chunks`). Source GPS wall-clock timestamps are normalized to true UTC instants at
ingestion; all other telemetry is preserved verbatim. A single in-flight run is enforced two ways
(advisory xact lock + partial-unique index). The `/api/snapshots/*` surface exposes the run trigger,
history, and the freshness feed; the admin **Snapshot freshness banner** rides the top of every page
showing the last successful data-as-of timestamp, flipping to a red alert on a FAILED or stuck run.

Built on Issue 01/02 primitives (`AuthGuard→RoleGuard`, `@Roles`, global Prisma, the admin
`AuthProvider`/sessionStorage token pattern).

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Worker pulls AutoPlant rows cursor-based & chunked into `raw_device_snapshots` | 🟢 | `SnapshotIngestionWorker` drains `SourceReader.readChunk(cursor, size)` until `nextCursor === null`; `test/snapshot-worker.e2e-spec.ts` (5), `test/source-reader.spec.ts` (5). Real reader deferred behind `SOURCE_READER` token (see deviations). |
| 2 | `snapshot_runs` lifecycle RUNNING → SUCCESS/FAILED with run timestamp | 🟢 | `SnapshotRunService.startRun`/`finishRun`; status enum `RUNNING/SUCCESS/FAILED/PARTIAL`; `test/snapshot-run-lifecycle.e2e-spec.ts` (4). PARTIAL added for mixed-chunk runs. |
| 3 | Source timestamps normalized to UTC; telemetry preserved verbatim | 🟢 | `src/ingestion/normalize.ts` (`normalizeGpsTimestamp` backs out the source UTC offset; only the timestamp is transformed); `test/normalize.spec.ts` (6). Columns are `timestamptz`. |
| 4 | Duplicate snapshot rows handled idempotently | 🟢 | `createMany({ skipDuplicates: true })` → `ON CONFLICT DO NOTHING` against the `(device_id, gps_datetime)` UNIQUE; a re-run inserts nothing. `test/snapshot-ingest-chunk.e2e-spec.ts` (4). |
| 5 | Data-as-of banner shows last successful Snapshot timestamp on every page | 🟢 | `SnapshotBanner` (mounted in `AppRoutes` above `<Routes>`) reads `GET /api/snapshots/latest`; `apps/admin/test/snapshot-banner.test.tsx` (4, incl. the `/settings` page). |
| 6 | FAILED or stuck Snapshot renders a red alert banner | 🟢 | Banner flips to `role="alert"` on `latest.status === 'FAILED'` or a `RUNNING` run older than the 15-min stuck threshold; covered by the same suite. |
| 7 | Snapshot completes within <10-min target on representative volume | 🟡 **Design-level** | Cursor + chunked (~1000/read) + idempotent `createMany`; `raw_device_snapshots` range-partitioned by `gps_datetime` with the hot `(device_id, gps_datetime DESC)` index. No volume bench — real AutoPlant source not connected (HITL/external-access). |

## Slices delivered (build order)

1. **Schema** — `snapshot_runs`, `snapshot_run_chunks`, range-partitioned `raw_device_snapshots` (+ DEFAULT partition); single-in-flight partial-unique index; `(device_id, gps_datetime)` idempotency UNIQUE. `test/snapshot-ingestion-schema.e2e-spec.ts`.
2. **Source seam** — `SourceReader` interface + `SOURCE_READER` DI token + `InMemorySourceReader` mock; cursor-based chunked reads.
3. **Chunk writer** — `SnapshotIngestionService.ingestChunk`, idempotent via `skipDuplicates`, telemetry verbatim.
4. **Run lifecycle** — `SnapshotRunService`: advisory-xact-lock start + partial-unique backstop → 409 `RUN_IN_PROGRESS`; `finishRun` records status/`data_as_of`/cursor.
5. *(merged into 6)* normalize — `normalize.ts` UTC conversion.
6. **Worker** — `SnapshotIngestionWorker` composes source + chunk writer + run lifecycle; per-chunk retry ×3 with backoff; finalizes SUCCESS/PARTIAL/FAILED; `data_as_of` = high-water `gps_datetime`, left null on a fully-FAILED run so the banner never advances on bad data.
7. **API** *(this session)* — `SnapshotsController` (`ingestion.module.ts`): `GET /latest` (ZM/CSM/OpsHead), `GET /runs` (OpsHead), `POST /run` (OpsHead, 409 on in-flight). `test/snapshots-api.e2e-spec.ts` (6).
8. **Banner** *(this session)* — `src/api/snapshots.ts` client + `SnapshotBanner` + `AppRoutes` wiring.

## Data model added (migration, this issue)

- `20260619153000_add_snapshot_ingestion` — enums `snapshot_status`, `chunk_status`; tables
  `snapshot_runs`, `snapshot_run_chunks`, `raw_device_snapshots` (hand-written `PARTITION BY RANGE
  (gps_datetime)` + DEFAULT partition — Prisma can't express partitioning); partial-unique
  in-flight-run guard and the `(device_id, gps_datetime)` idempotency UNIQUE added as raw SQL.

## Deviations / deferred (read before extending)

1. **Real AutoPlant source not connected** — `SOURCE_READER` is bound to an empty
   `InMemorySourceReader([])` in `IngestionModule`. The read-only AutoPlant connection (credentials +
   provisioning) is HITL / external-access; bind the real reader to this token when it lands. Until
   then `POST /api/snapshots/run` is a clean SUCCESS no-op, and the <10-min target (AC#7) is unbenched.
2. **Partition maintenance deferred** — only the DEFAULT partition exists. Monthly child partitions +
   detach/archive belong to a later `ArchiveExportWorker` slice.
3. **`POST /run` runs the worker synchronously in-request** — fine for the empty placeholder source;
   move to BullMQ/scheduled execution when the real source (and real volume) is wired.
4. **`runId` (BIGSERIAL/bigint) serialized as a string** across the API (Nest can't JSON-serialize
   bigint) — mirrors `SnapshotQueryService.toView`; clients treat run ids as opaque strings.
5. **Banner stuck-threshold is a client-side 15-min constant** — the backend exposes no "expected
   window" yet. Revisit if the window becomes configurable.
6. **Banner placed in `AppRoutes`, not `AdminShell`** — `/settings` is its own route that doesn't
   render the shell, so shell-only placement would miss "every admin page." The banner self-hides
   when logged out (login page stays clean).

## How to run / verify

```
# backend (local PG18 must be up)
cd apps/backend && node node_modules/vitest/vitest.mjs run          # 96 green
node node_modules/prisma/build/index.js migrate dev                 # apply migrations

# admin
cd apps/admin && node node_modules/vitest/vitest.mjs run            # 11 green
# demo: start backend + admin, log in (any admin role) → freshness banner across the top;
#   POST /api/snapshots/run as ops.head@fsm.test to create a run; force a FAILED row to see the red alert.
```

Note: `pnpm exec` triggers a network deps-check that FortiGate blocks; run the vitest/prisma/tsc
binaries directly via `node node_modules/...` as above.
