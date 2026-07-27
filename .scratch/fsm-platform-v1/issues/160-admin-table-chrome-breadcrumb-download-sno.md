# 160 — Admin table & chrome UX pass: breadcrumb, per-table download, S.No. column

Status: ready-for-agent
Type: AFK

> Filed 2026-07-27 from an operator ask (three admin-FE presentation edits), after a read-only
> investigation session that produced the evidence base, the design resolutions and the slice plan
> below. **The four design questions this issue opened were answered by the operator on 2026-07-27
> and are recorded as SETTLED in `## Settled decisions`. Do not reopen them.**
>
> **Admin front-end only. No backend read, write, endpoint or query-parameter change.**
> If any slice appears to need one, STOP and escalate (Strategic HITL) before writing the line.

## What to build

Three presentation-layer changes to the admin dashboard, sharing one `DataTable` pass.

**1 — Breadcrumb topbar.** Replace the static "FSM Command Console" eyebrow + resolved page title
(`apps/admin/src/components/shell/TopBar.tsx:80-88`, `PAGE_TITLES` `:12-33`, `titleFor` `:35-39`)
with a real breadcrumb reflecting the current page and its parent path:

```
Dashboard        ->  Dashboard
Device Detail    ->  Dashboard > Device Detail
Ticket drawer    ->  Dashboard > Tickets > Ticket #<id>
```

Source of truth is the existing role-scoped nav config (`components/shell/nav.ts:40` `buildNav`)
plus a six-entry detail-route table that **replaces** `PAGE_TITLES` — no new parallel truth.
Crumb[0] is always the literal `Dashboard` -> `/`. Intermediate crumbs are links; the last carries
`aria-current="page"`.

**2 — Per-table download.** Every in-scope table gets **ONE** download button in a new toolbar area
inside its card — **table-level** export of all visible rows and all columns, in the four #122
formats (CSV / Excel / PDF / PNG) via the existing `lib/exportFile.ts:250 exportTable`.
Explicitly **NOT** row-level, **NOT** column-level, **NO** row-selection checkboxes, **NO**
multi-select flows. Sub-tables get their own button exporting **only themselves**; a parent
**never** exports the hierarchy.

**3 — S.No. column.** Every in-scope table gets `S.No.` as the leftmost column, numbering the
current visible/filtered/sorted view from 1 (offset-aware on the one paginated table).

### Scope (settled — decision 2 below)

**In:** all 38 `DataTable` render sites (enumerated in `## Evidence: DataTable audit`) **plus** the
two bespoke drill-downs — `pages/dashboard/CompanyPlantTable.tsx` L1 `:319` / L2 `:449` / L3 `:659`,
and `pages/dispatch/ZoneDispatchTable.tsx` L1 `:201` / L2 `:308`.

**Out, explicitly:** the six Settings config tables (`pages/settings/sections.tsx:102, :210, :260,
:403, :460, :508, :661`), the SE Planner grid (`pages/planner/PlannerPage.tsx:184`),
`pages/verification/VerificationReviewPage.tsx:179`, `pages/engineers/LeaveRequestsPage.tsx:64`,
`components/dashboard/ZoneOperatingModeTable.tsx:75` — config forms and grids, where a serial
number and a table export are meaningless.

**Out, explicitly:** migrating any bespoke table onto `DataTable`. They carry `table-fixed`
layouts, custom multi-cell SLA-bucket headers (`CompanyPlantTable.tsx:84-144`) and per-level
filter/sort state; that refactor is a real regression risk and belongs in its own issue. For the
five bespoke levels, add the toolbar and the leading column **inline, in place**.

## Settled decisions (operator, 2026-07-27 — do NOT reopen)

1. **"FSM Command Console" is retired entirely.** The sidebar wordmark
   (`components/shell/Sidebar.tsx:85`) carries branding; a second product name in the topbar is
   clutter. The string is not relocated anywhere. The tab title stays `FSM Admin`
   (`apps/admin/index.html:9`) — a different string, untouched. The reference deviation is recorded
   per **AC-8**.
2. **Scope is DataTable + the two bespoke drill-downs** (option ii). Option (i) would miss the
   operator's own Edit-2 example (Company > Plant > Device lives outside `DataTable`); option (iii)
   would put a serial number on config forms and the planner grid. Exclusion list as above.
3. **A new single-button component with a Radix dropdown**, not the two-control `ExportMenu`.
   "One download button per table" literally; `@radix-ui/react-dropdown-menu` is already a
   dependency in `apps/admin/package.json`.
4. **`downloadable={false}` on `pages/install/InstallCreatePage.tsx:286`** (CSV *validation errors*,
   not operational data) **and `pages/KitchenSink.tsx:125`** (dev-only route, `AppRoutes.tsx:59`).
   Every other in-scope table gets the button.

