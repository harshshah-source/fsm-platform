# 193 — Zone drill-down enrichment on `/reports/device`

Status: done
Type: AFK · Backend (additive) + Admin FE

Filed and executed 2026-08-04 from an operator ask, after a read-first investigation and an approved
proposal. Two operator corrections were made to the proposal before build and are recorded below as
settled decisions — **do not reopen them.**

## The ask

Clicking a row in the Zone Performance Scorecard opened `/reports/device?zoneId=…&status=…`, which
showed only a device table. The page named no zone, carried no totals, and answered none of the
questions that drove the click — so an operator bounced back to the dashboard to interpret what they
were looking at. Wanted: a company → plant breakdown with KPI cards and charts above that table,
scoped by the URL's `zoneId` + `status`.

## What was found first (verified against source, not status lines)

- **The PRD does specify this content** — but as Zone Dashboard Home item 4 (PRD:364) and user story
  94, i.e. on the dashboard, where it is already built as `CompanyPlantTable.tsx`. So the work is
  reuse, not a new design. The v2 reference for this page (`22-device-detail.png`) specifies a scope
  chip band (`WEST ZONE · DATA AS OF … · ZONAL MANAGER`) that had never been built; that is now the
  section's header.
- **`company-plant-overview` had no `zoneId` filter** — `companyId`/`plantId` only, with the ZM clamp
  applied in-service.
- **Nothing served assignment or batch state for a zone.** `/api/tickets` has no zone filter and caps
  at 500 rows (`ticket-query.service.ts:298`); `/dispatch-runs/*` describes a past run, not current
  state; `/devices` carries assignment per row but offers no aggregate. This was the one genuine gap.
- Scale is small — 30 companies / 215 plants pan-India (`kpi-definitions.md:218`).

## Settled decisions

1. **Status semantics.** `INACTIVE` / `ACTIVE` / `ALL` scope the *bands*, not just the device table.
   The Operational Devices card and the composition bar always show the zone's whole operational
   fleet — they are the denominator the filtered figures sit inside, and are labelled as such.
2. **Zero rows are kept** (operator correction). A plant with zero inactive devices is a *result* —
   it is the one performing well. Hiding it leaves a user seeing 8 of 20 plants unable to tell the
   healthy 12 from 12 missing from the data. Zero rows sort last and are dimmed, never dropped.
   Hiding all-zero SLA *columns* under `ACTIVE` is a different call and is allowed: a column that
   cannot be non-zero by definition carries no information, unlike a row carrying a good result.
3. **`UNZONED` / no zone renders empty with an explanation** (operator correction) — never a
   fallback to "all zones in scope", which would produce correct-looking numbers for a question the
   user did not ask, with no way to notice. The device table is unaffected in that state.

## What landed

**Backend (additive, manager-roled, ZM-clamped in-service):**
- `company-plant-overview` gains `zoneId`, ANDed with the ZM clamp — a ZM asking for a foreign zone
  gets `[]`, never another zone's rows and never a silent substitution of their own.
- New `GET /api/dashboard/zone-operations?zoneId=&status=` → `{ openTickets, assigned, unassigned,
  liveBatches, overriddenBatches, engineersEngaged }`. Reuses the Device Detail list's own live-ticket
  status set and `removed_at IS NULL` batch link (both extracted to a named constant) so the aggregate
  and that table's per-row assignment column cannot disagree. `status` filters the ticket's DEVICE
  against the shared `FLEET_COUNT_COLUMNS` inactive predicate — not a second spelling of it.
- The global `ZoneScopeGuard` does not fire on a `zoneId` query param (it reads `:zoneId` route params
  and the `zone_id` spelling), so the clamp lives in the service, following `activityTrend`.

**Admin:**
- `ZoneDrilldownSection` — scope chips, 6 KPI cards, composition bar, ranked plants, SLA spread, and
  the reused `CompanyPlantTable`. Loads in parallel with the device list; neither gates the other.
- `CompanyPlantTable` gains `statusScope` (default `ALL` = unchanged dashboard behaviour).

**Design-system improvements made consistently, not per-page:**
- **The SLA ramp was re-stepped.** The old one failed colour-blindness where it mattered most:
  `EARLY_RISK` (#9acd32) and `RISK` (#eab308) were 0.01 apart in lightness — ΔE 2.7 under
  deuteranopia, i.e. the same colour — and `SEVERE`/`HIGH_CRITICAL` were ΔE 7.1 apart with *full*
  colour vision. Lightness also ran non-monotonically, so "darker" did not mean "worse" anywhere.
  The new ramp is monotone in OKLab L with ≥0.06 gaps, validated by script, and keeps the
  PRD:302-mandated green→red heat coding (semantic heat is the sanctioned multi-hue exception; every
  surface using it carries a legend). Dark-mode steps are **selected** against the dark surface, not
  flipped — the deep-red end previously vanished into the near-black canvas. Both live in `index.css`
  as `--sla-*`; `BUCKET_CLASS` and the charts now share them, so a bucket cannot be one colour in a
  table and another in a chart beside it.
- `MetricCard` leads with the number (28px, tabular) and demotes the label, plus an optional `share`
  proportion bar — a bare count gives a manager no reference point.
- `DistributionBar` gained the 2px inter-segment gap that stops two adjacent ramp steps reading as one.

## Defects found by rendering the page and looking at it

All four were invisible to the test suite and were fixed:
1. Two different plants rendered the identical truncated label in the ranked chart —
   `formatPlantDisplayName` puts the disambiguating code in a *suffix* (`ARASMETA CEMENT PLANT
   (ACP-9106)`), which is exactly what a truncating gutter eats. The chart now leads with the code.
   `BarList` also keyed on the label, so identical labels collided in React; it now takes an `id`.
2. Ranking *healthy* devices used alarm red — colour contradicting meaning. Now green under `ACTIVE`.
3. With the SLA columns dropped, the table's fixed colgroup under-filled and left a dead gutter; it
   now falls back to auto layout when the bucket columns are absent.
4. The zone scope chip used `text-brand-700`, which on the dark canvas is the same unreadable dark red
   the app had already fixed once elsewhere (INDEX 2026-07-28). Moved to `brand-600`.

## Verification

- Backend: new `dashboard-zone-drilldown.e2e-spec.ts` 11/11 (zone filter, ZM clamp additivity,
  non-numeric zoneId, status splits, overridden batches, ticket closure, SE 403). Dashboard specs +
  the #99 route sweep green — the new route 401s bare.
- Admin: new `zone-drilldown.test.tsx` 15/15; full suite **90 files / 401 tests, serial run green**.
  The zero-row assertions were proved to bite by reintroducing the rejected hide-rows behaviour.
- Rendered at 1024 / 1280 / 1440 in both themes: no horizontal overflow, no page errors.
- Both apps `tsc --noEmit` clean.

## Known, not fixed here

- **The admin suite is flaky under parallel load** — 3 of 5 full parallel runs failed, each time in a
  *different* file (`issue-122b-ui`, `shadow-use-queue`, `recovery-decision-queue`, `tickets-list`),
  every one passing in isolation and all 90 files green with `--no-file-parallelism`. Not introduced
  by this work; worth its own issue if it keeps costing runs.
- **`UNZONED` means two different things across surfaces** → filed as
  [#192](./192-unzoned-two-definitions.md). This issue routes around it rather than guessing.
- The Company/Plant Overview's 20-column header collides below ~1100px of content width. Pre-existing
  and identical on the dashboard (the colgroup is unchanged on that path); not touched here.
