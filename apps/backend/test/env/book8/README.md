# Book8 Isolated Test Environment

A **development/testing-only** harness that drives the real FSM backend pipeline end-to-end using
`data/Book8_fixed.csv` as the telemetry source — **without changing production architecture**.

> Production keeps `AutoPlant DB → AutoPlantReader → SOURCE_READER → SnapshotIngestionWorker → …`.
> This harness swaps **only** the reader bound to `SOURCE_READER`, in test code, for a CSV-backed one.
> Everything below the seam is the unmodified production code.

```
data/Book8_fixed.csv
      │
      ▼  (test-only)
Book8SourceReader  ──implements──►  SourceReader (production interface, unchanged)
      │
      ▼
SnapshotIngestionWorker → raw_device_snapshots → DeviceStateService → TicketCreationService → …
      (all production classes, composed manually exactly like test/snapshot-worker.e2e-spec.ts)
```

## Files

| File | Purpose | Touches DB? |
|---|---|---|
| `book8-dataset.ts` | Pure parse + classify + derive master graph + synthesize PGI. Deterministic. | No |
| `book8-source-reader.ts` | Test-only `SourceReader` implementation over Book8 telemetry. | No |
| `book8-seeder.ts` | Idempotent master-data writer (zones→companies→plants→vehicles→devices→PGI + org reference). | Yes |
| `book8-env.e2e-spec.ts` | Opt-in driver: seed → ingest → recompute → ticket-create → integrity asserts → report. | Yes |
| `book8-dataset.spec.ts` | Fast, DB-free parser regression test (self-skips if the CSV is absent). | No |

## How to run

```bash
cd apps/backend
# fast parser test (always safe):
node node_modules/vitest/vitest.mjs run test/env/book8/book8-dataset.spec.ts

# full environment build + validation (opt-in; processes the whole 34k-row dataset):
BOOK8_RUN=1 node node_modules/vitest/vitest.mjs run test/env/book8/book8-env.e2e-spec.ts \
  --testTimeout=1800000 --hookTimeout=1800000
```

### Selecting a dataset (Book4–Book8)

The harness defaults to `data/Book8_fixed.csv`. Set `BOOK_DATASET` (a repo-root-relative path, or an
absolute path) to point the SAME harness at any other daily snapshot — no code change. The injected
clock auto-derives from the chosen file's latest ping, so SLA buckets spread correctly for each day:

```bash
cd apps/backend
BOOK_DATASET=data/Book4_fixed.csv BOOK8_RUN=1 node node_modules/vitest/vitest.mjs run test/env/book8/book8-env.e2e-spec.ts --testTimeout=1800000 --hookTimeout=1800000
BOOK_DATASET=data/Book5_fixed.csv BOOK8_RUN=1 node node_modules/vitest/vitest.mjs run test/env/book8/book8-env.e2e-spec.ts --testTimeout=1800000 --hookTimeout=1800000
BOOK_DATASET=data/Book6_fixed.csv BOOK8_RUN=1 node node_modules/vitest/vitest.mjs run test/env/book8/book8-env.e2e-spec.ts --testTimeout=1800000 --hookTimeout=1800000
BOOK_DATASET=data/Book7_fixed.csv BOOK8_RUN=1 node node_modules/vitest/vitest.mjs run test/env/book8/book8-env.e2e-spec.ts --testTimeout=1800000 --hookTimeout=1800000
BOOK_DATASET=data/Book8_fixed.csv BOOK8_RUN=1 node node_modules/vitest/vitest.mjs run test/env/book8/book8-env.e2e-spec.ts --testTimeout=1800000 --hookTimeout=1800000   # == default
```

> The names `book8-*` are kept for continuity; the harness is dataset-agnostic. To test each book
> **independently**, reset the DB between runs (`npx prisma migrate reset --force`) — the seeders are
> additive (natural-key upserts), so without a reset successive books accumulate into one world.

The driver prints a run report (rows imported, master records created, devices mapped/skipped with
reasons, SLA-bucket spread, tickets generated and not-generated with reasons, blocked workflows).

## Determinism

Every synthetic value is a pure function of the CSV contents + a clock derived from the chosen
dataset (`datasetNow` = one minute after that file's latest ping; for Book8 that is
`2026-04-26T07:30:00Z`), so SLA buckets spread realistically instead of all reading LONG_PENDING. No
`Math.random()`, no `Date.now()`. Re-running converges to the same world (natural-key upserts +
`skipDuplicates`; synthetic PGI is delete-then-recreate scoped to `orderRef='BOOK8-PGI'`).

### Deterministic rules

- **device identity** — the real 15-digit `device_id` is used. Rows whose id is scientific-notation
  collapsed (~3,148) or duplicated (~9) are **skipped and reported**, never minted/guessed.
- **zone** (not in CSV) — `ZONE_NAMES[plant_code % 4]` → EAST/NORTH/SOUTH/WEST. Synthetic partition
  to exercise zone-scoping and cross-zone workflows.
- **company tier/rank** (not in CSV) — sorted CSV company ids → cycling PLATINUM/GOLD/SILVER with
  distinct ranks A.. (satisfies `Company @@unique([tier, rank])`).
- **deal_type** — even device_id → RECURRING, odd → ONE_TIME (exercises Recovery eligibility).
- **PGI eligibility** — `device_id % 10 != 0` gets a recent PGI (eligible); the remaining 10% are
  left without PGI to exercise the ineligible → no-ticket negative path.

## Isolation notes

- This harness binds the CSV reader **only in test code**; the production module graph still binds
  `InMemorySourceReader([])` today and `AutoPlantReader` later. No `if (test)` branches in production.
- It seeds into the dev database (`DATABASE_URL`). It **deletes no existing seed data**; its rows use
  distinct natural keys (`BOOK8 Co …` companies, `… [code]` plant names, real device ids).
- For **full isolation** from the automated suite, point `DATABASE_URL` at a dedicated database and
  apply existing migrations there first (`prisma migrate deploy`) — no new migrations needed. The
  driver itself is gated behind `BOOK8_RUN=1` so it never runs as part of the normal suite.