Also settled and approved as designed: the DOM-read export mechanism (**deliberately a DOM read —
it must not be "improved" into a data-model read**; see AC-11/AC-16 and Trap 8), re-number-not-pin
S.No. semantics, `snoOffset` for `DeviceDetailPage`, and the fixed-width re-proportioning for
`DispatchBatchDetailPage` + `DeviceDetailPage`.

## Acceptance criteria

**Breadcrumb**

- [ ] AC-1  `/` renders a single terminal crumb `Dashboard`.
- [ ] AC-2  `/reports/device` renders `Dashboard > Device Detail`; `Dashboard` is a link to `/`.
- [ ] AC-3  `/tickets/T-1` renders `Dashboard > Tickets > Ticket #T-1`; `Tickets` links to
            `/tickets` and clicking it closes the drawer.
- [ ] AC-4  Crumb labels come from `buildNav(session.role)`; every intermediate crumb links to a
            route that role can reach. A WM and an OH on the same path get role-correct crumbs.
- [ ] AC-5  All ~12 routes that render the literal `Console` today (`/dispatch-runs`,
            `/batches/:id`, `/reports/device`, `/reports/fleet`, `/install`, `/cross-zone`,
            `/vouchers`, `/plant-zones`, `/tier-overrides`, `/build-health`, `/exports`,
            `/engineers/manage`) render a real crumb chain.
- [ ] AC-6  An unmatched in-shell path falls back to `Dashboard > Console`.
- [ ] AC-7  `PAGE_TITLES` and `titleFor` are DELETED (not left dead), and the string
            "FSM Command Console" appears nowhere in `apps/admin/src`.
- [ ] AC-8  `.scratch/fsm-platform-v1/DESIGN-SYSTEM.md:144`, `docs/ui-redevelopment/04-layout.md:43`
            and `docs/ui-redevelopment/retheme-2026-07-15-parity-checklist.md:18` are updated to
            describe the breadcrumb, recording the reference deviation.

**Download**

- [ ] AC-9   Every in-scope table renders exactly ONE download control, labelled
             `Download <ariaLabel>` for accessibility and test disambiguation.
- [ ] AC-10  It offers CSV / Excel / PDF / Image(PNG) and routes through
             `lib/exportFile.ts:250 exportTable`.
- [ ] AC-11  The exported body equals the table's ON-SCREEN view — post-filter **and post-sort**,
             including the S.No. column. Test: apply a column sort, export, assert order.
- [ ] AC-12  Disabled while `loading`, on `error`, and when there are zero rows.
- [ ] AC-13  Each of the five bespoke drill-down levels exports only its own level; no control
             anywhere exports a hierarchy.
- [ ] AC-14  No row-level download, no column-level export and no selection checkbox is introduced.
- [ ] AC-15  Page-level `ExportMenu` instances made redundant by AC-9 are REMOVED
             (`TicketsPage:241`, `DispatchBatchDetailPage:185`, `DeviceDetailPage:417`,
             `FleetDirectoryPage:221`, `ZoneOverviewTable:41`). `VoucherReviewPage:111` and
             `api/exports.ts` are untouched — they export server-generated payloads.
- [ ] AC-16  **Zone-scoping.** No export path issues a network request. Every exported row is read
             from the mounted DOM, so a ZM cannot receive an out-of-zone row via any table or
             sub-table download. Asserted by a test that fails on any `fetch` during export.

**S.No.**

- [ ] AC-17  `S.No.` is the leftmost header of every in-scope table; not sortable.
- [ ] AC-18  Numbering follows the visible view — it RE-NUMBERS 1..n after a filter or sort change
             (it does **not** pin to the underlying row).
- [ ] AC-19  `DeviceDetailPage` "Device list" page 2 numbers 101..200, matching its
             "Showing 101–200 of N" caption (`:415`).
- [ ] AC-20  Sub-tables number independently from 1.
- [ ] AC-21  `tableLayout="fixed"` tables still fit without horizontal scroll:
             `DispatchBatchDetailPage` (widths `:54`) and `DeviceDetailPage` (widths `:203`) have
             their colgroups re-proportioned for the 3.5rem S.No. column.
- [ ] AC-22  Loading skeleton, empty state, error state and the `renderExpanded` panel all still
             span the full table width (`totalCols` accounts for S.No.).

**Cross-cutting**

- [ ] AC-23  Full admin suite green (`npm run test -w @fsm/admin`) and `tsc --noEmit` clean.
- [ ] AC-24  Only DESIGN-SYSTEM tokens used — no hand-rolled colours or spacing.
- [ ] AC-25  Zero files changed under `apps/backend/` (`git diff --stat apps/backend` empty at every
             commit).

## UI surfaces

- Admin: TopBar breadcrumb (`components/shell/TopBar.tsx`) — modified
- Admin: `DataTable` toolbar + leading column (`components/data/DataTable.tsx`) — modified; affects
  all 38 render sites enumerated below
- Admin: Company/Plant/Device drill-down (`pages/dashboard/CompanyPlantTable.tsx`) — modified, 3 levels
- Admin: Zone dispatch drill-down (`pages/dispatch/ZoneDispatchTable.tsx`) — modified, 2 levels
- Mobile: n/a

