# 04 — Snapshot ingestion + data-as-of banner

Status: done
Type: AFK

> **DONE** 2026-06-19 — all buildable ACs green (AC#7 design-level; real AutoPlant source deferred
> behind the `SOURCE_READER` seam, HITL/external-access). Progress:
> `docs/progress/04-snapshot-ingestion-data-as-of.md`.

## What to build

The `SnapshotIngestionWorker` that pulls GPS telemetry from the AutoPlant DB (read-only source) via cursor-based, chunked reads into `raw_device_snapshots`, tracking each run in `snapshot_runs` (+ `snapshot_run_chunks`). Source GPS timestamps normalized to UTC at ingestion; raw telemetry preserved. Duplicate handling so a re-run never double-counts. The Snapshot freshness banner runs across the top of every admin page showing the last successful Snapshot timestamp; a `FAILED` or stuck (`RUNNING` past expected window) Snapshot renders a red alert.

End-to-end: a snapshot run ingests source rows, completes, and the admin shell shows the data-as-of timestamp; a simulated failure shows the red alert.

## Acceptance criteria

- [x] Worker pulls AutoPlant DB rows cursor-based and chunked into `raw_device_snapshots`
- [x] `snapshot_runs` lifecycle recorded (RUNNING → SUCCESS / FAILED) with run timestamp
- [x] Source timestamps normalized to UTC; raw telemetry fields preserved verbatim
- [x] Duplicate snapshot rows handled idempotently
- [x] Data-as-of banner shows last successful Snapshot timestamp on every page
- [x] FAILED or stuck Snapshot renders a red alert banner
- [~] Snapshot completes within the <10-min target on representative volume — *design-level; real AutoPlant source deferred behind `SOURCE_READER` (HITL), not benchmarked*

## Blocked by

- #01
