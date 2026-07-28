# Admin re-theme 2026-07-15 — element parity checklist

Reference: `docs/ui/desktop/uiDashboardRef.jpg` (green adapted to red; red/black/white/gray).
Hard rule: **design change only** — every element below must exist and function identically
before and after. SLA severity badge/bar colors (`lib/slaBucket.ts BUCKET_HEX`, semantic
`info/success/verified/warning/critical/neutral` tokens) are untouched.

Legend: `[T]` = file touched by the re-theme (item-by-item re-verify); `[U]` = file untouched
(parity by construction — token re-values only).

## Shell — every role

- [T] Sidebar (`shell/Sidebar.tsx`): mobile scrim, off-canvas drawer, brand band (logo +
  collapse toggle + mobile close), role-grouped nav with headings, active state +
  `aria-current`, collapsed icon rail + body-portal tooltips, "Admin Console v2.0" footer line.
- [T] BrandLogo (`shell/BrandLogo.tsx`): red "autoplant Systems" wordmark + "FIELD MANAGEMENT
  SYSTEM" caption.
- [T] TopBar (`shell/TopBar.tsx`): mobile menu button, global search input, RunIngestionButton
  (OH-only, self-gated), "Assign SE" button, Act-as-ZM input + Go (CSM/OH, not acting), divider,
  notifications bell, profile chip (initials avatar + role + zone), Log out button.
  **Superseded 2026-07-27 (#160, operator decision):** the eyebrow "FSM Command Console" + page-title
  pair this line originally described is retired; TopBar now renders a real breadcrumb
  (`nav aria-label="Breadcrumb"`, `resolveBreadcrumb` off `buildNav`) in that position instead.
- [U] AppShell: acting-as-ZM warning banner + "Exit acting mode", main frame, SnapshotBanner.
- [T] Footer (`shell/Footer.tsx`): brand block + tagline, 4 link columns (16 links), status row
  (4 items).
- [T] Login (`LoginPage.tsx`): dark split layout, blueprint-grid backdrop, brand mark "A" +
  Autoplant title, headline + copy, 4 KPI tiles, sign-in card (session-expired notice, email
  field + icon, password field + icon + show/hide toggle, Remember me, Forgot Password link,
  error alert, Sign In button, 4-item feature list, version footer).
- [U] KitchenSink (dev-only audit page): all primitives render from tokens.

## Shared primitives (all pages)

- [T] `ui/Card.tsx` Card + SectionCard (header row + action slot). [T] `data/MetricStrip.tsx`
  MetricCard/MetricStrip (+ new hero visual variant — additive only; testId, onClick, tone
  accents preserved). [U] Button (primary/secondary/danger/ghost, loading), Badge (7 tones,
  dot), Input/Field, icons.
- [U] DataTable (sort, sticky header, row accent/active, skeleton/error/empty, row testids,
  keyboard rows), PageHeader, FilterBar, DateRangeChips, ExportMenu, Toast, RollingNumber,
  feedback (EmptyState/ErrorState/Skeleton).
- [U] Overlays: Modal, Sheet, Tabs, Select, DropdownMenu (hover washes re-tokened only).
- [U] Domain: badges (SLABadge/StatusPill/TierBadge/AgeChip), TicketCard, Timeline, PlantName.
- [T] `charts/colors.ts` (axis/grid/neutral grays only — semantic series colors kept).
  [U] ChartCard, TrendChart, BarChartCard, DonutChart, RadialGauge, DistributionBar, BarList,
  ReportGrid.

## Zonal Manager / CSM / Operations Head

`/` dashboard (role variant):

- [T-hero-only] ZM "Zone Operations Dashboard": PageHeader + Snapshot Healthy badge +
  DateRangeChips; error alert; 6 KPI cards — Fleet Uptime, Inactive Devices, Critical Devices
  (`kpi-critical`), Companies (`kpi-companies`, click→fleet), Plants (`kpi-plants`,
  click→fleet), Devices (`kpi-devices`, click→device report); ActionRequiredPanel;
  ZoneOverviewTable (FilterBar + "Zone Overview" table); CompanyPlantTable (FilterBar +
  Download ExportMenu + table); CriticalQueue (grouped tickets + assign-SE picker).
- [T-hero-only] CSM "Cross-Zone Central Tower": 4 KPIs (Fleet Uptime, Zones Covered, Inactive,
  Escalations); EscalationQueueList; ScorecardTable; CompanyPlantTable.
- [T-hero-only] OH "Pan-India Fleet Command": 6 rolling KPIs (same testids as ZM);
  Auto-Dispatch efficiency strip (4 gated "—" cards); SLA Bucket Distribution card
  (DistributionBar — bucket colors untouched); ScorecardTable; CompanyPlantTable.

Other pages (all `[U]`):

- `/tickets` Ticket Operations: ExportMenu Download, FilterBar, "Tickets" table, nested
  TicketDetailDrawer (tabs, timeline, components/forms tabs, "Manually close Recovery Ticket"
  modal, toasts).
- `/install`: "Single Install" form card, "CSV bulk upload" card + "CSV errors" table.
- `/schedules` Batch Schedule: MetricStrip + "Batch Schedules" table; `/schedules/:engineerId`
  detail page.
- `/intraday`: "Intra-day Queue" table + actions.
- `/engineers` SE Activity: DateRangeChips, "SE Management" table, Set-Availability panel.
- `/engineers/manage`: "Add Service Engineer" card, "SE Directory" table.
- `/engineers/planner`: DateRangeChips, MetricStrip, planner grid.
- `/verification`: MetricStrip, "Verification outcomes" DonutChart card, review table.
- `/readiness/vehicle-unavailability`: DateRangeChips + dual-clock table.
- `/readiness/non-operational`: dual-confirmation table (OH override in-page).
- `/readiness/recovery-decisions`: decision queue table.
- `/cross-zone`: Auto (Platinum) vs Manual lists + approve/deny/defer.
- `/leave-requests`: approvals table.
- `/vouchers`: "Expense Vouchers" table, proof lightbox modal, OH Finance batch export +
  Mark PAID multi-select.
- `/component-blocked`: MetricStrip, FilterBar, queue table.
- `/component-requests`: read-only oversight table.
- `/reports`: 6 KPIs, 7 chart cards (SLA buckets, uptime trend ×2, soft-inactive, work mix
  BarList, outcomes BarList), "Zone breakdown" table + CSV download.
- `/reports/device`: FilterBar, "Devices" table + ExportMenu, downtime history cards,
  "Current failure cycle", "Lifetime downtime trend" (summary table + BarChartCard),
  AssignSePanel + toasts, ticket deep-links.
- `/reports/fleet`: 3 KPIs, FilterBar, ExportMenu, "Fleet companies" / "Fleet plants" tables.
- `/reports/root-cause`: 3 KPIs, distribution BarChartCard, "Breakdown" table.
- `/reports/system-efficiency`: 6 KPIs, 2 chart cards, "Efficiency by zone" table.
- `/help`: role-scoped topic cards + "Model states & terminology" glossary.

## Operations Head only (all `[U]`)

- `/reports/zm-scorecard`: "Top performer" card, "Scorecard" table.
- `/reports/csm-approval-share`: MetricStrip, "CSM share by zone (%)" BarChartCard, table.
- `/coverage`: "Current territory" + "Add coverage" cards.
- `/plant-deactivations`: table + deactivate/reactivate modals.
- `/exports`: "Entity mapping (CSV)" card.
- `/settings`: config sections (zones, plants, users, companies, coverage, SLA, scoring).

## Warehouse Manager

- [T-hero-only] `/` "Zone Warehouse Fulfillment": 4 KPIs (Open Requests, Tickets Blocked,
  Low-Stock SKUs, Fulfillment SLA); "Component Request Queue" card + open-queue link;
  "Warehouse Stock" card + per-row Adjust buttons + adjust-stock modal (3 fields,
  Cancel/Save); "Shadow-Use Reconciliation" card + open-queue link.
- [U] `/warehouse/requests`, `/warehouse/shadow-use`, `/warehouse/recovery-receipt`, `/help`.

## Service Engineer (admin login edge case)

- [U] Nav: Dashboard + Tickets + Help; ZmDashboard body.

## Verification protocol

After styling: re-verify every `[T]` file item-by-item above; `[U]` files must show zero diff
(`git diff --stat`); targeted vitest runs (shell, login, dashboards, ui-primitives, datatable,
routing) green; `tsc` + `vite build` clean.

## Verification results (2026-07-15)

- Every `[T]` file re-checked against its element list: diffs are className/token-value only
  (plus the additive `hero` prop on MetricCard); no element, handler, route, label, testId,
  aria attribute, or API call added/removed. `[U]` files: zero re-theme diff (the only other
  working-tree changes are this branch's pre-existing AutoPlant/reports WIP layer).
- SLA severity colors: `lib/slaBucket.ts` (BUCKET_HEX + badge classes) untouched; semantic
  `info/success/verified/warning/critical/neutral` tokens byte-identical in `index.css`;
  chart semantic series colors unchanged (only axis/grid/neutral grays cooled).
- Tests: full admin suite green — 69 files / 250 tests. `tsc --noEmit` clean;
  `vite build` clean.
- Visual capture (`npm run visual:capture`, live backend): 27/28 pages captured across all
  four roles and eyeballed — black sidebar, gray canvas, white rounded cards, black hero KPI,
  red-as-accent all confirmed. `08-ticket-detail` timed out on the row-click helper, but
  `28-tickets-drawer` exercises the same drawer flow and captured correctly.
- `visual/baseline/` still holds the pre-re-theme (warm/gold) baselines; `visual:compare`
  will intentionally diff until baselines are re-blessed after this re-theme lands.