## Reference

`docs/ui/desktop/v2-reference/` — the topbar appears in every image; `26-settings.png` covers the
excluded config tables.

**Documented discrepancy (deliberate, operator-approved).** The reference topbar shows the
`FSM Command Console › {page}` eyebrow (`DESIGN-SYSTEM.md:144`; `docs/ui-redevelopment/04-layout.md:43`
calls it "the app's only breadcrumb"). This issue retires it per operator instruction; **AC-8**
records the deviation in the three specifying docs. No reference image exists for a per-table
download button or an S.No. column — both are additive operator asks, matched to existing token
language rather than redesigned.

## Blocked by

None.

---

## Evidence: DataTable audit (38 render sites / 34 files, verified 2026-07-27)

`DataTable` is defined at `apps/admin/src/components/data/DataTable.tsx:70`, exported via
`components/data/index.ts:1`. Every `ariaLabel` in `pages/` is unique (`uniq -d` returns nothing) —
this is what makes `basename = slugify(ariaLabel)` safe without a new required prop.

| Page / route | File:line | `ariaLabel` | Notes |
|---|---|---|---|
| Dashboard `/` | `pages/dashboard/ZoneOverviewTable.tsx:138` | Zone Overview | 3 cols; raw `downloadCsv` at `:41` |
| | `pages/dashboard/ScorecardTable.tsx:202` | Zone Performance Scorecard | 7 cols, 6 `sortValue` |
| | `pages/dashboard/WarehouseDashboard.tsx:195` | Component Request Queue | |
| | `pages/dashboard/WarehouseDashboard.tsx:205` | Warehouse Stock | **3 tables on one page** |
| | `pages/dashboard/WarehouseDashboard.tsx:252` | Shadow-Use Reconciliation | |
| Tickets | `pages/tickets/TicketsPage.tsx:300` | Tickets | 11 cols, `stickyHeader`; page `ExportMenu` `:241` |
| Schedules | `pages/schedules/SchedulesPage.tsx:132` | Batch Schedules | `stickyHeader` |
| Intraday | `pages/schedules/IntradayQueuePage.tsx:139` | Intra-day Queue | |
| Dispatch | `pages/dispatch/DispatchRunsPage.tsx:67` | — | 10 cols |
| | `pages/dispatch/DispatchBatchDetailPage.tsx:187` | Batch assignments | **`tableLayout="fixed"` `:193`, widths `:54`, `renderExpanded` `:197`, page `ExportMenu` `:185`** |
| | `pages/dispatch/ZoneUnassignableTable.tsx:94` | — | rendered inside `DispatchZoneDetailPage` |
| Engineers | `pages/engineers/SeManagementPage.tsx:181` | SE Management | |
| | `pages/engineers/SeManagementDirectoryPage.tsx:414` | SE Directory | 10 cols |
| Readiness | `pages/readiness/VehicleUnavailabilityPage.tsx:220` | Vehicle Unavailability Reports | 10 cols |
| | `pages/readiness/NonOperationalQueuePage.tsx:162` | Non-Operational dual confirmation | |
| | `pages/readiness/RecoveryDecisionQueuePage.tsx:105` | Recovery decision queue | |
| Inventory | `pages/inventory/ComponentBlockedPage.tsx:103` | Component-Blocked Queue | |
| | `pages/inventory/ComponentRequestsPage.tsx:196` | Component Requests | **mounted on two routes** (`AppRoutes.tsx:344`, `:353` `readOnly`) |
| | `pages/inventory/ShadowUseQueuePage.tsx:128` | Shadow Use Queue | |
| Warehouse | `pages/warehouse/RecoveryReceiptQueuePage.tsx:76` | Awaiting Warehouse Receipt | |
| Vouchers | `pages/vouchers/VoucherReviewPage.tsx:280` | Expense Vouchers | page `downloadCsv` `:111` is server-generated — leave |
| Cross-zone | `pages/cross-zone/CrossZonePage.tsx:157` | Cross-Zone Auto-Escalations / Manual Flags | **one JSX site -> 2 rendered tables** (`.map` over `:150-155`) |
| Reports | `pages/reports/ReportsPage.tsx:321` | — | |
| | `pages/reports/DeviceDetailPage.tsx:421` | Device list | **`tableLayout="fixed"` `:427`, widths `:203`, server-side paging `PAGE_SIZE=100` `:40` / `offset` `:126`, page `ExportMenu` `:417`** |
| | `pages/reports/DeviceDetailPage.tsx:572` | Downtime summary | **behind a Chart/Summary toggle `:566`** (`data-testid="trend-summary-toggle"`) |
| | `pages/reports/FleetDirectoryPage.tsx:226` | Fleet companies | **tab-alternative pair — only one mounts**; shared page `ExportMenu` `:221`, body switch `:160-167` |
| | `pages/reports/FleetDirectoryPage.tsx:236` | Fleet plants | |
| | `pages/reports/RootCauseAnalyticsPage.tsx:67` | — | |
| | `pages/reports/SystemEfficiencyPage.tsx:77` | — | |
| | `pages/reports/ZmScorecardPage.tsx:74` | — | |
| | `pages/reports/CsmApprovalSharePage.tsx:93` | CSM Backup Share | |
| Admin | `pages/admin/PlantZonesPage.tsx:171` | — | |
| | `pages/admin/TierOverridesPage.tsx:125` | — | |
| | `pages/admin/PlantDeactivationsPage.tsx:82` | — | |
| | `pages/admin/BuildHealthPage.tsx:94` | — | |
| Coverage | `pages/coverage/TerritoryPage.tsx:148` | — | 2 cols (membership list) |
| Install | `pages/install/InstallCreatePage.tsx:286` | — | **`downloadable={false}`** (decision 4) |
| Dev | `pages/KitchenSink.tsx:125` | Demo table | **`downloadable={false}`** (decision 4) |

