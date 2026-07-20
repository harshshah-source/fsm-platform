# 07 — Component Inventory

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [06 — Pages](06-pages.md) · Next: [08 — Hooks](08-hooks.md).

All components are hand-rolled in-repo (no external component library in use). Styling is Tailwind utility classes over the [design tokens](14-design-system.md); every component accepts `className` merged via `cn()` unless noted. Barrel files: `ui/index.ts`, `data/index.ts` (also re-exports Toast + RollingNumber), `overlay/index.ts`, `charts/index.ts`, `domain/index.ts`.

## `components/ui` — primitives

| Component | Purpose | Props | Notes |
|---|---|---|---|
| **Button** | Canonical CTA (forwardRef `<button>`) | `variant: primary\|secondary\|danger\|ghost` (default primary — brand-red gradient), `size: sm\|md\|lg` (default md), `loading` (spinner + disabled), + ButtonHTMLAttributes | Used by every page. `active:translate-y-px`, `focus-ring` |
| **Card** | Base surface | HTMLDivAttributes | `premium-panel rounded-card border-line` + hover shadow lift |
| **SectionCard** | Card + caps header row | `title?`, `action?` (right-aligned), `children`, `className?`, `bodyClassName?` | Header has gradient band (`surface-raised → luxury-100/45`); `bodyClassName="p-0"` for flush tables |
| **Input** | Canonical text input (forwardRef) | InputHTMLAttributes | h-10, `focus-visible:border-brand-600 focus-ring` |
| **Field** | Label + control wrapper | `label`, `htmlFor?`, `children`, `className?` | 12px semibold muted label. (Settings `sections.tsx` has its own local `Field` variant) |
| **Badge** | Tinted status pill | `tone: info\|success\|verified\|warning\|critical\|neutral\|brand` (default neutral), `dot?` | Caps 0.68rem, `ring-1 ring-inset`; the base for all domain pills |
| **icons** (29 exports) | Inline SVG icon set | `SVGProps` | `IconMail Lock Eye EyeOff Check Spinner Search Bell Plus Menu Close Grid Ticket Calendar Clock Activity Route Shield Truck Alert Rotate Clipboard BoxAlert Package Shuffle MapPin Share Settings Help`. Stroke 2, `currentColor`, `aria-hidden`, sized via className |

## `components/data` — data-display patterns

| Component | Purpose | Props | Notes |
|---|---|---|---|
| **DataTable\<T\>** | THE canonical table | see [12 — Tables](12-tables.md) | loading skeletons / ErrorState+retry / EmptyState built in; optional client sort, sticky header, row click (keyboard-accessible), row accents, `rowTestId` |
| **FilterBar** | Horizontal filter container above tables | `children`, `className?` | Card-styled flex-wrap strip |
| **SearchInput** | Search input with leading icon | InputHTMLAttributes | w-56 default |
| **FilterSelect** | Styled native `<select>` | SelectHTMLAttributes | h-9; used for ALL filter/form selects (the custom `Select` is rarely used) |
| **MetricCard** | Single KPI card | `label`, `value`, `hint?`, `tone?: MetricTone`, `testId?` | Left 1px tone accent via `before:`; hover lift |
| **MetricStrip** | KPI row grid | `metrics: Metric[]`, `cols?: 3\|4\|5\|6` (default 4), `className?` | Column classes safelisted in index.css `@source inline` |
| **PageHeader** | Page title block | `title`, `subtitle?`, `actions?` | Card-styled; 2xl semibold title |
| **Skeleton** | Shimmer placeholder | `className?` | `animate-pulse` gradient |
| **EmptyState** | No-data block | `message?`, `icon?`, `action?` | Icon in sunken circle; centered |
| **ErrorState** | Error block | `message?`, `onRetry?` | `role="alert"` + Retry Button |
| **ToastProvider / useToast / useToastOptional** | App toast host + API | `push(msg, tone?)`, `success(msg)`, `error(msg)` | Fixed bottom-right z-50, 4 s auto-dismiss, `role="status"`, tone-tinted |
| **DateRangeChips** | `BEST · 1D 7D 14D 1M 3M 6M 12M YTD` pill toolbar | `value?`, `onChange?`, `className?` | Controlled or self-contained; **decorative on most pages — not wired to data fetching anywhere yet** |
| **RollingNumber / useRollingNumber** | KPI odometer count-up | `value`, `runToken?`, `durationMs?`, `instant?` | Rolls only when `runToken` changes (ingestion completion), snaps otherwise; honors reduced motion |

## `components/overlay` — dialogs & disclosure (all hand-rolled, no Radix)

| Component | Purpose | Props | A11y contract |
|---|---|---|---|
| **Modal** | Centered dialog | `open`, `onClose`, `title?`, `children`, `footer?`, `className?` | `role="dialog" aria-modal`, Escape + backdrop close; blur backdrop |
| **Sheet** | Right/left slide-over drawer | `open`, `onClose`, `title?`, `children`, `footer?`, `side?`, `widthClass?`, `ariaLabel?` | Same dialog semantics; header ✕ button. (Built for the ticket drawer but the drawer currently uses its own `aside`) |
| **Select** | Custom combobox/listbox | `value`, `onChange`, `options: {value,label}[]`, `placeholder?`, `aria-label?` | `role="combobox"` + `listbox`/`option`; outside-click/Escape close. Prefer `FilterSelect` for plain cases |
| **Tabs / TabList / Tab / TabPanel** | Controlled ARIA tab group | Tabs: `value`, `onValueChange`; TabList: `aria-label?` | Full `tab`/`tablist`/`tabpanel` + `aria-selected`/`aria-controls` wiring via `useId` |
| **DropdownMenu** | Action menu | `trigger`, `items: {label,onSelect,tone?,disabled?}[]`, `align?`, `aria-label?` | `menu`/`menuitem` roles; outside-click/Escape close |

