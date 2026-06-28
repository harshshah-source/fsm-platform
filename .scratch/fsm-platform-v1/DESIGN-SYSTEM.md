# FSM Platform — Design System (Reference-Derived)

> **Authority:** the 38 reference screenshots under `docs/ui/desktop/v2-reference/` (28) and
> `docs/ui/mobile/` (10) are the **visual specification**. Every token below is reverse-engineered
> from patterns observed *consistently across* those screens, with the source screens cited.
> Where a pixel value cannot be measured exactly from the mockups, the closest implementation-friendly
> token is chosen and the reasoning is noted.
>
> **Two authorities, one implementation:** the **screenshots** are the *visual* authority; the
> **backend / APIs / routing / auth / RBAC / state / business logic** are the *application* authority.
> Where a mockup shows a superseded state (Approve gate, `REVIEW_PENDING`, `EXPECTED_BACK`,
> SE-Confirmation/`trust_score`) the application authority wins — match the *chrome*, bind to the
> *real state*. See `UI-RECOVERY-PLAN.md §6`.
>
> **Companion docs:** `UI-OWNERSHIP-PLAN.md`, `UI-RECOVERY-PLAN.md`, and the Frontend Master Plan.
> This document governs all FE-series issues.

---

## 0. How to read this document

- **Cited screens** appear as `[01,04,21]` = derived from those reference files.
- Disposition tags for the existing app: **[P]** preserve · **[R]** refactor · **[RP]** replace presentation · **[N]** new.
- All values are **tokens**; never hardcode hex/spacing in a component.

---

## 1. Brand & color palette

### 1.1 Brand (derived from `00-login`, every topbar logo, mobile red headers)
| Token | Value (derived) | Reasoning / source |
|---|---|---|
| `--brand-600` (primary) | `#C8102E` (crimson) | login "Faster.", Sign-In button, "+ Assign SE", all primary CTAs, mobile red header cards `[00, all topbars, mobile home/troubleshooting/vouchers]` |
| `--brand-700` (hover/press) | `#A60D26` | darker maroon on pressed states `[12 buttons]` |
| `--brand-300` (tint) | `#F6D7DC` | active-nav tint, light red chip backgrounds |
| `--brand-on` | `#FFFFFF` | text/icon on brand |

### 1.2 Chrome (dark sidebar / topbar logo / footer / login bg) `[all desktop, 00-login]`
| Token | Value | Source |
|---|---|---|
| `--chrome-900` | `#0E1422` | sidebar + footer base (near-black navy) |
| `--chrome-800` | `#161D2E` | login gradient, raised chrome |
| `--chrome-700` | `#222C42` | sidebar active-row bg, chrome borders |
| `--chrome-text` | `#C7CDDA` | inactive nav label |
| `--chrome-text-muted` | `#7B8499` | group headers, helper text |

### 1.3 Surfaces (content area) `[all desktop content, all mobile]`
| Token | Value | Source |
|---|---|---|
| `--surface-app` | `#F6F5F3` | **warm off-white** page bg (NOT pure white) — consistent on every content area + mobile |
| `--surface-card` | `#FFFFFF` | cards, tables, drawers |
| `--surface-sunken` | `#F1F0EE` | inset cells (mobile tech-health tiles, table zebra) |
| `--border-subtle` | `#E7E5E1` | card/table borders |
| `--border-strong` | `#D6D3CE` | dividers |

### 1.4 Text
| Token | Value | Source |
|---|---|---|
| `--text-strong` | `#161B26` | headings, KPI numerals |
| `--text-body` | `#374151` | body |
| `--text-muted` | `#6B7280` | labels, secondary cell text |
| `--text-caps` | `#8A93A3` | uppercase section/group labels |

### 1.5 Semantic + status palette (derived from pills across `[10,13,17,18,19,20,28]` + mobile)
Each status uses a **tinted bg + darker text** pill. The same hue means the same thing everywhere.

| Semantic token | Bg / Text | Meaning & observed labels | Source |
|---|---|---|---|
| `info` (blue) | `#E5EEFF` / `#1D4ED8` | started/ON_TRIP/Pending Acceptance/APPROVED/Verifying, mobile "Started" tile | `[10,13,18, mobile home/tickets]` |
| `success` (green) | `#E3F5E9` / `#197A3D` | Available-for-Repair/CLOSED/RECEIVED/OK/Approved/Completed | `[10,17,20,25, mobile inventory/daily-status]` |
| `verified` (violet) | `#EEE7FB` / `#6D28D9` | verification VERIFIED / SHIPPED / mobile "Verified" tile | `[18,28, mobile home]` |
| `warning` (amber) | `#FDF2D9` / `#9A6700` | WARNING/RISK bucket, WAITING_COMPONENT, TIMED OUT, acting banner, "Not on network" | `[02,10,13,17, mobile detail]` |
| `critical` (red) | `#FBE3E3` / `#B42318` | CRITICAL+ buckets, FAILED_VERIFICATION, DECLINED, ESCALATION REQUIRED, URGENT, REJECTED, "Failed" tile | `[10,13,18,28, mobile]` |
| `neutral` (gray) | `#EEEEF0` / `#4B5563` | STALE/UNKNOWN/NEW/UNASSIGNED | `[10,11,28]` |

