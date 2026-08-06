# 217 — Operations Data Explorer: one read-only surface that traces any number back to its rows

Status: ready-for-agent — Slices 1–2 done (engine + 11 datasets + reconciliation); S3 (AutoPlant source-vs-FSM diff) open
Type: AFK · Backend + Admin
Filed: 2026-08-06
Origin: operator request — "a single source of truth for the FSM platform … for debugging,
reconciliation, audits, and operational analysis, not end-user reporting."
Coordinates with: [#176](./176-dashboard-kpi-transparency.md) (owns `FLEET_COUNT_COLUMNS` and
`kpiCatalog.ts` — this issue **consumes** them, it does not restate them) ·
[#160](./160-admin-table-chrome-ux.md) (owns `DataTable` + `TableDownloadButton`) ·
[#121](./121-entity-mapping-export.md) (the OH-only audited CSV export precedent this extends)

## Problem

Every number the platform shows is currently answerable only by someone with a `psql` prompt. The
dashboard says 3,476 inactive; a zone page says something else; a company row disagrees; the only way
to find out which is right is to hand-write the join. #176 fixed the *specific* defect (mixed
populations in one ratio) by centralising five count columns — but it fixed one family of numbers, not
the general problem, which is that **there is no surface where a figure can be walked back to the rows
that produced it.**

That costs three different people:

- **Operations Head** cannot reconcile a company total against a zone total against the KPI strip
  without exporting three pages and diffing them in Excel.
- **A developer debugging a live discrepancy** has no way to see which table, column, service and
  endpoint produced a rendered figure, or how long the query took.
- **An auditor** has no read-only, attributable view of the operational state at a point in time.

## Non-goals (explicit)

1. **This is not reporting.** The `reports/` module owns end-user analytics; this surface deliberately
   has no charts, no trends, no aggregation cubes, and is not linked from any operational workflow.
2. **This never writes.** No POST/PATCH/DELETE that mutates domain state, no editable cells, no
   `EditableCell` import. The only writes it performs are its own audit rows.
3. **This is not a SQL console.** Filters and sorts address registry-declared columns by key; no
   user-supplied SQL, identifier, or expression ever reaches the database.
4. **No new RBAC role.** See "Authorization" — the canonical five stay five.

## Authorization (operator ruling, 2026-08-06)

Gated on **`OPERATIONS_HEAD` AND the `OPS_EXPLORER_ENABLED` environment flag**, which defaults to
**off**. CONTEXT.md:28 is explicit — *"No separate 'Admin' persona exists"* — and Operations Head is
already the system configurator, so the operator ruled against introducing a sixth role for a
diagnostic tool.

When the flag is off: the nav entry is absent, the route renders nothing, and **every endpoint returns
404** (not 403 — a disabled feature should not confirm its own existence).

The role list is a single exported constant, `OPS_EXPLORER_ROLES`, referenced by every `@Roles(...)`
on the controller and by the FE route guard. Introducing a future `PLATFORM_DEVELOPER` role is then a
one-line append to that constant plus the shared `ROLES` tuple — no endpoint, guard, page, or test
changes shape. **That indirection is the deliverable**; do not inline `'OPERATIONS_HEAD'` on handlers.

### Developer Mode

A second, independent flag `OPS_EXPLORER_DEVELOPER_MODE` (defaulting to **on outside production, off
in production**) adds the lineage layer. Developer Mode is a *strict superset* of operational mode and
is **stripped server-side**, not hidden client-side — with the flag off the deep fields are absent
from the JSON, so the browser never receives them.

| Field | Operational mode | Developer Mode |
|---|---|---|
| Business definition, includes/excludes, source system + table | ✅ | ✅ |
| Source column, SQL expression, formula | — | ✅ |
| API endpoint, service/selector that supplies it | — | ✅ |
| Query execution time, row-count timing, raw JSON response | — | ✅ |
| Refresh trigger + last refresh timestamp | ✅ | ✅ |

## Acceptance criteria

**Access & safety**

- **AC-1** `OPS_EXPLORER_ENABLED` unset or false ⇒ every `/api/ops-explorer/*` route 404s for every
  role, including OH. Pinned by e2e.
- **AC-2** Flag on + non-OH role ⇒ 403. Flag on + OH ⇒ 200. Pinned by e2e.
- **AC-3** The role allow-list exists once, as `OPS_EXPLORER_ROLES`. A test asserts no handler in the
  module hard-codes a role string.
- **AC-4** The module exposes no mutating route. Pinned by a test that reflects over the controller's
  route table and fails on any non-GET/POST-query verb.
- **AC-5** Page access is audited (`OPS_EXPLORER_ACCESSED`) and every export is audited
  (`EXPORT_DOWNLOADED`, `entityType: 'OPS_EXPLORER_EXPORT'`, entityId = dataset key) with the actor,
  the dataset, and the applied filter set.

**The engine**

- **AC-6** A dataset registry declares, per column: key, label, type, filterability, sortability, and
  a `source` block (system · table · column · SQL expression · business definition · includes ·
  excludes · formula). Adding a dataset is a registry entry — no new controller, service, or route.
- **AC-7** Query support: global search (across the dataset's declared search columns), per-column
  filters with typed operators (`eq`/`neq`/`contains`/`startsWith`/`in`/`gt`/`gte`/`lt`/`lte`/
  `between`/`isNull`/`isNotNull`), multi-column sort, column selection, and offset pagination with a
  total row count.
- **AC-8** **Injection safety, pinned by test:** every identifier emitted into SQL is looked up in the
  registry by key and rejected if absent; every value is a bound parameter. A filter naming an unknown
  column is a 400, never a query.
- **AC-9** Export is **server-side and streamed** — it re-runs the query with the same filters, with
  no pagination and no dependence on what the DOM rendered, so a 20,000-row result exports whole.
  (`DataTable`'s DOM-read export from #160 stays as-is for every other table; it is the wrong
  mechanism here and is explicitly not reused.)

**Reconciliation**

- **AC-10** A reconciliation panel evaluates, over the whole database and not a fixture:
  1. `Σ company totals = Σ zone totals = dashboard KPI strip`
  2. `operationalDevices + warehouseDevices = mirroredDevices`
  3. `healthyOperational + inactiveOperational = operationalDevices`
  4. `Σ SLA bucket counts = inactiveOperational`
- **AC-11** Each identity reports PASS/FAIL, both sides' values, the **exact signed difference**, and
  a named likely source for the drift. It reuses `FLEET_COUNT_COLUMNS` (#176) rather than respelling
  the predicates — a second spelling is the defect class #176 closed.

**The surface**

- **AC-12** Route `/ops-explorer`, OH-only, absent from nav when the flag is off. Dataset picker,
  global search, filter builder, column picker, sortable server-paginated table, export button,
  drill-down links, and a per-column source popover.
- **AC-13** In Developer Mode the page adds a diagnostics panel: the SQL that ran (with bound
  parameters shown separately), the endpoint, server-side execution time, row count, and the raw JSON
  response — plus the reconciliation panel's per-identity SQL.
- **AC-14** Drill-down: a device row navigates to the existing device detail; plant/company/zone
  cells navigate to their existing pages. No new detail pages are built by this issue.

## Slices

| # | Scope | State |
|---|---|---|
| S1 | Config + access seam + guard; registry + query engine; `devices` dataset; reconciliation; controller + streamed export; admin page with Developer Mode | done |
| S2 | Datasets: `zones`, `companies`, `plants`, `vehicles` (FSM + AutoPlant master data), `engineers`, `tickets`, `batches`, `dispatchRuns`, `recommendations`, `auditLogs` (operational state, dispatch, audit trail) — 10 datasets in one slice, all registry entries over the S1 engine, no new routes/pages | done |
| S3 | AutoPlant-side read (source-vs-FSM row diff over the MySQL reader) — needs VPN, so it is the last slice and degrades cleanly when the source is unconfigured | not started |

**Not built, deliberately, and not missed:** `failure_cycles`, `se_coverage`/`engineer_territory_coverage`,
`snapshot_runs`/`master_sync_runs` as their own datasets. `failure_cycles` state is already visible
through `tickets` for every practical debugging question (a ticket's parent cycle mirrors its state);
splitting it out doubles a join for no new information until a concrete need names one. Coverage/
ingestion-ledger datasets are natural S3-adjacent additions once the AutoPlant slice's MySQL reader
seam exists to pair them against.

### S2 notes

- **Found and fixed a real S1 bug while extending it, rather than propagating it into nine new
  datasets.** `devices.plantName`'s drilldown route (`/reports/device?plantId=:value`) needs the
  plant's numeric id, but the column *displays* `plants.name` — so `:value` was being substituted with
  the plant's NAME, producing a broken link. `devices.deviceId`'s drilldown target didn't even read a
  `deviceId` query param (`DeviceDetailPage.tsx` only reads `zoneId`/`companyId`/`plantId`/`bucket`/
  `status`) — a link to nowhere useful. Fixed by adding `DatasetColumn.drilldown.valueSql`: an optional
  companion SQL expression, code-authored like everything else in the registry, projected as a hidden
  `__dd_<key>` field alongside the visible column. The FE's `renderCell` builds the link href from
  `row['__dd_'+key] ?? row[key]` — falls back to the displayed value when no companion was declared
  (the common case, e.g. a ticket's UUID is both what's shown and what's linked). `deviceId`'s
  drilldown was removed outright rather than shipped broken — no single-device deep link exists
  anywhere in the admin app today. `zoneName`/`companyName` on `devices` gained real drilldowns as a
  result of building the fix (they had none before). `serializeDataset` strips `valueSql` in **both**
  modes, not just operational — it's a raw SQL fragment like every other, not a Developer Mode
  documentation field. Pinned by 5 new unit tests (query-builder projection) + 1 admin test
  (`__dd_` row field wins over the displayed value) + a tightened e2e assertion (per-dataset, per-
  column scan for a leaked `valueSql`, not a substring guess) — the old e2e check
  (`not.toContain('LEFT JOIN')`) was itself wrong: legitimate operational-mode prose describes join
  semantics in English ("the LEFT JOIN leaves this blank…") and tripped a same-named substring.
- **Reconciliation gained a 6th identity, `dispatchBatchLedger`**, when the `batches`/`dispatchRuns`
  datasets landed: `Σ dispatch_runs.batches = COUNT(plant_batch_assignments WHERE run_id IS NOT NULL)`.
  Deliberately NOT a ticket-count identity — `batch_assignment_tickets.removed_at` is set by legitimate
  ZM overrides, which would make a ticket-level identity chronically FAIL for reasons that are correct
  business behaviour, training operators to ignore the panel. Batch *rows* are never deleted (only
  re-statused AUTO_ASSIGNED→OVERRIDDEN/COMPLETED/PARTIAL), so the run ledger's own `batches` counter
  against surviving rows is a genuinely stable structural invariant. Verified executing cleanly against
  the live schema (a probe spec, run then discarded, hit `/reconciliation` and every dataset's
  query+export path end to end) — not asserted "always PASS" in the e2e suite the way the three device-
  population partitions are, because `dispatch_runs` rows are seeded directly (uncoupled from real
  batch rows) by many other unrelated fixture specs sharing the same long-lived test database (#156).
- Every new dataset's drilldown targets an **existing** route — `/schedules/:engineerId`,
  `/tickets/:ticketId`, `/batches/:batchId`, `/dispatch-runs/:runId`, plus `/reports/device`'s
  zoneId/companyId/plantId query params — confirmed by reading each target page's actual param
  contract, not assumed from its name. `auditLogs` gets **no** drilldown: `entityType` varies row to
  row with no single safe target, and a wrong link is worse than an absent one in a tool whose premise
  is "click through to the real rows".
- Verified: backend unit 44 (was 36) + e2e 16 green, dashboard-kpi-reconciliation regression 14 green,
  admin 94 files / 441 tests green, both apps `tsc --noEmit` clean. A one-off probe spec (written, run,
  then deleted — not part of the deliverable) exercised query+export end to end for all 11 datasets
  against the live test schema to catch any JOIN/column typo the pure unit tests couldn't see.

## Notes / traps

- **The `UNZONED` word means two different populations across surfaces** (#192). Any dataset exposing
  a zone column must state which one it means in the column's `definition`, not assume.
- **`is_departed` is the trap #176 hit.** Every count column in this tool must name its departed-device
  treatment in `excludes`, because "total" is ambiguous and was wrong in production for a month.
- The local backend suite is not a reliable green/red signal (#156, orphan fixtures). Slice 1's
  primary evidence is unit tests over the pure query builder / registry / config, which need no DB.