## `components/charts` — Recharts wrappers

| Component | Purpose | Props |
|---|---|---|
| **ChartCard** | SectionCard alias for charts | `title?`, `action?`, `children`, `className?` |
| **BarChartCard** | Horizontal bar chart | `data: {name,value,color?}[]`, `height=240`, `color=CHART.brand`, `categoryWidth=120` |
| **TrendChart** | Line trend | `data: {label,value}[]`, `height=240`, `color` |
| **DonutChart** + **ChartLegend** | Donut with center overlay + swatch legend | `data`, `height=220`, `center?`; legend `items` |
| **RadialGauge** | Single % gauge with center label | `value`, `height=180`, `color`, `label?` |
| **DistributionBar** | Pure-CSS segmented heat-ramp bar + legend | `segments: {label,value,color}[]` |
| **ReportGrid** | 2-up responsive report grid | `children`, `className?` |
| **colors.ts** | `CHART` hex map + `CHART_PALETTE` | Mirrors tokens — keep in sync with `index.css` |

## `components/domain` — FSM vocabulary (single-source semantics)

| Component | Purpose | Props | Contract |
|---|---|---|---|
| **SLABadge** | Bucket severity pill | `bucket: string\|null`, `showRange?`, `className?` | `data-testid="bucket-<BUCKET>"`; null renders nothing; colors/labels from `lib/slaBucket` only |
| **DurationBadge** | Elapsed-inactivity pill (same colors) | `bucket`, `latestGpsDatetime`, `className?` | Same testid; shows "4d 6h" style via `formatInactiveDuration`, title = bucket label |
| **StatusPill** | Any backend status enum → toned Badge + humanized label | `status`, `label?`, `className?` | `STATUS_TONE` map covers ticket/component/recovery/install/intraday/assignment vocabularies — extend the map, don't fork |
| **TierBadge** | PLATINUM/GOLD/SILVER chip | `tier`, `className?` | |
| **AgeChip** | Age pill, tone deepens at 3/7/14 days | `days`, `className?` | |
| **EntityBadge** | Small inset id chip | `value`, `className?` | |
| **TicketCard** | Dense ticket summary card | `title`, `subtitle?`, `bucket?`, `status?`, `tier?`, `meta?`, `actions?`, `accent?`, `onClick?` | Composes the badges |
| **Timeline** | Vertical event list | `items: {title,meta?}[]`, `empty?` | |
| **PlantName** | Canonical plant label (full name + code) | `code`, `variant?: stacked\|inline`, `className?` | Resolution in `lib/plantNames`; display-only — `plantId` stays the key everywhere; native `title` tooltip "FULL NAME (CODE)" |

## Shell & singletons

| Component | Purpose |
|---|---|
| **AppShell** (`AdminShell` alias) | Authenticated frame — see [04 — Layout](04-layout.md) |
| **Sidebar** / **TopBar** / **Footer** / **BrandLogo** | Shell parts — see [04](04-layout.md) |
| **nav.ts** — `buildNav(role)`, `ROLE_LABEL` | Role → grouped NavLink model (label/to/icon) |
| **SidebarContext** — `SidebarProvider`, `useSidebar`, `SIDEBAR_STORAGE_KEY` | collapse (persisted) + mobile drawer state |
| **SnapshotBanner** | Global freshness banner (`role="status"`/`role="alert"`, `aria-label="Snapshot status"`) |

## Page-local components (not shared — live beside their page)

Dashboard: ActionRequiredPanel, ZoneOverviewTable, CompanyPlantTable, ScorecardTable, EscalationQueueList, CriticalQueue/AssignControl, RunIngestionButton, ingestionEvents. Tickets: BucketBadge, InlineBadges (ticketBadges.tsx). ScheduleDetail: Stop, TicketRow, ReasonInput, SePicker, TicketStateBadges, WhySuggested. NonOp: MarkNonOperationalModal. Verification: OutcomeCell. Settings: 9 section components + SlaRulesTable + AccessMatrixGrid + local useList/Field. Help: HelpTopicGrid, GlossaryCard, buildHelpSections.

## Reusability summary

Fully reusable and used everywhere: Button, Badge, Card/SectionCard, Input/Field, DataTable, FilterBar/FilterSelect/SearchInput, MetricCard/Strip, PageHeader, EmptyState/ErrorState/Skeleton, Modal, StatusPill, SLABadge/DurationBadge, TierBadge, AgeChip, PlantName, chart wrappers. Built but lightly used: Sheet, Select, DropdownMenu, Tabs (shared version), TicketCard, Timeline, RadialGauge, EntityBadge. Legacy styling still to converge (uses raw slate/red classes instead of tokens): TicketDetailDrawer, LeaveRequestsPage, VerificationReviewPage table, SnapshotBanner.