### 1.6 SLA bucket ramp (derived from `04` SLA-Bucket-Distribution bar + `10/13` row accents)
8-step green→red ramp; **single source = `apps/admin/src/lib/slaBucket.ts`** (already exists `[P]`).
`WARNING`→`EARLY_RISK`→`RISK`→`CRITICAL`→`HIGH_CRITICAL`→`SEVERE`→`VERY_SEVERE`→`LONG_PENDING`
mapped green `#3Fae6a` → lime → amber → orange `#F08A24` → red `#E0492E` → deep-red `#B42318` → maroon `#7A1B12` → gray-violet (long-pending). Used by `SLABadge`, the distribution bar `[04]`, and row left-accents `[10,13]`.

### 1.7 Tier badges `[01,02,03,04 company/plant tables, 07,28]`
Small letter chips: `A` = teal/green, `B` = blue, `C` = gray. Also rendered as a colored dot + letter.

---

## 2. Typography `[derived from titles/KPIs/labels across all screens]`

| Role | Size / Weight / Line | Usage | Source |
|---|---|---|---|
| Display (KPI numeral) | 28–32px / 700 / 1.1 | metric-card numbers, mobile stat tiles | `[01,04,21, mobile home]` |
| Page title | 22–24px / 700 / 1.2 | "Zone Operations Dashboard", "Reports", "Ticket Detail" | `[all page headers]` |
| Section title | 15–16px / 600 / 1.3 | card headers ("Component Request Queue") | `[05,17,18]` |
| Caps label | 11–12px / 600 / 1.4 / +0.06em tracking / uppercase | KPI labels, table headers, group nav headers, "NEXT VISIT" | `[everywhere]` |
| Body | 14px / 400 / 1.5 | descriptions, cell primary | — |
| Table cell secondary | 12–13px / 400 / 1.4 / muted | two-line cell subtitle | `[07,10,28]` |
| Mono-ish ID | 13px / 500 / tabular | TKT-/GPS-/device IDs | `[07,10,13,28]` |

**Family:** Inter (or system `ui-sans-serif`) — the mockups use a neutral grotesque; Inter is the closest implementation-friendly match. Tabular-nums for numeric table columns.

---

## 3. Spacing, grid, radius, elevation

### 3.1 Spacing scale (4px base) `[measured proportionally]`
`xs 4 · sm 8 · md 12 · lg 16 · xl 24 · 2xl 32`. Card padding `16–24` (`lg`/`xl`); section gap `16–24`; table row vertical `8–10`; KPI strip gap `12–16`.

### 3.2 Grid
- **Desktop:** sidebar (fixed) + fluid content. Content max ≈ full width with `24px` gutters. KPI strips are **4–6 equal columns** `[01=4/5, 04=4, 21=6]`. Two-column analytics/detail splits ≈ **2fr / 1fr** (detail: evidence left, Manager Controls right `[08,09]`; reports: chart left, breakdown right `[23,24]`).
- **Mobile:** single column, `16px` screen padding; icon-select grids = **2 columns**; stat tiles = **3–4 columns** `[mobile troubleshooting/inventory/home]`.

### 3.3 Radius
| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | 6px | inputs, small buttons |
| `--radius-md` | 8–10px | cards, table container, KPI cards `[desktop]` |
| `--radius-lg` | 14–16px | mobile cards, mobile primary buttons `[mobile]` |
| `--radius-full` | 9999px | pills, badges, avatars, search field |