**Nested cases.** `renderExpanded` has exactly one caller — `DispatchBatchDetailPage.tsx:197`
(`TracePanel`, not a table). The operator's named example is **not** a `DataTable`: it is bespoke
3-level `<table>` markup in `CompanyPlantTable.tsx` (L1 `:319` `table-fixed`, L2 `:449`
`table-fixed`, L3 `:659` in `OpenDeviceTickets` `:531`, which already has its own `ExportMenu`
`:625`). Second bespoke drill-down: `ZoneDispatchTable.tsx` L1 `:201`, L2 `:308` (`PlantBatchList`).

## Evidence: existing chrome and export infrastructure

**Breadcrumb today.** `TopBar.tsx:83` is the only runtime occurrence of "FSM Command Console" in the
repo. The page title comes from a stale prefix table — `PAGE_TITLES` `:12-33` (20 entries) +
`titleFor` `:35-39` (`'/' -> 'Dashboard'`, unknown -> `'Console'`). It is **missing ~12 live
routes**, all of which render the literal `Console` today (listed in AC-5).

**Route tree is flat.** `AppRoutes.tsx` has 40+ sibling `<Route>`s under one shell route, with
exactly one nesting — `/tickets/:ticketId` (`:71-73`). It cannot produce `Dashboard > Device Detail`.
There is also **no 404 route** (no `<Route path="*">`) — an unmatched in-shell path renders an empty
`<Outlet/>`; AC-6 covers it. `LoginPage` (`:56`) and `KitchenSink` (`:59`) are **outside** the shell,
so `TopBar` never mounts there.

