# RPT-03 — the freshness stamp exists, and the reports throw it away (E4, 2026-09-02)

Scanned four live report bodies as `ops.head@fsm.test` for any of
`computedAt · generatedAt · dataAsOf · asOf · updatedAt · lastComputed · snapshotAt · staleness`:

| endpoint | freshness field |
|---|---|
| `GET /reports/fleet-uptime` | **none** |
| `GET /reports/root-cause` | **none** |
| `GET /reports/efficiency` | **none** |
| `GET /reports/zm-scorecard` | **none** |
| `GET /exports/entity-mapping/summary` | `"dataAsOf": "2026-09-01T12:01:32.999Z"` |

The same app, the same guard chain, the same OH persona. Exports answers the question. Reports
does not. `exports.controller.ts:22` types it into the response contract itself
(`Promise<{ rowCount: number; dataAsOf: string | null }>`), and commissioning does the same with
`generatedAt` (`api/reports.ts:276,308`) — on the one report that is a live query and needs it least.

## Why this is sharper than "a missing field"

The stamp is not missing from the data. It is **discarded by the projection**:

```
apps/backend/prisma/schema.prisma:2682
  computedAt  DateTime @map("computed_at") @db.Timestamptz(6)   // NOT NULL
```

`device_downtime_summary_monthly` carries `computed_at` on every row, and so do
`RootCauseSummaryMonthly`, `SystemEfficiencySummaryDaily` and `ZmPerformanceSummaryMonthly`. The
aggregation worker writes it. The report SQL at `reports.service.ts:339,417,509,686` simply does not
select it. Surfacing it is a select-list plus a response field — no migration, no new writer.

## What the screen shows instead

`ReportsPage.tsx:73,240` renders "Data as of {asOf}" where `asOf = new Date()` at **fetch** time.
So the one place a manager looks for freshness reports the freshness of the *HTTP request*. It will
read `2026-09-02` over a cube whose newest row is from July. The global `SnapshotBanner.tsx:8-9`
does not save it either — it reports telemetry-ingest freshness, a different pipeline, and reads
green while a report cube is two months behind.

## Compounding with RPT-01

Alone, a missing stamp is a nuisance. Stacked on RPT-01 it is what makes the fabrication
undetectable: the number says 100, the page says "as of today", and nothing in the response
contradicts either. A `computedAt: null` on the fleet-uptime body would have exposed RPT-01 at a
glance, without a single new query.
