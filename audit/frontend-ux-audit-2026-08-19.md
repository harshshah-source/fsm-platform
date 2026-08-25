# Frontend UX Audit — FSM Admin Console

**Where the FSM console shows more than it helps**

| | |
| --- | --- |
| **Scope** | `apps/admin/src` — 30,676 LOC, 47 pages |
| **Branch / commit** | `feat/autoplant-integration` @ `639aa72` |
| **Date** | 2026-08-19 |
| **Type** | Analysis only — no source file was modified |

Line counts, column counts, control counts and behavioural claims were read from `apps/admin/src`.
The two backend claims (`trendPctVsPrevDay`, the assignment endpoint) were verified against
`apps/backend/src`.

---

## Contents

1. [Executive summary](#1-executive-summary)
2. [Frontend inventory](#2-frontend-inventory)
3. [Page-by-page UX analysis](#3-page-by-page-ux-analysis)
4. [Table & nested-table audit](#4-table--nested-table-audit)
5. [Information that can be removed](#5-information-that-can-be-removed)
6. [Information that should be collapsed or moved](#6-information-that-should-be-collapsed-or-moved)
7. [Cards and KPI simplification](#7-cards-and-kpi-simplification)
8. [Filter simplification](#8-filter-simplification)
9. [Navigation & workflow friction](#9-navigation--workflow-friction)
10. [Progressive disclosure recommendations](#10-progressive-disclosure-recommendations)
11. [Consistency problems](#11-consistency-problems)
12. [Prioritized improvement backlog](#12-prioritized-improvement-backlog)
13. [If we simplify only 10 things](#13-if-we-simplify-only-10-things)
14. [Overall assessment](#14-overall-assessment)

---

## 1. Executive summary

The frontend is well-built and badly weighted. Its primitives are strong, its data contracts are
honest, and a real simplification pass has already happened at component level. What has not happened
is a pass at **page** level: pages accumulate every fact the backend can supply, in flat order, with
no ranking between "this needs you now" and "this is context."

### Overall condition

The design system is mature. `DataTable` carries loading / error / empty / retry / sort / export /
expand in one place. `TableToolbar` already folded filters *into* the table card, and `PageHeader` was
already stripped to screen-reader-only to stop every page opening with a redundant banner. `KpiInfo`
and `lib/kpiCatalog` give every number a definition, an exclusion list, a source table and a formula —
that is better metric governance than most products of this size have.

The problem is above that layer. The same well-made card and table components are used *additively*.
Nothing on a page says "this is the one thing that matters," so everything is rendered at the same
weight, and the operator does the ranking themselves, every time.

### The three biggest sources of complexity

#### 1. One number, told ten times — **P0**

"Inactive operational devices" is rendered on the Ops-Head dashboard as: a hero KPI card, a card in
the Operational Fleet strip, a column in the Zone Performance Scorecard, a column in the Company/Plant
overview company row, the same column again on the plant sub-row, a bar in the SLA Bucket Distribution
chart, and a series in the Fleet Activity Trend. Seven representations, one figure.
`OperationalFleetSection.tsx` says so in its own docstring — *"These figures are the column totals of
the Zone and Company tables below."* The code knows it is repeating itself.

Before an Ops Head reaches the first table row on their landing page they have passed **14 KPI
figures**, a trend chart, and a bar chart. None of them is a task.

#### 2. Three-level nested tables with three of every control — **P0**

`CompanyPlantTable.tsx` (1,053 lines) is a table inside a table inside a table: company (20 columns)
→ plants (17 columns) → open device tickets (11 columns). Each level owns an *independent* search box,
an independent download menu, and its own sort/filter selects — three searches, three exports, five
selects, all live at once inside one card. The leaf table then re-prints Zone, Company and Plant as
columns, which are precisely the three things the operator navigated *through* to get there.

#### 3. The primary action is missing from the primary surfaces — **P0**

The console's one persistent call-to-action is the top-bar **Assign SE** button. It runs
`navigate('/')` — it goes to the dashboard, where there is no assign control. The component that
*does* cluster-assign, `CriticalQueue.tsx` with its per-cluster SE picker, is not rendered by any
dashboard; `ZmDashboard` receives `critical`, `engineers` and `onAssigned` as props and destructures
none of them. The CSM's `EscalationQueueList` has no link, no row click and no action at all. The real
assignment UI lives behind a toggle button on `/reports/device`, a page named "Device Detail."

### Biggest opportunities for simplification

- Collapse the eight per-SLA-bucket columns into one severity cell everywhere they appear (they
  occupy 8 of 18 columns on Zone Overview and 8 of 20 on Company/Plant).
- Give the nested tables one shared toolbar instead of three, and drop ancestor columns from
  descendant tables.
- Replace the seven-card Operational Fleet strip with one composition bar plus two rates; the strip's
  own copy admits it is the totals row of the tables below it.
- Put assignment where assignment is decided — the ticket drawer and the critical queue — instead of
  on a report page.
- Sub-group the 18-item Operations nav; make the readiness queues, the dispatch surfaces and the SE
  surfaces read as three clusters, not eighteen peers.

### Showing, or helping act?

> **The application is optimized for showing information, decisively.** The evidence is structural,
> not stylistic: only 3 of 47 pages paginate; the drawer primitive (`Sheet`) is used nowhere outside
> the dev kitchen-sink page; the toast primitive is used in 3 files, so most mutations complete with
> no confirmation at all; and eight state-changing decisions — cross-zone approve, deny, defer,
> recovery reassign, recovery close, non-operational override — are collected through
> `window.prompt()`, one of which asks a zonal manager to type *an SE's raw user id* from memory.
>
> Everything the backend computes reaches the screen. Very little of the screen is arranged around a
> decision.

---

## 2. Frontend inventory

React 18 + TypeScript + Vite, React Router with a single authenticated shell route, Tailwind with a
token layer, no state library — every page owns its own `useState` + `useEffect` fetches. 47 page
components, 37 nav destinations for an Operations Head.

| Area | Pages / components | Main purpose | Complexity |
| --- | --- | --- | --- |
| **Shell** | `AppShell`, `Sidebar`, `TopBar`, `breadcrumb.ts`, `nav.ts` | Role-grouped collapsible rail, breadcrumb, global device search, acting-as-ZM control, theme toggle | High — 37 links, 6 groups |
| **Dashboards** | `ManagerDashboard` → `ZmDashboard` / `CentralDashboard` / `OpsHeadDashboard`, `WarehouseDashboard` | Role-variant landing: KPI hero, fleet strip, trend, SLA chart, 2 large tables | Very high |
| **Dashboard parts** | `DashboardHero`, `OperationalFleetSection`, `ActivityTrendSection`, `ActionRequiredPanel`, `ZoneOverviewTable`, `ScorecardTable`, `CompanyPlantTable`, `EscalationQueueList`, `CriticalQueue` *(orphaned)* | KPI cards, charts, three wide tables | Very high |
| **Tickets** | `TicketsPage` + nested-route `TicketDetailDrawer` | The operational queue; 11 columns, 8 controls, 6-tab side drawer | High |
| **Reports** | `ReportsPage`, `DeviceDetailPage`, `ZoneDrilldownSection`, `CommissioningCohortPage`, `RootCauseAnalyticsPage`, `SystemEfficiencyPage`, `FleetDirectoryPage`, `ZmScorecardPage`, `CsmApprovalSharePage` | Analytics + the de-facto device investigation surface | Very high |
| **Readiness queues** | `VehicleUnavailabilityPage`, `NonOperationalQueuePage`, `RecoveryDecisionQueuePage` | Manager decision queues, 2–3 row buttons each | Medium |
| **Dispatch** | `DispatchRunsPage`, `DispatchRunDetailPage`, `DispatchZoneDetailPage`, `DispatchBatchDetailPage`, `ZoneDispatchTable`, `DecisionTrace`, `ConfigInEffectPanel` | Auto-dispatch transparency, 4 levels deep | High |
| **Schedules** | `SchedulesPage`, `ScheduleDetailPage`, `SchedulerPreviewPage`, `IntradayQueuePage` | Day plans, pre-run projection, same-day changes | Medium–high |
| **Engineers** | `SeManagementPage`, `SeManagementDirectoryPage`, `PlannerPage`, `LeaveRequestsPage` | Activity, CRUD directory (9 inline-editable cols), visit planner, approvals | Medium–high |
| **Inventory / warehouse** | `ComponentRequestsPage` (dual-mode), `ComponentBlockedPage`, `ShadowUseQueuePage`, `RecoveryReceiptQueuePage` | Spare-part flow; WM acts, managers observe | Medium |
| **Admin / config** | `SettingsPage` (11 sections, grouped rail), `OpsExplorerPage`, `BulkUnassignPage`, `PlantZonesPage`, `PlantDeactivationsPage`, `TierOverridesPage`, `ExportsPage`, `BuildHealthPage`, `TerritoryPage` | Ops-Head configuration and investigation | Medium |
| **Primitives — data** | `DataTable`, `TableToolbar`, `FilterBar`, `MetricStrip`/`MetricCard`, `KpiInfo`, `feedback` (Skeleton/Empty/Error), `ExportMenu`, `EditableCell`, `Toast`, `DateRangeChips` | The canonical table + KPI + state vocabulary | Low — strong |
| **Primitives — overlay** | `Modal` (10 uses), `Sheet` *(0 real uses)*, `Tabs` *(0 real uses)*, `DropdownMenu`, `Select` | Overlays; two of five are dead | Low |
| **Primitives — domain** | `badges.tsx` (SLABadge, DurationBadge, StatusPill, TierBadge, AgeChip, EntityBadge), `InactiveCountLink`, `PlantName`, `Timeline`, `TicketCard` *(kitchen-sink only)* | Status vocabulary shared across queues | Low |
| **Charts** | `BarChartCard`, `TrendChart`, `SlaBucketBarChart`, `FleetActivityTrendChart`, `BarList`, `DonutChart`, `RadialGauge`, `DistributionBar`, `ChartCard`, `ReportGrid` | Report visuals | Low–medium |
| **Dead code** | `CriticalQueue`, `ZoneOperatingModeCard`, `ZoneOperatingModeTable` | Built, never mounted — `CriticalQueue` is the missing assign UI | — |

### Structural facts worth carrying into the rest of the report

- **Pagination:** 3 pages of 47 (`DeviceDetailPage`, `CommissioningCohortPage`, `OpsExplorerPage`).
  Every other table renders its full result set.
- **Responsive columns:** `DataTable` has no column-hiding mechanism. Only
  `pages/settings/primitives.tsx` implements `hideBelow`. The two hand-rolled nested tables sit in
  `overflow-hidden` containers, not `overflow-x-auto` — at 20 columns on a laptop they crush rather
  than scroll.
- **Detail views:** 32 `SectionCard` instances render detail *inline below* a table. One real drawer
  exists (the ticket drawer, at `w-96`).
- **Tabs:** three pages hand-roll `role="tab"` markup rather than using the `Tabs` primitive.

---

## 3. Page-by-page UX analysis

The pages where the density complaint actually originates, in order of how much operator time they
consume.

### Pan-India Fleet Command — **P0**

`/` · `OpsHeadDashboard.tsx` → `DashboardHero` + `OperationalFleetSection` + `ActivityTrendSection` +
`SlaBucketBarChart` + `ScorecardTable` + `CompanyPlantTable`

**Primary user goal.** *Monitor, then delegate.* An Ops Head opens this to answer: is anything worse
than yesterday, which zone owns it, and who do I call. Every one of those is a comparison, and the
page is built for enumeration.

**Current information hierarchy.** Truck hero with 5 KPI figures + a 2-up Companies/Plants composite →
Fleet Activity Trend chart → Operational Fleet strip (7 more figures) → SLA Bucket Distribution bar
chart → Zone Performance Scorecard (13 columns) → Company/Plant Overview (20 columns, 3 levels deep).
That is **14 KPI figures and 2 charts before the first actionable row**.

**What is working**

- `KpiInfo` on every card and counted column — the "what is in this number" problem is genuinely solved.
- Deliberate naming discipline: *"AutoPlant Catalog"* rather than "Total Devices," with its sync stamp
  inside the card. That is a real defect fix visible in the UI.
- `RollingNumber` re-rolls KPIs after a manual ingestion run — good feedback for a slow backend job.

**What is overloaded**

- **Two KPI families stacked.** The hero mixes a monthly report (Fleet Uptime), a band of a count
  (Critical Devices), another system's inventory (AutoPlant Catalog) and a directory composite. The
  strip below is seven same-family counts. The operator gets no signal about which strip to read first.
- **The Operational Fleet strip is a totals row rendered as cards.** Its own docstring says the figures
  are the column totals of the tables below. Seven cards to restate seven column sums.
- **Zone Performance Scorecard, 13 columns**, two of which cannot carry information:
  `% Successful Troubleshoot` renders the literal string `NA` for every row (no backend source), and
  Fleet Health % + Inactive % are complements — one is fully derivable from the other.
- **Two uptime meters per row** — Fleet Health % and Fleet Uptime both render the same `UptimeMeter`
  bar, so the row shows two visually identical progress bars measuring different things.

**Redundant information**

- Companies and Plants counts appear in the hero composite and again as a whole page
  (`/reports/fleet`) reached by clicking that composite.
- Inactive Operational: hero KPI + strip card + scorecard column + company row + plant row + chart +
  trend series.
- The SLA Bucket Distribution chart and the eight bucket columns in Company/Plant Overview are the
  same distribution, twice, ~1,500px apart.

**Interaction problems**

- Scorecard row click and the `Inactive > 24Hr` button inside it navigate to the *same* destination
  (`/reports/device?zoneId&status=INACTIVE`), so an inner control needs `stopPropagation` to do
  nothing different.
- No assignment affordance anywhere on the page, while the top bar's persistent **Assign SE** button
  navigates here.

**Recommended changes**

- Cut the hero to 3 figures: Fleet Uptime, Inactive Operational (with its share bar), Critical Devices.
  Move AutoPlant Catalog and the Companies/Plants composite into the Fleet Directory page they already
  link to.
- Replace the 7-card Operational Fleet strip with a single stacked composition bar (Healthy / Inactive
  / Never Reported / Warehouse) plus the two rates as text. Same four numbers, one object, one glance.
- Drop `% Successful Troubleshoot` until it has a source; drop `Inactive %` (keep Fleet Health %) —
  the pair is one number.
- Default Company/Plant Overview to collapsed and filtered to companies with non-zero Critical+; it
  currently opens with every company in scope.

---

### Zone Operations Dashboard — **P0**

`/` · `ZmDashboard.tsx`

**Primary user goal.** *Act.* The ZM is the role that assigns, escalates and overrides. This is the
only dashboard whose owner has a keyboard-and-decision job rather than an oversight job.

**What is overloaded / what is missing**

- It renders the same 6 hero KPIs + 7 fleet cards + trend + SLA chart + Zone Overview (18 cols) +
  Company/Plant (20 cols) as the oversight roles — but a ZM is scoped to *one zone*, so the Zone
  Overview table below is **a single row**, 18 columns wide, restating the KPI cards above it verbatim.
- `ActionRequiredPanel` is the closest thing to a task list, and it sits fourth on the page. It also
  renders *"coming soon"* stub cards for sources not yet wired — dead tiles occupying grid slots in
  the one panel meant to drive action.
- **No assign control.** `ZmDashboard` receives `critical`, `engineers` and `onAssigned` and uses none
  of them; `CriticalQueue`, which contains the per-cluster SE picker, is never mounted.
- `<DateRangeChips />` renders with no `value` and no `onChange` — eight buttons
  (1D 7D 14D 1M 3M 6M 12M YTD) plus a "BEST" label that change nothing on the page.

**Recommended changes**

- Promote Action Required to the top of the page and mount `CriticalQueue` beneath it. For a ZM the
  page should open on *work*, with fleet health as the context band below.
- Delete the Zone Overview table for the single-zone case; it is the KPI strip transposed.
- Remove the unwired `DateRangeChips`, or wire it. A control that visibly responds to clicks and
  changes nothing is worse than no control.
- Suppress "coming soon" cards rather than rendering them.

---

### Ticket Operations — **P1** (drawer assign action is **P0**)

`/tickets` · `TicketsPage.tsx` + `TicketDetailDrawer.tsx`

**Primary user goal.** *Triage and assign.* Find the tickets that are past SLA and unassigned, and put
an engineer on them.

**What is working.** This is the best-composed page in the app. The drawer is a nested route, so a
ticket is addressable; the open row is tinted, given `aria-current` and scrolled into view; the table
has a sticky header; the empty state distinguishes "no tickets" from "no tickets match these filters"
and offers Clear filters in both the header and the empty state.

**What is overloaded**

- **11 columns, of which 3 are identity restated.** Ticket already renders `#id` + `Device {deviceId}`;
  Company renders name over `#companyId`; Plant renders name over `#plantId`. The raw numeric ids under
  the names are for support, not for scanning.
- **8 filter controls in one toolbar** (search + work type + status + SLA bucket + assignment state +
  company + plant), where Status offers all 8 raw enum values — `CLOSED_AUTO_RECOVERY`,
  `FAILED_VERIFICATION`, `CLOSED_NON_OPERATIONAL` — as literal `SCREAMING_SNAKE` strings.
- **Four badge systems compete in one row:** TierBadge, StatusPill, DurationBadge, AgeChip, plus the
  Flags column's `InlineBadges` (HELD, 🔥 REPEAT, ESCALATED, WAITING COMPONENT · 12d · APPROVED, auto).
  A single row can legitimately render seven coloured chips.
- No pagination. The full zone result set renders.

**The drawer's real problem.** The drawer is `w-96` (384px) and carries **six tabs** — Overview,
Lifecycle, Forms, Verification, Components, Assignment History — which wrap onto two rows of pills at
that width. More importantly: **there is no Assign action in it.** The one write action available is
"Manually close Recovery Ticket," an exception path. An operator who opens a ticket to assign it must
close the drawer, navigate to Device Detail, toggle a panel open, pick a company, pick plants, pick an
SE.

**Recommended changes**

- Add **Assign SE** / **Reassign** as the drawer's primary button, reusing the existing
  `apiAssignTicket` path that `CriticalQueue` already calls.
- Merge Company + Plant into one column (plant name, company beneath); move raw ids into the drawer.
- Collapse Lifecycle + Assignment History into one "History" tab with a filter — Assignment History is
  already computed as a subset of the lifecycle array.
- Reduce the toolbar to search + Status + Assignment; move work type, SLA bucket, company and plant
  behind "More filters." Humanize the status labels.

---

### Device Detail — **P0**

`/reports/device` · `DeviceDetailPage.tsx` (638 lines) + `ZoneDrilldownSection.tsx` (466) +
`AssignSePanel.tsx` (245)

**Primary user goal.** *Investigate one device* — and, because of where the assign panel was put,
*assign engineers to plants*. Those are different jobs on one page.

**What is overloaded.** When the zone filter is set — which is how every scorecard and KPI
click-through arrives here — the page renders, *above* the device table: a 6-card KPI strip, an
"Operational fleet" chart card, an "Inactive devices by plant" ranked bar chart, an "SLA spread"
distribution bar, and **the entire three-level Company/Plant nested table**. Then the toolbar with 7
filter controls, then 11 columns × 100 rows.

The device detail itself — 6 stat tiles, an assignment card, a "Current failure cycle" definition
list, and a lifetime downtime chart — renders *below* that 100-row table. Selecting row 4 scrolls the
answer roughly 3,000px off-screen. The code has a `detailRef` scroll-into-view, which is a workaround
for the layout, not a fix.

**Redundant information**

- The `ZoneDrilldownSection` KPI strip restates the dashboard's Operational Fleet strip, scoped to one
  zone.
- The embedded Company/Plant table restates the dashboard's Company/Plant table, scoped to one zone.
- The device's `Assignment` column already shows badge + SE name + ticket link; the detail panel below
  shows badge + SE + batch + schedule + ticket link again.

**Recommended changes**

- **Move device detail into a right-hand drawer** next to the list, exactly as Tickets does. The
  `Sheet` primitive already exists and is unused. This is the single highest-value structural change
  on the page.
- Collapse `ZoneDrilldownSection` to a one-line summary band with a "Zone breakdown" disclosure; do not
  render four visualisations plus a nested table above the list the user came for.
- Move `AssignSePanel` to a proper modal launched from the Tickets page and the critical queue; it is a
  plant-and-engineer flow, not a device-report flow.
- Drop `Device Type` and `IMSI No` from the default columns (both ~85–93% populated at source, and both
  are lookup fields, not scan fields) — they cost 18% of the table width.

---

### Commissioning Cohort — **P1**

`/reports/commissioning` · `CommissioningCohortPage.tsx` (726 lines)

**Primary user goal.** *Compare* — which plants and which installers produce devices that never come
online.

**What is overloaded.** One page carries: a 3-select scope band, a 5-card KPI strip, 2 chart cards, a
"By plant" table (7 cols), a "By installer" table (5 cols), an "Install quality" table (5 cols), *and*
a paginated device table with its own search + 2 selects + an assign control. Four tables, seven filter
controls, two charts. The page answers a comparison question and then embeds an operational tool inside
it.

**Recommended changes**

- Tab the three breakdown tables (Plants / Installers / Quality) — they are three cuts of one dataset,
  never read together.
- Remove the embedded device table and assign control; link out to
  `/reports/device?commissionedWithinDays=`, which the page already supports as a drill-through.

---

### The decision queues — **P0**

`/cross-zone` · `/readiness/recovery-decisions` · `/readiness/non-operational`

**Primary user goal.** *Approve, deny, defer.* These are the purest decision surfaces in the product
and structurally the simplest — 2 to 6 columns, a handful of rows.

**What is broken, not merely dense**

- **Eight state-changing decisions are collected through `window.prompt()`.** Cross-Zone approve chains
  two prompts (*"Approve — target zone id:"* then *"Approve — assign to SE (user id):"*); deny and
  defer take reason and date the same way. Recovery Decisions asks *"Reassign to SE (user id):"*. A
  manager has no way to know an SE's user id, cannot see the roster while the prompt is open, gets no
  validation, and cannot cancel half-way without losing the first answer.
- **Every row shows all its actions as full buttons.** Cross-Zone renders Approve / Deny / Defer on
  every row; Recovery renders Reschedule / Close Failed / Escalate; Non-Operational renders Confirm /
  Override. Nothing is primary, so nothing reads as the expected action.
- **Silent success.** The toast system is imported by three files, none of them these. After approving
  a cross-zone escalation the row simply disappears on refetch.
- **A KPI card that is the row count.** Five queue pages render `<MetricCard value={rows.length} />`
  directly above the table whose rows they just counted.

**Recommended changes**

- Replace all `window.prompt` calls with the existing `Modal`, using a real SE picker (the roster
  endpoint is already called by `AssignSePanel` and `CriticalQueue`) and a real date input.
- One primary button per row + an overflow menu (`DropdownMenu` exists) for the rest.
- Toast on every mutation.
- Delete the row-count MetricCards; put the count in the table toolbar title, as Device Detail already
  does.

---

### Settings — *working well*

`/settings` · `SettingsPage.tsx` + `sections.tsx` (1,074 lines)

Worth naming as the model the rest of the app should follow. Eleven sections grouped into four named
categories (Organisation / Field operations / Rules & policy / Governance) with a one-sentence purpose
each; the open section lives in `?tab=` so it is linkable and survives reload; arrow-key roving focus
with proper tab/tabpanel semantics; below `lg` the rail becomes a single grouped `<select>` rather than
a wrapping pile of buttons. Loading renders as ghost rows so the panel does not change height.

This is exactly the treatment the 18-item Operations nav group and the Ticket drawer's six tabs need.
The pattern exists in the codebase already.

---

## 4. Table & nested-table audit

Column counts below include the automatic `S.No.` column that `DataTable` adds by default.

| Current table | Cols | Problem | Unnecessary information | Keep visible | Move / hide | Recommended interaction | Pri |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| **Company/Plant Overview** — company level<br>`CompanyPlantTable.tsx` | 20 | Eight per-SLA-bucket columns at 4% width each; a permanently empty `Plant` column showing "—" on every company row; a permanently empty `Uptime %` cell on every company row | The `Plant` column (always "—" here), `Warehouse` (explicitly outside every rate), `Inactive %` (complement of Health %), the empty uptime cell | Company, Tier, Plants count, Operational, Inactive, Health %, one severity cell | 8 bucket columns → one stacked severity bar with counts on hover; Warehouse → company detail | Row click expands plants (as today). Severity bar segment click deep-links to the filtered device list — the per-bucket links already exist and would be preserved | P0 |
| **→ Plants sub-table** *(level 2)* | 17 | Renders as a full bordered card *inside* a table cell, with its own header band, its own search box and its own download menu — a second complete table UI nested in the first | Its independent search (the parent search already filters plants); its independent download (the parent export already emits one flat row per plant) | Plant, Operational, Inactive, Health %, Uptime % | Warehouse, Inactive %, the 8 bucket columns | Keep the nesting, drop the sub-toolbar. One search and one export per table card, at the top level | P0 |
| **→→ Open device tickets** *(level 3)* | 11 | Third nesting level, with a *third* search box, a third download, a filter select, a sort select, and a 4-figure summary row — inside a cell of a table inside a cell of a table | `Zone`, `Company`, `Plant` columns: the user reached this panel by expanding a specific company and a specific plant, so all three are constants for every row | Device, Vehicle, Assignment (+SE), SLA, Status | Zone/Company/Plant → delete; Transporter → ticket drawer; Batch link → keep but demote to an icon | **Replace with a drawer.** A plant row click should open the plant's tickets in the side panel, not a third inline table. Or render as a compact list, not a table | P0 |
| **Zone Overview**<br>`ZoneOverviewTable.tsx` | 18 | 8 of 18 columns are SLA buckets; the `Trend` column is *structurally* always "—" (the backend returns `trendPctVsPrevDay: null` hard-coded); for a ZM the whole table is one row | Trend (no data source), Inactive % (complement of Health %), Warehouse | Zone, Operational, Inactive, Never Reported, Health % | 8 bucket columns → severity bar; Warehouse → hover | Row click → zone drill-down. Hide the table entirely when scope is a single zone | P0 |
| **Zone Performance Scorecard**<br>`ScorecardTable.tsx` | 13 | `% Successful Troubleshoot` renders the literal string `NA` for every row on every load; two visually identical `UptimeMeter` bars per row (Fleet Health %, Fleet Uptime); row click and the inner `Inactive > 24Hr` button go to the same URL | % Successful Troubleshoot, Inactive %, Warehouse Devices | Zone, ZM, Operational, Inactive Operational, Inactive > 24Hr, Assigned SEs, Fleet Uptime | Healthy Devices (= Operational − Inactive − Never Reported), Warehouse, Inactive % | Keep row click. Make one of the two meters a plain number so the bar means one thing | P1 |
| **Tickets**<br>`TicketsPage.tsx` | 12 | Company and Plant each render name + raw numeric id; four badge families plus a Flags column of up to five more chips; no pagination | Raw `#companyId` / `#plantId` under the names; the separate `Work Type` column (3 values — better as an icon on the ticket cell) | Ticket/Device, Plant (company beneath), Assignment, Status, Inactive, Age | Tier → merge into the company line; Flags → keep only blocking flags in-row, rest to drawer | Row click opens the drawer (as today) — but the drawer needs an Assign action | P1 |
| **Zone companies & plants**<br>`ZoneDispatchTable.tsx` | 8 | **A second, different nesting pattern for the same company→plant concept.** Here plant rows are interleaved into the parent table with a "—" in the Company column and an indent; in `CompanyPlantTable` plants open as a separate bordered card. Same domain, two mental models | The "—" placeholder cells in both directions (company rows show "—" for Plant, plant rows show "—" for Company) | Company/Plant (one merged hierarchy column), Inactive/Total, Assigned, Unassigned, Batches | — | Pick one nesting pattern and apply it to both tables | P1 |
| **SE Directory**<br>`SeManagementDirectoryPage.tsx` | 10 | Address rendered as a full table column; `Mapped Companies` renders `—` for every row unconditionally (hard-coded placeholder); every cell is click-to-edit, so there is no visual distinction between reading and editing mode | Mapped Companies (always "—"), Address, Email | Name, Phone, Zone, Coverage Type, Daily Capacity, Mapped Plants, Status | Address + Email → SE detail panel | Keep inline edit but mark editable cells; move contact detail to the existing side panel | P2 |
| **Fleet Directory**<br>`FleetDirectoryPage.tsx` | 13 | Mirrored / Operational / Warehouse / Inactive / Healthy / Inactive % on one row — six device counts that are three independent numbers plus three derivations | Mirrored (= Operational + Warehouse), Inactive % (complement) | Company, Tier, Plants, Operational, Inactive, Health %, Last Activity | Mirrored, Warehouse, Last Snapshot → hover | Tabs already exist here and work well; keep | P2 |

### On the nested tables specifically — **P0**

**Why does the nesting exist, and does it earn its cost?** It exists for a legitimate reason: company →
plant → device is the real domain hierarchy, and the table lets an operator hold the aggregate and the
detail in one view. The cost is that each level was given a *complete* table UI rather than a
subordinate one.

**Does the user need the child records immediately?** No. The parent already deep-links every bucket
count into a pre-filtered device list. The expansion exists for the case where the operator wants to
stay in context — and in that case they need *fewer* facts about the child, not the same 17 or 11 facts
the parent shows.

**Does expanding create excessive visual complexity?** Yes, and it compounds: with two companies
expanded and a plant open inside each, the page holds five `<table>` elements, five sticky-ish header
bands, five download menus and four search boxes, at three indentation depths, inside one card.

**Would a drawer be better?** For level 3, unambiguously. Open device tickets at a plant is a *list of
things you act on*, and every row already navigates away to `/tickets/:id`. Putting it in the side
drawer would let it keep full width for the columns that matter and remove one entire nesting level
from the page.

**Could the child be a count instead?** Level 2 largely could. The plant sub-table's job on the
dashboard is "which plant inside this company is the problem" — that is a ranked list of plant name +
inactive count + share, not a 17-column replica of the parent.

---

## 5. Information that can be removed

### Renders, but can never carry information

- **`% Successful Troubleshoot`** — Zone Performance Scorecard. Renders the literal string `NA` for
  every row. No backend source.
- **`Trend` column** — Zone Overview. The backend sets `trendPctVsPrevDay: null` unconditionally
  (`dashboard.service.ts:464`); the cell always renders "—".
- **`Mapped Companies`** — SE Directory. `render: () => <span>—</span>`, hard-coded.
- **"Coming soon" action cards** — `ActionRequiredPanel` renders unavailable sources as dimmed tiles
  reading *"coming soon"*, occupying slots in the grid meant to drive action.
- **`Plant` column on company rows** and **`Uptime %` on company rows** — Company/Plant Overview. Both
  structurally empty at that level.
- **`Company` column on plant rows** — Zone Dispatch table. Same, in mirror.

### Controls that do nothing

- **`<DateRangeChips />`** on the ZM and Central dashboards — mounted uncontrolled with no `onChange`.
  Eight period buttons and a "BEST" label; the internal state changes, the page does not.
- **Notification bell** in the top bar — `<button aria-label="Notifications">` with no `onClick` and no
  handler anywhere.
- **"Assign SE"** in the top bar — `onClick={() => navigate('/')}`. It is styled as the app's primary
  action and navigates to a page with no assign control.

### Duplicate figures

- **Inactive % everywhere it appears beside Fleet Health %.** Both divide by the same reporting
  denominator and sum to 100 by construction — stated as an invariant in `OperationalFleetSection`'s
  own docstring. It is duplicated in the fleet strip, Zone Overview, Scorecard, Company/Plant company
  rows, Company/Plant plant rows, Fleet Directory and the zone drill-down: **seven surfaces, one
  redundant column each.**
- **`Mirrored` devices** — Fleet Directory. Defined as Operational + Warehouse, both of which are
  adjacent columns.
- **`Healthy`** where Operational, Inactive and Never Reported are all present — the fourth number in a
  four-term identity.
- **Row-count KPI cards** — `<MetricCard value={rows.length} />` above the table it counts, on
  Non-Operational, Recovery Decisions, Shadow Use, Recovery Receipt and Voucher Review.

### Labels and identifiers that cost more than they give

- **Raw UUIDs as human identity.** Component Requests shows *"Requested by `{r.seId}`"*; Vehicle
  Unavailability shows `row.seId.slice(0, 8)`; the ticket drawer's Forms tab shows *"by `{f.seId}`"*.
  The SE roster with names is already fetched elsewhere in the app.
- **Raw enum strings in filter dropdowns** — Tickets offers `CLOSED_AUTO_RECOVERY`,
  `FAILED_VERIFICATION`, `CLOSED_NON_OPERATIONAL`, `FORMALLY_ASSIGNED` verbatim, while `StatusPill`
  already has a `humanize()` function two files away.
- **Written-but-invisible page subtitles.** `PageHeader` renders title and subtitle `sr-only`. Pages
  still pass 200-character explanatory subtitles that no sighted user will ever read — e.g. Reports'
  subtitle is a four-clause sentence about long-range summary-table reads. That copy is doing no work
  where it is.
- **`S.No.` on every table by default.** Justified on exports; on screen it is a column of ordinals
  nobody references, on tables that mostly do not paginate.

---

## 6. Information that should be collapsed or moved

| Current | Recommended | Why |
| --- | --- | --- |
| 8 SLA-bucket columns on Zone Overview, Company/Plant company rows and Company/Plant plant rows | One `DistributionBar` cell — segmented, severity-coloured, count on hover, segment click deep-links exactly as the columns do today | Removes 24 columns across three tables while preserving every existing drill-through. `DistributionBar` already exists in `components/charts` |
| 7-card Operational Fleet strip (Operational, Healthy, Inactive, Never Reported, Warehouse, Health %, Inactive %) | One composition bar for the four counts + Health % as a single figure; keep the "last snapshot" stamp | Its own docstring calls these the column totals of the tables below. A composition bar shows the split *and* the proportions in one object |
| `ZoneDrilldownSection` — 6 KPIs, 3 chart cards and the full nested Company/Plant table above the device list | A single summary band ("Zone 4 · 612 operational · 214 inactive · worst plant ACP-9106") with a "Zone breakdown" disclosure holding the rest | The user arrived here to look at devices. The breakdown is context, not the destination |
| Device Detail's per-device panels (6 stat tiles, assignment card, failure cycle, downtime chart) rendered below a 100-row table | A right-hand drawer beside the list — the pattern `TicketsPage` already ships | Eliminates the ~3,000px scroll between selecting a row and reading its answer, and removes the `scrollIntoView` workaround |
| Level-3 "Open device tickets" table nested two levels deep | Plant row click opens the tickets in the side drawer | Removes an entire nesting level and its third toolbar; gives the ticket columns full width |
| Ticket drawer's 6 tabs at 384px | Overview + History (Lifecycle ∪ Assignment) + Evidence (Forms ∪ Verification) + Components — 4 tabs; widen to ~480px | Assignment History is already derived as a filtered subset of Lifecycle. Forms and Verification are both "what the engineer did and whether it held" |
| Company + Plant as two columns with raw ids on Tickets | One column: plant name, company name beneath; ids in the drawer | Recovers a full column of width; the ids are support artefacts, not scan targets |
| Transporter, Batch, Zone columns in nested ticket tables | Ticket drawer | Investigation fields, not triage fields — none of them changes which ticket you pick up first |
| `AssignSePanel` toggled open inside Device Detail | A modal launched from Tickets and from the critical queue | Assignment is a ticket action. It currently lives on a report page, reachable only by knowing it is there |

---

## 7. Cards and KPI simplification

The test applied to each card: *what decision changes based on this number?* A number that only ever
produces "noted" is context, and context does not need a card.

### Keep as cards

- **Fleet Uptime** — the one figure that is a target with a threshold. Keep the inverted hero treatment.
- **Inactive Operational Devices** — the size of the work. Keep the `share` proportion bar; a bare count
  of 874 means nothing until you can see it is a third of the fleet.
- **Critical Devices** — the size of the *urgent* work, and the only card on the dashboard that maps to
  a queue.

### Demote to compact metrics (no card chrome)

- **Healthy Operational, Never Reported, Warehouse Devices** — parts of one composition; render as one
  segmented bar with inline labels.
- **Fleet Health %** — a single figure next to that bar.
- **Zones Covered** (Central dashboard) — a scope statement, not a metric.
- **Eligible Devices** (Reports) — a denominator; belongs as a footnote to Fleet Uptime, which is the
  number it qualifies.

### Remove

- **Inactive %** everywhere Fleet Health % is present.
- **Row-count MetricCards** on the five queue pages — move the count into the table toolbar title.
- **"Coming soon" Action Required cards.**
- **Total Inactive** and **Critical+** on Reports — both recomputed client-side from the same
  `zone-overview` payload the dashboard already showed the user minutes earlier.

### Should become drill-down entry points (and mostly already are)

- **Companies / Plants** — already click through to `/reports/fleet`. Move them off the dashboard
  entirely; they are directory navigation dressed as metrics.
- **AutoPlant Catalog** — a different system's inventory at a different moment. Correctly renamed and
  stamped, but it belongs on an integration-health surface, not beside FSM's operational counts, where
  its only effect is to invite subtraction.
- **Auto-Recovered / SE-Repaired** (Reports) — should link to the closures they count.

> **Net effect on the Ops-Head dashboard:** 14 KPI figures → 3 cards + 1 composition bar + 1 rate. The
> removed numbers are not lost — every one of them is a column total of a table on the same page, or a
> click away on a page built for it.

---

## 8. Filter simplification

Filters are already in the right *place* — `TableToolbar` put them inside the table card, which was a
correct earlier fix. The remaining problem is count and rank: seven equal-weight `FilterSelect`s at a
fixed `8.75rem` width wrap to two or three lines and read as an undifferentiated wall.

| Page | Controls | Essential — keep visible | Move behind "More filters" | Notes |
| --- | ---: | --- | --- | --- |
| **Tickets** | 8 | Search, Status, Assignment state | Work type, SLA bucket, Company, Plant | Humanize the Status options. SLA bucket largely duplicates the default SLA-descending sort |
| **Device Detail** | 8 | Search, Status, Zone | Sort, SLA bucket, Company, Plant | Company/Plant are usually pre-set by the deep-link that brought the user here |
| **Company/Plant Overview** | 7 across 3 levels | One search, one sort — at the top level only | Assignment state | The two child searches and the child assignment/sort selects should be deleted, not hidden. Three searches inside one card is the core density complaint |
| **Commissioning Cohort** | 7 | Window, Population | Install type, and the entire embedded device toolbar | The device table should leave the page |
| **SE Directory** | 5 | Search, Zone | Coverage type, Status | — |

### Recommended hierarchy, applied consistently

1. **Search** — always first, always widest.
2. **Two scope selects** maximum, chosen per page as the two an operator changes daily.
3. **"More filters"** disclosure for the rest, with a count badge when any are active.
4. **Active-filter chips** below the toolbar, each individually dismissible. Device Detail already does
   this for its commissioning-cohort scope, and the pattern is exactly right — it should be generalised
   rather than remaining a one-off.
5. **Sort** belongs on the column headers (`DataTable` already supports sortable columns), not as a
   select competing with the filters.

### Duplicate filtering mechanisms

- Company/Plant Overview's top-level search fires a *debounced network request* to
  `apiTicketsList({ q })` to resolve device/vehicle matches into plant ids, then filters client-side;
  the plant sub-table's search filters the same rows again on name/id; the ticket sub-table's search
  filters the loaded tickets a third time. Three search semantics, one card, no indication of which one
  is in force.
- Tickets and Device Detail both offer an SLA-bucket filter *and* an SLA-severity sort *and* a bucket
  column — three ways to express one concern.

---

## 9. Navigation & workflow friction

### Nav shape

`buildNav()` produces, for an Operations Head, **37 links across 6 groups**; a Zonal Manager sees 26.
The grouping is sound in principle — Operations / Components & Warehouse / Analytics / Policy / Admin /
Support — but one group carries 18 of the 37:

> Zone Dashboard · Tickets · Create Install · Schedules · Scheduler Preview · Dispatch Runs ·
> Intra-day Queue · SE Activity · Manage SEs · SE Planner · Verification Review · Readiness & Vehicle ·
> Non-Operational · Cross-Zone · Tier Overrides · Recovery Decisions · Leave Requests · Expense Vouchers

Read as a flat list, that is eighteen equally-weighted destinations with no relationship stated. Read
as clusters, it is four: **work** (Tickets, Create Install, Cross-Zone), **dispatch** (Schedules,
Scheduler Preview, Dispatch Runs, Intra-day), **people** (SE Activity, Manage SEs, SE Planner, Leave,
Vouchers), **readiness** (Vehicle, Non-Operational, Recovery Decisions, Verification, Component
Blocked). The clusters exist in the domain; the nav does not say so.

### Specific findings

- **Detail views promoted to destinations.** `Device Detail` is a top-level Analytics link, but it is a
  device *list* with an investigation panel, and it is also the target of ~8 deep-links from KPIs,
  scorecard rows and bucket counts. It is a drill-down that was given a menu entry.
- **Three readiness queues at top level.** Readiness & Vehicle / Non-Operational / Recovery Decisions
  are three peer links for one concern; each is typically a handful of rows.
- **Two ways to the same setting.** The SE Assignment Threshold has its own nav group ("Policy") *and* a
  section inside the Settings console — a deliberate role-access decision, correctly reasoned in the
  code, but it means an Ops Head sees the same control in two places.
- **Component Requests appears twice** for different roles at `/warehouse/requests` and
  `/component-requests`, rendering the same component with a `readOnly` prop. Correct behaviour;
  identical label.
- **Terminology drift:** "SE Activity" vs "Manage SEs" vs "SE Planner"; "Schedules" (what was
  dispatched) vs "Scheduler Preview" (what would be) vs "Dispatch Runs" (the run ledger) vs "Intra-day
  Queue" (changes to it). Four dispatch nouns; a new ZM cannot rank them.
- **No visible page title.** `PageHeader` is `sr-only`, so a page's identity rests entirely on the
  top-bar breadcrumb — which falls back to the literal label *"Console"* for any route not in the nav
  or the six hand-written detail patterns.

### Workflow traces

#### Trace A — "a Platinum customer's plant has gone dark; get someone there" — **P0**

1. Dashboard. Scroll past 14 KPIs, a trend chart and a bar chart to Company/Plant Overview.
2. Search the company. Expand it (a sub-table opens). Find the plant. Expand it (a third table opens).
3. Read the ticket rows. Click one → navigates away to `/tickets/:id`, losing both expansions.
4. The drawer has no assign action. Close it.
5. Navigate to `/reports/device`. Click "Assign SE" to toggle the panel. Pick a company, search plants,
   multi-select, pick an SE, assign.

**Five surfaces, two lost contexts, one toggle nobody would find unaided.** The single fix — an Assign
button in the ticket drawer — collapses this to two steps.

#### Trace B — "which zone is worst, and why" — **P1**

1. Scorecard row or its `Inactive > 24Hr` button (same destination) → Device Detail, zone-filtered.
2. Device Detail then re-renders the zone rollup as 6 KPIs + 3 charts + the entire nested Company/Plant
   table *above* the device list.
3. The device list is the thing that was clicked for, and it is below all of it.

The user is shown the dashboard again, scoped, on the way to the answer. The drill-down repeats the
summary instead of continuing from it.

#### Trace C — "approve this cross-zone escalation" — **P0**

1. Cross-Zone page. Row shows ticket, company, bucket, status, age, and three equally-weighted buttons.
2. Approve → `window.prompt("Approve — target zone id:")`. The zone *names* are not visible; the prompt
   wants an id.
3. Then `window.prompt("Approve — assign to SE (user id):")`. The SE roster is not on screen, and the
   field wants a user id.
4. Row vanishes on refetch. No confirmation.

This is not a density problem; it is an unusable interaction on a decision surface. A manager cannot
complete it correctly without a second window open.

---

## 10. Progressive disclosure recommendations

| Pattern | Stays visible | Deferred to |
| --- | --- | --- |
| **Row → drawer** — Device Detail | Device ID, Vehicle, Plant, Zone, Inactive Duration, SLA, Assignment | Device Type, IMSI, Trip Creation, lifetime stats, failure cycle, downtime chart, deal-type control |
| **Row → drawer** — Company/Plant level 3 | Plant row keeps a ticket count and an unassigned count | The whole ticket list opens in the side drawer instead of a third inline table |
| **Summary → details** — Zone drill-down on Device Detail | One band: zone, operational, inactive, worst plant | KPI strip, 3 charts and the nested table behind a "Zone breakdown" disclosure |
| **Metric → drill-down** — Dashboards | 3 KPI cards + 1 composition bar | Companies, Plants, AutoPlant Catalog and the per-state counts become links to the pages that own them |
| **Distribution → detail** — all three SLA-bucket column sets | One severity bar per row | Per-bucket counts on hover; segment click opens the filtered device list (preserving today's links) |
| **Basic → advanced filters** — Tickets, Device Detail, Cohort | Search + two scope selects + active-filter chips | Everything else behind "More filters" with an active count |
| **Primary → secondary actions** — all queue rows | One primary button | Remaining actions in a row overflow menu |
| **Badges → detail** — Tickets Flags column | Blocking flags only: WAITING COMPONENT, ESCALATED | HELD, REPEAT, auto → drawer Overview |
| **Tabs → grouped tabs** — Ticket drawer | Overview | History, Evidence, Components — 4 tabs instead of 6 |

---

## 11. Consistency problems

### Two nesting patterns for the same hierarchy — **P1**

`CompanyPlantTable` opens a company into a *separate bordered card* containing its own table.
`ZoneDispatchTable` opens a company into *indented rows spliced into the parent table*, with a "—"
placeholder in the Company column. Same domain concept, two different mental models, one product.

### Three ways to build a table — **P1**

The canonical `DataTable` (most pages) — which brings loading skeletons, error + retry, empty states,
sortable headers and export for free. Hand-rolled `<table>` markup (`CompanyPlantTable`,
`ZoneDispatchTable`, `LeaveRequestsPage`, `PlannerPage`, `VerificationReviewPage`) — which
re-implements some of those and skips others. And `settings/primitives.tsx`, which has its own table
with a responsive `hideBelow` mechanism the canonical one lacks.

The consequence is behavioural, not cosmetic: the hand-rolled tables have no retry on error, no column
sort, and no horizontal scroll container — their 20-column layouts sit in `overflow-hidden`.

### Two badge vocabularies — **P1**

`components/domain/badges.tsx` defines a semantic token system — `StatusPill` maps 30+ backend enums to
seven tones and humanizes the label. `pages/tickets/ticketBadges.tsx` then hand-writes raw Tailwind
palette classes for the same row: `bg-orange-100 text-orange-800`, `bg-red-100 text-red-800`,
`bg-amber-200 text-amber-900`. Those literals do not participate in the theme tokens, so they are the
badges most likely to break in dark mode, and they sit inches from tokened ones.

### Unused primitives, hand-rolled replacements — **P2**

- `Sheet` (drawer) — 0 uses outside `KitchenSink`. Every detail view is instead an inline `SectionCard`
  below the table (32 instances).
- `Tabs` — 0 uses outside `KitchenSink`. Three pages hand-roll `role="tab"` markup, each with slightly
  different styling.
- `Toast` — 3 files. Most mutations complete silently.
- `DropdownMenu` — 2 uses, while queue rows render 3 buttons each.

### Loading and empty states — **P2**

`DataTable` renders skeleton rows matched to the real row padding — a genuinely good detail. But the
ticket drawer renders four bespoke pulsing `div`s at `88% / 74% / 60% / 46%` width, its tabs render the
bare text `Loading…`, and `OpsExplorerPage`, `ScheduleDetailPage` and `SeManagementPage` each render
their own `Loading…` paragraph. Nine ad-hoc loading treatments where a shared one exists.

### Pagination — **P2**

Three pages paginate; two of them (`DeviceDetailPage`, `CommissioningCohortPage`) implement the
identical Prev / "Page n of m" / Next block inline, and `OpsExplorerPage` implements a third variant.
Every other table — including the unbounded Tickets list and the cross-zone Escalation Queue, which the
code itself notes "can run to thousands of rows" — renders everything.

### Row interaction — **P2**

A row click means four different things depending on the table: open a drawer (Tickets), select an
inline panel below (Device Detail), expand a nested table (Company/Plant), or navigate to another page
(Scorecard). None of them is signposted, and two of them (`DataTable`'s `onRowClick` vs
`renderExpanded`) are mutually exclusive by design in the same component.

---

## 12. Prioritized improvement backlog

| Pri | Page / component | Problem | Recommended change | Expected benefit |
| --- | --- | --- | --- | --- |
| **P0** | TicketDetailDrawer | No assign action on the surface where assignment is decided; the top-bar "Assign SE" navigates to a page with no assign control | Add Assign / Reassign as the drawer's primary button using the existing `apiAssignTicket`; point the top-bar button at `/tickets?assignmentState=UNASSIGNED` | Collapses the core workflow from 5 surfaces to 2 |
| **P0** | CrossZone, RecoveryDecision, NonOperational | 8 `window.prompt()` calls collect decisions, two of which demand raw user ids from memory | Replace with `Modal` + a real SE picker and date input; toast on success | Makes three decision queues completable without a second window |
| **P0** | CompanyPlantTable | Three nesting levels, three searches, three exports, five selects; 20/17/11 columns; ancestor columns repeated in descendants | One toolbar at the top level; delete Zone/Company/Plant from level 3; move level 3 into the drawer | Removes ~20 controls and one full nesting level from the densest surface in the app |
| **P0** | All three bucket-column tables | 8 SLA columns × 3 tables = 24 columns carrying one distribution | One `DistributionBar` cell; per-bucket counts on hover; segment click keeps today's deep-links | Zone Overview 18→10 cols, Company/Plant 20→12, plants 17→9 |
| **P0** | DeviceDetailPage | Detail renders below a 100-row table; the zone drill-down re-renders the whole dashboard above it | Move detail to a drawer; collapse the drill-down to a summary band with a disclosure | Removes a ~3,000px scroll from the most-used investigation path |
| **P0** | ZmDashboard | The role that acts gets an oversight layout; `CriticalQueue` (the assign UI) is never mounted; a single-row 18-column table restates the KPIs | Action Required + CriticalQueue to the top; delete Zone Overview in single-zone scope | Turns the ZM landing page into a work queue |
| **P1** | OpsHead / Central dashboards | 14 KPI figures before the first row; the fleet strip is the tables' totals row | 3 cards + 1 composition bar + 1 rate | Puts a table above the fold on the two oversight dashboards |
| **P1** | Dashboards, Scorecard, SE Directory, ActionRequired | Controls and columns that cannot carry information: unwired `DateRangeChips`, dead notification bell, `% Successful Troubleshoot`, `Trend`, `Mapped Companies`, "coming soon" cards | Remove or wire each | Stops the UI making promises the data cannot keep |
| **P1** | All queue tables | 2–3 equal-weight action buttons per row; no success feedback | One primary + `DropdownMenu` overflow; toast on every mutation | Makes the expected action obvious and confirms it happened |
| **P1** | Tickets, DeviceDetail, Cohort | 7–8 equal-weight filter controls wrapping to 2–3 rows | Search + 2 selects + "More filters" + dismissible active-filter chips | Recovers a band of vertical space and ranks the controls |
| **P1** | Sidebar / nav.ts | 18 flat links in one group (37 total for OH) | Sub-group Operations into Work / Dispatch / People / Readiness | Cuts scan cost on every navigation |
| **P1** | Inactive % / Mirrored / Healthy columns | Derived figures rendered beside the figures they derive from, on 7 surfaces | Keep one of each complementary pair | ~9 columns removed across the app |
| **P2** | ticketBadges.tsx | Raw Tailwind palette classes beside tokened badges; theme-fragile | Route through `Badge` tones | One badge vocabulary; dark mode holds |
| **P2** | DataTable | No responsive column strategy; hand-rolled tables have no scroll container | Add `hideBelow` (already implemented in `settings/primitives.tsx`); wrap hand-rolled tables in `overflow-x-auto` | 20-column tables become usable below 1440px |
| **P2** | Tickets, EscalationQueueList | Unbounded rendering on lists the code itself says can reach thousands of rows | Adopt the Device Detail pager as a shared component | Predictable page weight; one pagination pattern |
| **P2** | EscalationQueueList | The CSM's most urgent feed is completely inert — no link, no row click, no action | Row click → ticket drawer | Makes an existing panel reach its own data |
| **P2** | ComponentRequests, VehicleUnavailability, drawer Forms tab | Raw UUIDs shown as human identity | Resolve through the SE roster already fetched elsewhere | Rows become readable without a lookup |
| **P2** | ZoneDispatchTable vs CompanyPlantTable | Two nesting patterns for company→plant | Standardise on one | One mental model for the app's central hierarchy |
| **P3** | PageHeader | Long subtitles written and passed by every page, rendered `sr-only`; breadcrumb falls back to "Console" | Either surface a compact page title row or stop authoring the copy | Removes dead copy; fixes unnamed routes |
| **P3** | DataTable | `S.No.` on by default on mostly-unpaginated tables | Default off on screen, keep in exports | One column back everywhere |
| **P3** | CriticalQueue, ZoneOperatingMode* | Built, never mounted | Mount `CriticalQueue` (see P0 above); delete the rest | Inventory matches reality |

---

## 13. If we simplify only 10 things

### 01 — Put Assign SE in the ticket drawer

The drawer at `/tickets/:ticketId` has six tabs and one write action — "Manually close Recovery
Ticket," an exception path. Add **Assign SE** / **Reassign** as the drawer's primary button, calling
the same `apiAssignTicket` endpoint `CriticalQueue` already uses. Then repoint the top bar's "Assign
SE" button — currently `navigate('/')` — at `/tickets?assignmentState=UNASSIGNED`.

### 02 — Give Company/Plant Overview one toolbar instead of three

Delete the plant sub-table's search and download, and the ticket sub-table's search, filter, sort and
download. Keep one search, one sort and one export at the company level. Then delete the `Zone`,
`Company` and `Plant` columns from the level-3 ticket table — the operator expanded a specific company
and a specific plant to get there, so all three are constants for every row on screen.

### 03 — Replace 24 SLA-bucket columns with 3 severity bars

The eight per-bucket columns appear in Zone Overview, in Company/Plant company rows and in
Company/Plant plant rows. Render one segmented severity bar per row instead, with counts on hover and
the same per-bucket deep-links on segment click. Zone Overview goes 18→10 columns, Company/Plant
20→12, the plants sub-table 17→9 — and the distribution becomes readable at a glance rather than by
comparing eight narrow numeric cells.

### 04 — Move Device Detail's per-device panels into a drawer

Today the device stats, assignment card, failure cycle and downtime chart render *below* a 100-row
table — the page carries a `scrollIntoView` ref to cope with it. Use the `Sheet` primitive that already
ships and is used nowhere. Keep visible: Device ID, Vehicle, Plant, Zone, Inactive Duration, SLA
Bucket, Assignment. Move to the drawer: Device Type, IMSI No, Trip Creation Date Time, lifetime stats,
failure cycle, downtime trend, and the Ops-Head deal-type control.

### 05 — Replace all eight `window.prompt` decisions with real forms

Cross-Zone approve chains two prompts and asks for a target *zone id* and an SE *user id*; Recovery
Decisions asks for an SE user id; Non-Operational asks for an override reason. Use the existing
`Modal`, with the SE roster in a picker (`apiZoneEngineers` is already called elsewhere) and a real
date input for the defer flow. Add a toast on success — none of these queues currently confirms
anything.

### 06 — Cut the Ops-Head dashboard from 14 KPI figures to 5

Keep **Fleet Uptime**, **Inactive Operational** (with its share bar) and **Critical Devices** as cards.
Replace the seven-card Operational Fleet strip with one composition bar (Healthy / Inactive / Never
Reported / Warehouse) plus Fleet Health % as a figure. Move AutoPlant Catalog and the Companies/Plants
composite to the Fleet Directory page they already link to. A table then appears above the fold.

### 07 — Rebuild the ZM dashboard around work, not oversight

Promote `ActionRequiredPanel` to the top and mount `CriticalQueue` beneath it — the component with the
per-cluster SE picker that is currently built and never rendered. Delete the Zone Overview table when
scope is a single zone (it is one 18-column row restating the cards above it). Suppress the "coming
soon" stub cards, and either wire or remove the `DateRangeChips` control, which currently responds to
clicks and changes nothing.

### 08 — One primary action per queue row

Cross-Zone renders Approve / Deny / Defer; Recovery renders Reschedule / Close Failed / Escalate;
Non-Operational renders Confirm / Override; Component Requests renders Approve / Reject then Ship /
Cancel. Make the expected action a primary button and put the rest in a `DropdownMenu` — the primitive
exists and is used twice in the whole app.

### 09 — Rank the filter toolbars

Tickets and Device Detail each carry a search plus seven `FilterSelect`s at a fixed `8.75rem`, wrapping
to two or three rows. Keep search + two scope selects visible; put the rest behind a "More filters"
disclosure with an active count; show applied filters as dismissible chips — the pattern Device Detail
already implements for its commissioning-cohort scope, generalised. Move sort onto the column headers,
which `DataTable` already supports.

### 10 — Sub-group the Operations nav

Eighteen flat links in one group (37 total for an Ops Head). The clusters already exist in the domain:
**Work** (Tickets, Create Install, Cross-Zone), **Dispatch** (Schedules, Scheduler Preview, Dispatch
Runs, Intra-day Queue), **People** (SE Activity, Manage SEs, SE Planner, Leave Requests, Expense
Vouchers), **Readiness** (Vehicle, Non-Operational, Recovery Decisions, Verification, Component
Blocked). The Settings console already does exactly this — four named groups with a purpose line each —
and it is the best-organised surface in the product.

---

## 14. Overall assessment

If the goal is to make this application faster for an operations or admin user, the biggest structural
problems are not visual. They are three architectural habits, and they should be fixed in this order.

### 1. Aggregation is treated as a destination rather than a route to work

Every dashboard is composed as: all the totals, then all the breakdowns, then all the rows. Nothing on
those pages says *do this next*. The most telling artefact in the codebase is that `CriticalQueue` — a
component that groups CRITICAL+ tickets by plant cluster and offers a one-click SE assignment for the
whole cluster — was fully built and is mounted by nothing, while the props it needs are still being
passed into `ZmDashboard` and dropped. The work-shaped component exists; the page had no room for it
because the totals took the space.

### 2. Detail was built by addition, not by disclosure

When more information was needed, it was appended: another column, another card, another nesting level,
another sub-toolbar. The result is a three-level nested table with three searches and three exports, a
device page that renders its own zone's dashboard above the list, and a report page that carries four
tables. The `Sheet` drawer primitive — the natural answer to most of this — has been sitting unused
since it was written. Progressive disclosure is the single highest-leverage change available, and it
needs no new architecture.

### 3. The UI renders what the backend can produce, including nothing

A column whose backend value is hard-coded `null`. A column that renders the literal string `NA` on
every row. A period selector wired to nothing. A notification bell with no handler. A primary CTA that
navigates to a page without the action it names. "Coming soon" cards in the panel meant to drive
action. Individually each is small; collectively they teach an operator that parts of the interface are
decorative, and that is the most expensive thing a tool can teach the person using it.

> **What to change first.** Not the dashboards — the actions. Put Assign in the ticket drawer, replace
> the eight `window.prompt` decisions with real forms, and give every queue row one primary action with
> a confirmation. Those three changes make the product *completable* without touching a single query,
> route or table.
>
> Then take the density: one toolbar per table card, severity bars instead of eight bucket columns,
> detail in drawers instead of below 100-row lists. That is where the "too much on one screen" feeling
> actually lives, and none of it requires removing a number the business relies on — every figure
> proposed for removal is either a derivation of its neighbour, a column total of a table on the same
> page, or one click away on the page built to own it.
