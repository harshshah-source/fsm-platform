# 19 — UI Redevelopment Roadmap (order only — no redesign here)

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [18 — Dependency Graph](18-dependency-graph.md) · Next: [20 — Master Index](20-master-index.md).

Ordering rationale: the app is token-driven and composed from a small shared kit ([18 — fan-in](18-dependency-graph.md)), so restyling flows outward from tokens → shell → kit → pages. After **every phase**: `pnpm typecheck && pnpm test` must stay green ([16 — DO NOT BREAK](16-business-constraints.md)); `/_kitchensink` and the visual harness are the checkpoints.

## Phase 1 — Foundation (tokens)
- `src/index.css` `@theme`: colors, typography (font, caps-label idiom, th defaults), spacing/radius, shadows, body background, focus-ring, motion rules (keep `prefers-reduced-motion` global collapse and the `@source inline` grid safelist).
- Sync mirrors: `components/charts/colors.ts`, `lib/slaBucket.ts` `BUCKET_HEX`/`BUCKET_CLASS` (SLA ramp must remain an ordered severity ramp).
- Checkpoint: KitchenSink.

## Phase 2 — Shell & chrome
- `shell/AppShell`, `Sidebar` (keep collapse/drawer/tooltip behavior + persistence), `TopBar` (keep RunIngestion, acting control, logout wiring), `Footer`, acting banner, `SnapshotBanner` (migrate its raw slate/red classes onto tokens), `LoginPage` composition.
- Do not touch `nav.ts` logic or `BrandLogo` lockup.

## Phase 3 — Shared kit (highest fan-in, props frozen)
- `ui/`: Button, Badge, Card/SectionCard, Input/Field, icons.
- `data/`: DataTable (all built-in states), FilterBar/FilterSelect/SearchInput, MetricCard/MetricStrip, PageHeader, Skeleton/EmptyState/ErrorState, Toast, DateRangeChips, RollingNumber.
- `overlay/`: Modal, Sheet, Select, Tabs, DropdownMenu (may add focus-trap/scroll-lock — roles/labels unchanged).
- `charts/`: ChartCard, Bar/Trend/Donut, RadialGauge, DistributionBar, ReportGrid.
- `domain/`: badges, TicketCard, Timeline, PlantName.
- Most pages visually update for free here.

## Phase 4 — Dashboards (`/`)
- ZmDashboard, CentralDashboard, OpsHeadDashboard (RollingNumber + DistributionBar), WarehouseDashboard (+stock Modal), and the section components (ActionRequiredPanel, ZoneOverviewTable, CompanyPlantTable drill-down, ScorecardTable, EscalationQueueList, CriticalQueue).

## Phase 5 — Feature pages (queue recipe first, then bespoke)
1. Recipe queues: Schedules, Intraday, ComponentBlocked, ComponentRequests, ShadowUse, RecoveryReceipt, RecoveryDecisions, VehicleUnavailability, NonOperational, CrossZone, Vouchers.
2. Legacy-styling convergence (move raw slate/red classes onto tokens/DataTable): **TicketDetailDrawer, LeaveRequestsPage, VerificationReviewPage, ticketBadges** — selectors preserved.
3. Split-layout pages: Tickets+Drawer, SeManagement, SeManagementDirectory, DeviceDetail.
4. Bespoke grids/forms: PlannerPage (drag/drop contract), InstallCreatePage, TerritoryPage, SettingsPage + sections (9 tabs), ExportsPage, HelpCenterPage.
5. Reports suite: ReportsPage, RootCause, SystemEfficiency, ZmScorecard, CsmApprovalShare (gated placeholders stay honest).

## Phase 6 — Dialogs, motion, responsive polish
- Unify one-off dialogs onto the shared Modal (MarkNonOperationalModal; optionally replace the four `window.prompt` flows — payloads identical, per follow-up #72; consider moving TicketDetailDrawer onto `Sheet` while keeping the route + selectors).
- Animation pass (respecting reduced-motion), mobile/tablet audit (sidebar drawer, filter wrap, table overflow, split-panels collapse), scrollbar/selection styling.
- Final gate: full vitest suite + visual compare + role-by-role manual walkthrough (ZM, CSM, OH, WM) including acting mode and session-expiry.