**Export infra (#122, 2026-07-14).** `lib/csv.ts` `toCsv` `:7` / `downloadCsv` `:16`;
`lib/exportFile.ts` zero-dependency `toExcelXml` `:29`, `toPdfString` `:81`, `downloadPng` `:173`,
and the single entry point `exportTable(format, basename, title, headers, rows)` `:250`
(`ExportFormat = 'csv' | 'excel' | 'pdf' | 'img'` `:8`). `components/data/ExportMenu.tsx:12` is a
format `<select>` (`aria-label="Download format"` `:25`) **plus** a button — two controls, which is
why decision 3 introduces a single-button component instead.

**Two facts the design turns on:**

1. The five existing export sites hand-write their header/body arrays from the column definitions,
   and they have already drifted — `TicketsPage.tsx:206-226` declares **12** headers for an
   **11**-column table.
2. `TicketsPage.tsx:212` maps **`rows`**, not the DataTable's internal `sorted` view
   (`DataTable.tsx:106-117`). **Every shipped #122 export silently ignores the user's active column
   sort.** AC-11 fixes this as a side effect; say so in the completion report.

`Column<T>` (`DataTable.tsx:5-16`) has **no text accessor** — `render` returns `ReactNode`, and
`sortValue` exists on only 4 of 34 files. Hence the hybrid `exportValue` + DOM-text design. No
virtualization dependency exists in `apps/admin/package.json`, so a DOM read sees every row.

## Evidence: the four `DataTable` internals a leading column must move in lockstep

| Invariant | Line | Failure if missed |
|---|---|---|
| `totalCols = columns.length + (renderExpanded ? 1 : 0)` | `:101` | drives `colSpan` on empty `:208`, error `:200` and expansion `:297` rows — all under-span by 1 |
| `<colgroup>` map | `:137-143` | `tableLayout="fixed"` only; a missing `<col>` shifts every declared width |
| loading skeleton map | `:187-196` | the comment at `:191` promises "match the real row's padding exactly so there is no jump" — a missing cell reintroduces it |
| `sorted` computed before render | `:106-117`, used `:216` | S.No. must index into `sorted`, never `rows` |

The card's structure is `div.rounded-card` -> `div.overflow-x-auto` -> `<table>`
(`DataTable.tsx:126-135`). **There is no header area today** — a toolbar `<div>` inserted as the
card's first child, above the scroll container, is a pure addition.

## Evidence: tests that will break

Suite: `vitest run` over 84 files in `apps/admin/test/`. Plus a Playwright visual harness
(`apps/admin/visual/manifest.mjs`, 28+ specs). **No snapshot tests exist.**

- **Breadcrumb:** no test breaks. Nothing asserts `FSM Command Console`, `titleFor` or
  `PAGE_TITLES` (`grep -rn "Command Console" test/ visual/ src/` -> only `TopBar.tsx:83`).
  `sidebar-shell`, `acting-banner` and `dispatch-batch-detail` render `AdminShell` but assert only
  nav / wordmark / banner.
- **Download — the ambiguity trap.** These use **singular** `getBy*` and will throw
  *"found multiple elements"*, not fail on absence:
  - `test/dashboard-company-plant.test.tsx:175` `getByRole('button', { name: /download/i })`
  - `test/dashboard-company-plant.test.tsx:176` `getByLabelText(/download format/i)`
  - `test/dispatch-batch-detail.test.tsx:145-153` both of the above
  - `test/exports-page.test.tsx:67` uses `getByTestId('download-entity-mapping')` — **safe**
- **S.No. — the positional trap.** `test/company-plant-overview-rework.test.tsx:41-43`
  (`cells[1] -> 'GOLD'`, `cells[2] -> '2'`) breaks in **Slice 4**, not Slice 2.
  `test/datatable.test.tsx:91` (`getAllByRole('columnheader')[0]` is sticky) still passes but now
  targets S.No. — update its comment so the intent isn't lost silently.
- **Row-index `.slice(1)` patterns survive** (they drop the header row, not a column):
  `datatable:75`, `schedules-list:72`, `tickets-list:76,101`, `zone-operating-mode-table:53`.
- **All 28+ visual baselines change** — every spec in `visual/manifest.mjs:20-49` captures the
  topbar and most capture a table. Expected, not a regression; see Slice 5.

---

## Execution plan

Five slices, red-green-refactor per the `/tdd` skill. **Every commit stages explicit paths —
`git add <path> <path>`, NEVER `git add -A`** (the tree carries unrelated work; see the #144
precedent in INDEX).

### Slice 1 — Breadcrumb (Edit 1)

**Files**
- NEW `apps/admin/src/components/shell/breadcrumb.ts` — `Crumb`, `DETAIL_CRUMBS`,
  `resolveBreadcrumb(pathname, role)`
- MOD `apps/admin/src/components/shell/TopBar.tsx` — delete `PAGE_TITLES` `:12-33` and `titleFor`
  `:35-39`; replace the block at `:80-88`
- NEW `apps/admin/test/breadcrumb.test.tsx`

**Changes.** `resolveBreadcrumb` is pure (no React), so it unit-tests without a router:

```
1. pathname === '/'              -> [{ label: 'Dashboard' }]                       // terminal, no link
2. longest-prefix match on `to` over buildNav(role).flatMap(g => g.items)
                                 -> [{ label: 'Dashboard', to: '/' }, { label: item.label, to: item.to }]
3. tail beyond the matched `to`  -> append from DETAIL_CRUMBS
4. no nav match                  -> DETAIL_CRUMBS entry (declares its own parent)
5. no match at all               -> [{ label: 'Dashboard', to: '/' }, { label: 'Console' }]
```

`DETAIL_CRUMBS` is the **only** new artifact and is net-zero — it replaces the deleted
`PAGE_TITLES`. Six entries, covering every shell route absent from `buildNav`:

| Pattern | Crumbs |
|---|---|
| `/tickets/:ticketId` | `Dashboard > Tickets > Ticket #<id>` |
| `/schedules/:engineerId` | `Dashboard > Schedules > Schedule Detail` |
| `/dispatch-runs/:runId` | `Dashboard > Dispatch Runs > Run #<id>` |
| `/dispatch-runs/:runId/zones/:zoneId` | `Dashboard > Dispatch Runs > Run #<id> > Zone <id>` |
| `/batches/:batchId` | `Dashboard > Dispatch Runs > Batch #<id>` (no nav entry; declared parent) |
| `/reports/fleet` | `Dashboard > Reports > Fleet Directory` (no nav entry; declared parent) |

`TopBar` renders `<nav aria-label="Breadcrumb">`, `<Link>` for every crumb but the last, last with
`aria-current="page"`. Separator `›`, `aria-hidden`, `text-ink-muted`. Reuse the existing type
scale: last crumb `text-[15px] font-semibold text-ink-strong` (today's title style `:85`),
ancestors `text-[13px] text-ink-muted`. Keep `hidden lg:flex` — mobile keeps the hamburger.

**RED test** (`test/breadcrumb.test.tsx`)
1. `resolveBreadcrumb('/', 'ZONAL_MANAGER')` -> `[{label:'Dashboard'}]`, no `to`.
2. `resolveBreadcrumb('/reports/device', 'OPERATIONS_HEAD')` -> `Dashboard`(->`/`), `Device Detail`.
3. `resolveBreadcrumb('/tickets/T-1', 'ZONAL_MANAGER')` -> three crumbs ending `Ticket #T-1`.
4. `/engineers/manage` resolves to `Manage SEs`, not `SE Activity` — pins longest-prefix.
5. `/nonexistent` -> `Dashboard > Console`.
6. Render `AdminShell` at `/tickets/T-1`; assert `nav[aria-label="Breadcrumb"]` holds a `Tickets`
   link and `Ticket #T-1` carries `aria-current="page"`.
7. `expect(screen.queryByText(/FSM Command Console/)).toBeNull()`.

**Done when.** AC-1..AC-7 checked; suite green; `grep -rn "FSM Command Console" apps/admin/src`
returns nothing.

**Traps**
- `TopBar` is **outside** the `/tickets/:ticketId` route, so `useParams()` gives nothing — parse the
  id from `useLocation().pathname`. Do **not** restructure routes to get params.
- `TopBar` early-returns on `!session` (`:48`), so `session` is non-null below that line; call
  `buildNav(session.role)`.
- `/` is `Zone Dashboard` for managers but `Dashboard` for WM (`nav.ts:56`, `:67`) — crumb[0] must
  be the **literal** `Dashboard`, not the nav label.
- Longest-prefix, not first-match: `/engineers` would otherwise swallow `/engineers/manage` and
  `/engineers/planner` (`nav.ts:76-78`). This is the same rule `titleFor:37` already used.

### Slice 2 — S.No. column in `DataTable` (Edit 3, DataTable only)

**Files**
- MOD `apps/admin/src/components/data/DataTable.tsx`
- MOD `apps/admin/src/pages/dispatch/DispatchBatchDetailPage.tsx` (widths `:54`)
- MOD `apps/admin/src/pages/reports/DeviceDetailPage.tsx` (widths `:203`; `snoOffset` on `:421`)
- MOD `apps/admin/test/datatable.test.tsx`

**Changes.** Two new props: `serialNumbers?: boolean` (default `true`) and `snoOffset?: number`
(default `0`). The S.No. cell is injected **in the render pass, not pushed into the `columns`
array** — pushing it would corrupt `columns.find(c => c.key === sort.key)` (`:108`) and the
`<colgroup>` key map (`:138`). Header `S.No.`, not sortable, `w-14 text-right tabular-nums`; it is
**not** marked `data-export-skip` (we want it in the export, AC-18 / decision).
Value: `snoOffset + index + 1` from the `sorted.map` index at `:216`.

Update in lockstep — this is the whole slice:
- `totalCols` `:101` -> `+= serialNumbers ? 1 : 0`
- `<colgroup>` `:137` -> prepend `<col style={{ width: '3.5rem' }} />`
- skeleton map `:187` -> prepend a matching cell (the `:191` no-jump promise)
- `sorted.map` `:216` -> prepend the `<td>`

Then re-proportion the two fixed-width sets so declared widths + 3.5rem still resolve to 100%.

**RED test** (extend `test/datatable.test.tsx`)
1. First `columnheader` reads `S.No.`; body rows read `1`, `2`.
2. Sort by `Count` desc -> S.No. still reads `1`, `2` top-to-bottom while `Beta` moves to row 1.
   *(the re-number-not-pin contract, AC-18)*
3. With `renderExpanded` open, the panel `td` `colSpan` === `columns.length + 2`.
4. Empty-state `td` `colSpan` === `columns.length + 1`.
5. `snoOffset={100}` -> first row reads `101`.
6. Loading skeleton row cell count === a data row's cell count.
7. `serialNumbers={false}` -> first header is `Name`.

**Done when.** AC-17..AC-22 checked; `datatable`, `dispatch-batch-detail`, `device-detail` suites green.

**Traps**
- Never append S.No. to `columns` (breaks sort lookup `:108` + colgroup key map `:138`).
- Compute from the index into **`sorted`**, never `rows`.
- `test/datatable.test.tsx:91` still passes but now targets S.No. — update its comment.
- `activeVariant='danger'` applies `[&>td]:text-white` (`:267`); the S.No. `td` inherits correctly —
  do not special-case.

### Slice 3 — Per-table download in `DataTable` (Edit 2, DataTable only)

**Files**
- NEW `apps/admin/src/components/data/TableDownloadButton.tsx`
- NEW `apps/admin/src/lib/tableExport.ts` — `extractTableExport(tableEl) -> { headers, rows }`
- MOD `apps/admin/src/components/data/DataTable.tsx` — toolbar, `<table>` ref, `data-row-export` /
  `data-export-skip` markers, `Column.exportValue` / `Column.exportable`
- MOD `apps/admin/src/components/data/index.ts`
- MOD (remove the now-duplicate page-level menus): `pages/tickets/TicketsPage.tsx` (`:206-226`,
  `:241`), `pages/dispatch/DispatchBatchDetailPage.tsx` (`:136`, `:185`),
  `pages/reports/DeviceDetailPage.tsx` (`:302`, `:417`), `pages/reports/FleetDirectoryPage.tsx`
  (`:162-167`, `:221`), `pages/dashboard/ZoneOverviewTable.tsx` (`:41`)
- MOD `apps/admin/test/dispatch-batch-detail.test.tsx` (`:145-153`)
- NEW `apps/admin/test/table-download.test.tsx`

**Changes.** New props: `downloadable?: boolean` (default `true`), `exportName?: string`. The
toolbar div is the card's **first child**, above the `overflow-x-auto` container (`:128`):
`flex items-center justify-end gap-2 border-b border-line bg-surface-raised px-3 py-2` — all
existing tokens (same recipe as `CompanyPlantTable.tsx:657`).

`TableDownloadButton` — one `Button variant="secondary" size="sm"` with `IconDownload`
(`ui/icons.tsx:205`), `aria-label={\`Download ${ariaLabel}\`}`, opening a Radix `DropdownMenu` with
CSV / Excel / PDF / Image (PNG). On select ->
`exportTable(format, slugify(exportName ?? ariaLabel), exportName ?? ariaLabel, headers, rows)`.

`extractTableExport` reads `thead th:not([data-export-skip])` for headers and
`tbody tr[data-row-export]` -> `td:not([data-export-skip])` `textContent` for the body.
`DataTable` marks `data-row-export` on the data `<tr>` (`:227`), and `data-export-skip` on the
chevron `th` (`:175`) / `td` (`:286`) and on any column with `exportable === false`. Where
`Column.exportValue` is defined, its value wins over DOM text for that cell.

Two optional, non-breaking `Column<T>` additions: `exportValue?: (row: T) => ExportCell` and
`exportable?: boolean` (default `true`).

**RED test** (`test/table-download.test.tsx`)
1. A `downloadable` table renders exactly one `button[aria-label="Download Sample"]`.
2. Choosing CSV calls a spied `exportTable` with headers `['S.No.','Name','Count']` and rows
   `[['1','Alpha','3'],['2','Beta','7']]` — pins S.No. inclusion and column order.
3. Sort by Count desc, then export -> body is `[['1','Beta','7'],['2','Alpha','3']]` — **pins
   post-sort export (AC-11); this is the bug `TicketsPage.tsx:212` ships today.**
4. `renderExpanded` open -> the panel row is absent from the export.
5. `exportable: false` on a column -> absent from headers and every row.
6. `loading` / `error` / zero rows -> the button is `disabled`.
7. Spy on `global.fetch`; export; assert **zero calls** (AC-16).
8. Three DataTables on one page -> three buttons, each addressable by its own `aria-label`.

**Done when.** AC-9..AC-16 checked; the two ambiguity-trap tests updated; suite green.

**Traps**
- `test/dashboard-company-plant.test.tsx:175` and `test/dispatch-batch-detail.test.tsx:153` throw on
  multiple matches. Fix by **querying the specific `aria-label`**, not by loosening the selector.
- jsdom lacks object-URL APIs — `test/exports-page.test.tsx:28` already stubs them; reuse that stub.
- `downloadPng` (`exportFile.ts:173`) needs a canvas 2D context; jsdom returns null and it
  early-returns (`:185`, `:204`). Spy on `exportTable`; do not assert on real PNG bytes.
- Do **not** rewrite `VoucherReviewPage:111` or `api/exports.ts` — server-generated payloads.
- Removing `TicketsPage`'s export changes the exported set from its hand-curated 12 columns to the
  table's 11 + S.No. That is intentional (the hand-written set had drifted) — **record it in the
  completion report**, do not paper over it.

### Slice 4 — Call-site sweep + the two bespoke drill-downs

**Files**
- MOD `apps/admin/src/pages/dashboard/CompanyPlantTable.tsx` — L1 `:319`, L2 `:449`, L3 `:659`
- MOD `apps/admin/src/pages/dispatch/ZoneDispatchTable.tsx` — L1 `:201`, L2 `:308`
- MOD `apps/admin/test/company-plant-overview-rework.test.tsx` (`:41-43`)
- MOD `apps/admin/src/pages/install/InstallCreatePage.tsx` + `apps/admin/src/pages/KitchenSink.tsx`
  — `downloadable={false}` (decision 4)
- MOD assorted page files — `exportable: false` on action-button columns found in the sweep

**Changes.** Walk all 38 sites in the audit table above; confirm each renders one download button
and an S.No. column; add `exportable: false` to columns that render only action buttons.

Then hand-wire the five bespoke levels: prepend an `S.No.` `<th>`/`<td>` (re-numbering that level's
own filtered+sorted view from 1) and add a `TableDownloadButton` to each level's existing header
strip. `CompanyPlantTable` L1 (`ExportMenu :315`) and L3 (`ExportMenu :625`) — **replace** with the
new button so there is one control per level; L2 gets a new one. `ZoneDispatchTable` has none; both
levels get one.

L1 and L2 of `CompanyPlantTable` are `table-fixed` with a custom multi-cell bucket header
(`BucketHeaderCells` `:84`) — the S.No. column must be added to **both** the header row and the
`BucketHeaderCells` alignment, or every bucket column shifts by one.

**RED test.** Update `company-plant-overview-rework.test.tsx:41-43` to `cells[2]` / `cells[3]`, then
add: L1, L2 and L3 each expose their own `Download …` button; each level's S.No. restarts at 1; and
a test asserting no control exports more than its own level (AC-13).

**Done when.** All 38 sites verified; five bespoke levels done; AC-13 and AC-20 checked; suite green.

**Traps**
- `CrossZonePage.tsx:157` is **one JSX site rendering two tables** via `.map` — it gets two buttons
  automatically. Verify, don't "fix".
- `FleetDirectoryPage`'s two tables are tab alternatives; only one is mounted. Do not assert both.
- `DeviceDetailPage.tsx:572` is behind a toggle (`:566`) — a test must click
  `data-testid="trend-summary-toggle"` first.
- `ComponentRequestsPage` mounts on two routes (`AppRoutes.tsx:344`, `:353`) — check both.
- **Do not migrate any bespoke table onto `DataTable`.** Out of scope, explicitly.

### Slice 5 — Docs, INDEX, visual baselines

**Files**
- MOD `.scratch/fsm-platform-v1/DESIGN-SYSTEM.md:144`
- MOD `docs/ui-redevelopment/04-layout.md:43`
- MOD `docs/ui-redevelopment/retheme-2026-07-15-parity-checklist.md:18`
- MOD `docs/SYSTEM-STATE-2026-07.md` — edit the admin-FE section **in place**
- MOD `.scratch/fsm-platform-v1/INDEX.md` — update the #160 row + append **one** Session-log line
- NEW `docs/progress/160-admin-table-chrome.md` — TDD completion report
- Baselines under `apps/admin/visual/baseline/` — regenerate **only after** the operator eyeballs
  the diff

**Done when.** AC-8, AC-23..AC-25 checked; `npm run test -w @fsm/admin` green; `tsc --noEmit` clean;
`git diff --stat apps/backend` empty.

**Traps**
- **All 28+ visual baselines change** (`visual/manifest.mjs:20-49`). `npm run visual:compare` will
  report a wall of diffs — expected, not a regression. **Do not blind-regenerate**: per the CLAUDE.md
  HITL policy this is an operator eyeball, and it is the last step, after every other slice is green.
- Never create a new status/progress doc. `SYSTEM-STATE-2026-07.md` is edited **in place**;
  `INDEX.md` gets **one** appended session-log line.
- `docs/archive/` is write-once — nothing there is touched.
- `.scratch/fsm-platform-v1/issues/FE-02-appshell.md:25` mentions the old breadcrumb but is
  historical/checked — leave it.

## Global traps

1. **`git add -A` is forbidden.** The working tree carries unrelated work (INDEX's #144 entry
   documents a 42-path dirty tree from exactly this mistake). Stage explicit paths, per slice.
2. **Backend-untouched is an AC, not a hope** (AC-25). `git diff --stat apps/backend` must be empty
   at every commit. The one design that would breach it — parent-exports-hierarchy — is already
   rejected. If it resurfaces, **stop and escalate** (Strategic HITL).
3. **Two singular `getByRole(/download/i)` queries will start THROWING** on multiple matches, not
   failing on absence — the error will not say "your feature is wrong". Named in Slice 3.
4. **`cells[1]`/`cells[2]` in `company-plant-overview-rework.test.tsx:41-43` shift by one in
   Slice 4, not Slice 2.** Don't chase it early.
5. **Don't push S.No. into the `columns` array** — it corrupts sort lookup (`:108`) and the colgroup
   key map (`:138`). Inject it in the render pass.
6. **`totalCols` (`:101`) drives three separate `colSpan`s.** Miss it and the empty state, error
   state and expansion panel all under-span by one — visually subtle, easy to ship broken.
7. **`tableLayout="fixed"` widths must be re-proportioned**, or the two tables whose own code
   comments promise "the operator never scrolls sideways" (`:54`, `:203`) start scrolling sideways.
8. **The export is a DOM read, deliberately. Do not "improve" it into a data-model read.** The DOM
   read *is* the zone-scoping proof (AC-16: export ⊆ what is already rendered, so it is a strictly
   weaker capability than page render) and the visible-view guarantee (AC-11). Changing it silently
   breaks both.
9. **`snoOffset` matters on exactly one table** — `DeviceDetailPage` pages server-side (`:126`).
   Everywhere else the default `0` is right. Do not generalise a pagination concept the app lacks.
10. **Tokens only** (AC-24): `border-line`, `bg-surface-raised`, `text-ink-muted`, `text-ink-strong`,
    `rounded-card` — all already in use. No hex, no arbitrary spacing.