### 3.4 Elevation / shadow
| Token | Value | Usage |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(16,20,34,.06)` + 1px border | cards, KPI tiles (subtle — mockups are flat-ish) |
| `--shadow-md` | `0 4px 12px rgba(16,20,34,.10)` | mobile cards, popovers |
| `--shadow-lg` | `0 12px 32px rgba(16,20,34,.18)` | drawer `[28]`, modals |
| sidebar/footer | none (flat) | chrome is flat |

### 3.5 Surface hierarchy
`app bg (warm) → card (white, border + shadow-sm) → sunken cell (gray) → pill (tinted)`. Never card-on-app without a border or shadow.

---

## 4. Layout primitives (chrome)

### 4.1 Sidebar `[all desktop]` — **[RP]** of `AdminShell` nav
- Width **≈ 216px** fixed; bg `--chrome-900`; full height; flat.
- Header: red logo mark + "autoplant systems" (white, 14px/600) + "FIELD MANAGEMENT SYSTEM" (`--chrome-text-muted`, 9px caps).
- Grouped items under caps headers: **OPERATIONS · COMPONENTS & WAREHOUSE · ANALYTICS · ADMIN** `[01 vs 05 vs 04]`. Item = 16px icon + 13px label, row height ≈ 34px.
- **Active:** `--chrome-700` bg + 3px `--brand-600` left bar + white text. **Inactive:** `--chrome-text`, hover lightens.
- Role-scoped: Warehouse sees only Dashboard/Component Requests/Shadow Use/Warehouse Stock/Help `[05]`; managers see Operations+Analytics; Ops-Head adds Admin/Settings. **Reuses existing role logic** in `AdminShell`.
- Footer-of-sidebar: tiny muted helper text.

### 4.2 TopBar `[all desktop]` — **[N]**, fed by existing `useAuth().session`
- Height ≈ 52px, `--surface-card`, border-bottom.
- Left: breadcrumb `FSM Command Console › {page}` (muted › strong).
- Center: full-width rounded search, magnifier icon, placeholder "Search ticket, vehicle, plant, device…".
- Right: red **`+ Assign SE`** button · `Raise Concern` · `Support` · `Settings` gear · bell (red dot) · **user chip** = avatar + two-line `{Role} / {Zone}` `[ZM=West Zone, Ops-Head, WM=Zone Warehouse]`.

### 4.3 Acting banner `[02]` — **[RP]** existing amber banner
Full-width amber strip under topbar: "Backup Coverage Active — acting as Zonal Manager for {zone}", exit control. Keep existing `actingZone` logic + `acting-banner.test.tsx` selectors.

### 4.4 Footer `[all desktop]` — **[N]**
Dark (`--chrome-900`) multi-column: "autoplant systems / FIELD MANAGEMENT SYSTEM" blurb + link columns (Command Center · Planning · Warehouse · Governance · Support) + bottom status row (Admin Console v2.0 · Role-gated · Live operations · {zone scope}).

### 4.5 Global filter toolbar `[04,15,16,17,18,19,20,21,22,23,24,25,26]` — **[N] `DateRangeChips`**
Pill row: `BEST [SET]` + `1D 7D 14D 1M 3M 6M 12M YTD` + `DUAL RANGE` + role label. Small caps; active chip = filled.

---

## 5. Component anatomy (canonical specs)

> For each: **appears on** (screens) · **derived from** · **variants** · **states** · **canonical use** · **disposition** · **selector contract**.

### 5.1 MetricCard / MetricStrip `[01,02,03,04,05,13,15,17,18,19,20,21,22,23,24,25]`
- Anatomy: white card, optional left color accent **or** small tinted icon; caps label (top), display numeral, delta/subtext (`↑5%`, "vs last", split sub-stats). Strip = 4–6 equal cols.
- Variants: `accent` (color bar) · `icon` · `split` (two sub-metrics) · `compact` (reports 6-up).
- States: loading (skeleton numeral), empty ("—").
- Canonical: **all** KPI rows use `MetricStrip`; never bespoke.
- Disposition **[N]**.

### 5.2 DataTable `[07,10,11,13,15,17,18,19,20,21,22,25,26,28, dashboards]`
- Dense rows (~38px), caps header, border-bottom rows, hover tint, optional **left row-accent** by severity `[10,13]` and **row tint** for critical rows.
- Cell renderers: text, two-line (bold+muted), `IDcell` (mono), `SLABadge`, `StatusPill`, `TierBadge`, `AgeChip` (e.g. `14d` colored), action buttons (right-aligned).
- Variants: `selectable` · `rowAccent(row)` · `rowTint(row)` · `stickyHeader`.
- States: loading (`Skeleton` rows), empty (`EmptyState`), error (`ErrorState`).
- Canonical: every list/queue. Preserve `role="table"` + `aria-label`.
- Disposition **[N]** (replaces ~15 bespoke `<table>`s).

### 5.3 StatusPill / SLABadge / TierBadge / AgeChip `[10,13,17,18,19,20,28, mobile]`
- Rounded-full, tinted bg + dark text, 11–12px caps, optional leading dot.
- `StatusPill tone` from §1.5; `SLABadge bucket` from `lib/slaBucket` `[P source]`; `TierBadge` A/B/C `[§1.7]`; `AgeChip` colored by SLA severity.
- Canonical everywhere a status/bucket/tier/age renders. Disposition **[N]**, badge colors reuse existing `CR_STATUS_CLASS`/`slaBucket`.

### 5.4 Sheet (Drawer) `[28]` + Modal/Dialog
- Right slide-over ≈ 420–480px over dimmed backdrop `[28]`; `--shadow-lg`; header (title + close) + `Tabs` + body.
- Modal: centered confirm/form (replaces `window.prompt`).
- Canonical: Ticket Detail drawer, all confirm/reason flows. Preserve `aria-label="Ticket detail"`, `role="tab"`, `data-testid="recovery-manual-close"`.
- Disposition **[N]** wrappers; **[RP]** existing `TicketDetailDrawer` body.

### 5.5 Ticket Detail composition `[08,09,28]`
- Header band: big ID (`TKT-…`) + meta chip row (device·plant·company·tier·zone) + **status-tile row** (primary SLA clock, secondary clock, assignability, assigned SE) — tiles with colored left accent.
- Tabs → two-column: left **Reasoning Evidence** + **Dispatch & Field History** panels; right **Manager Controls** panel (Reassign/Override/Force-Verify — **READ ONLY for Ops-Head `[09]`**) + **Critical Facts** list + **Report/Escalation**.
- Bind controls to existing role logic; superseded states omitted per fidelity rule.

### 5.6 Charts `[21,22,23,24,25, mobile home/daily-status]` — **[N]** recharts wrappers
- `BarChartCard` (horizontal, rounded ends, value labels): "Inactivity by SLA bucket" (red ramp), "Root-cause distribution" (multi-color) `[21,23]`.
- `StackedBar`: "Work type mix" `[21]`; **`DistributionBar`**: full-width segmented SLA heat-ramp `[04]`.
- `DonutChart`/`RadialGauge`: verification outcomes `[21]`, plant workload % `[mobile home]`.
- `TrendChart`: device lifetime downtime per-month bars `[22]`, assigned-vs-completed daily `[mobile home]`.
- Tokenized colors, minimal gridlines, caps axis labels, `summary table` toggle `[22]`.

### 5.7 Cards / PageHeader / FilterBar / EmptyState / ErrorState / Skeleton / Toast / Tabs
- `PageHeader`: title + muted subtitle + right actions + optional "Snapshot Healthy" chip `[04,05]`.
- `SectionCard`: white card, caps title, optional header action.
- `FilterBar`: `Select`/`Input`/`DateRangeChips` row `[07,10,21,26]`.
- `EmptyState`/`ErrorState`/`Skeleton`: standardize today's ad-hoc "Loading…"/`setError`.
- `Toast`: async feedback (replaces silent errors).
- `Tabs`: drawer + Settings + reports; preserve `role="tab"`/`aria-selected`.

---

## 6. Mobile component kit (RN/Expo — separate app, shared tokens via NativeWind)

| Component | Anatomy | Source |
|---|---|---|
| `BottomTabBar` | Home/Tickets/Stock/Vouchers/Profile, icon+label, active red | `[all mobile]` |
| `ContextHeaderCard` | red card: caps kind + big reg + status pill + chips + sub-stats | `[ticket-detail-ready, troubleshooting, vouchers, daily-status]` |
| `StatTile` | solid-color rounded tile, numeral + icon + caps label (blue/green/violet/red) | `[home, inventory, daily-status]` |
| `TicketCardMobile` | left severity bar, letter avatar, reg, plant·zone, device+age, status pills, Call/WhatsApp | `[tickets-priority-view]` |
| `IconSelectGrid` | 2-col selectable chips, selected = red fill | `[troubleshooting]` |
| `ChecklistRow` | circle-check icon + title + optional pill | `[verification]` |
| `TechHealthGrid` | labeled mini-cells, some tinted; 3 status mini-tiles | `[ticket-detail-ready]` |
| `PhotoCaptureRow` | Before/After/Part/Plate tiles | `[troubleshooting]` |
| `OutcomeChips` | 2×2 Closed/Failed/Partial/Escalated | `[verification]` |
| `DonutStat` | donut with center % + progress bar + counts | `[home plant workload]` |
| `PrimaryActionButton` | full-width red, often sticky bottom | `[all mobile]` |
| `HierarchyCard` | nested reporting cards, manager highlighted blue | `[profile]` |
| `TimelineCard` | dotted vertical events | `[ticket-detail-ready]` |

---

## 7. States, motion, accessibility, responsive

- **Loading:** Skeletons (table rows, KPI numeral), never layout shift. **Empty:** `EmptyState` (icon + message). **Error:** `ErrorState` (message + retry) + `Toast`.
- **Motion:** 150–200ms ease for hover/drawer/toast/tab; donut/bar enter ≤300ms; respect `prefers-reduced-motion`.
- **Icons:** `lucide-react` (web) / `lucide-react-native` (mobile); nav 16px, inline 14–16px, status dots 8px.
- **Accessibility:** Radix primitives (focus trap, keyboard, `aria-*`); color never sole signal (pills carry text); verify AA contrast for brand-red on dark chrome and on white.
- **Responsive:** desktop-dense, target ≥`lg`; sidebar collapses to icons `<lg`; KPI strip wraps 6→3→2; tables horizontally scroll `<md`. Mobile is RN (separate). **Dark mode:** reference uses dark-chrome + light-content only; full dark mode **deferred** (not in references).

---

## 8. Page → reference → composition map (no page-specific UI when a component suffices)

| Route / page | Reference | Composed from |
|---|---|---|
| `/login` | `00` | `AuthLayout` + `Input` + `Button` + `StatTile` |
| `/` ZM + variants | `01·02·03·04·05` | `AppShell` + `MetricStrip` + `ActionRequiredCard` + `DataTable` + `TicketCard` + `DistributionBar`(04) + `DonutChart` |
| `/tickets` | `07` | `PageHeader` + `FilterBar` + `DataTable`(SLABadge/StatusPill/TierBadge) |
| `/tickets/:id` | `08·09·28` | `Sheet` + `Tabs` + status-tile row + Manager-Controls/Critical-Facts cards + `Timeline` |
| `/schedules`(+detail) | `12` | `MetricStrip` + SE list + `TicketCard` board (no Approve gate) |
| `/intraday` | `13` | `MetricStrip` + `DataTable`(rowAccent + StatusPill) |
| `/engineers` | `15` | `MetricStrip` + `DataTable` + `StatusPill` |
| `/engineers/planner` | `16` | `MetricStrip` + `PlannerGrid` |
| `/readiness/vehicle-unavailability` | `10·11` | `MetricStrip` + `DataTable`(dual-clock cells, StatusPill) |
| `/component-blocked` · `/warehouse/requests` · `/component-requests` · `/warehouse/shadow-use` · `/warehouse/recovery-receipt` · `/readiness/recovery-decisions` · `/readiness/non-operational` | `17·18·19·20` | **one recipe:** `MetricStrip` + `FilterBar` + `DataTable` + `StatusPill` + action `Modal` |
| `/verification` | `14` | `MetricStrip` + `DataTable` + `DonutChart` + `StatusPill` |
| `/settings` | `26` | `Tabs` + zone-config `DataTable` + access-matrix grid + SLA-rules table + `DateRangeChips` |
| `/coverage` | (org) | `DataTable` (+ deferred polygon editor) |
| `/reports/*` (FE-21…25) | `21·22·23·24·25` | `MetricStrip` + `BarChartCard`/`DonutChart`/`TrendChart` + `DataTable` |
| Help Center | `27` | grouped `SectionCard` topic grid + glossary cards |
| Warehouse dashboard | `05` | role-variant of `/` + scoped nav |
| Mobile (Issue 54 + M-series) | all mobile | §6 kit |

---

## 9. Reconciliation rules (visual authority ⇄ application authority)

1. **Chrome = screenshots; content/state = backend.** Never render a state the backend doesn't expose.
2. **Documented omissions** (mockup shows, backend dropped): Batch "Approve" gate `[12]`; `REVIEW_PENDING`/SE-Confirmation/`trust_score` `[08]`; `EXPECTED_BACK` readiness `[10]`. Render the surrounding chrome, omit the dead control, note it in the page's FE issue.
3. **Single source for SLA colors** = `lib/slaBucket.ts`; for CR status colors = existing `CR_STATUS_CLASS`. Promote, don't duplicate.
4. **Preserve selector contract** — `role`/`aria-label`/`data-testid`/visible text asserted by `apps/admin/test/*` survive every swap.
5. **Components over page-specific markup** — if two pages need the same shape, build/extend the shared component first.

---

## 10. Token implementation note

Tokens land as **Tailwind v4 `@theme` CSS variables** in `apps/admin/src/index.css` (extends the current single `@import "tailwindcss";`). One token file → every component → every page. Mobile mirrors the same token values via NativeWind. No component may introduce a raw hex or off-scale spacing value.
