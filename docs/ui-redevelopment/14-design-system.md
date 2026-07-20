# 14 — Current Design System

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [13 — Dialogs](13-dialogs.md) · Next: [15 — Dependencies](15-dependencies.md).

Everything below is defined in **`apps/admin/src/index.css`** as Tailwind v4 `@theme` variables (each `--color-*`/`--radius-*`/`--shadow-*` becomes a utility: `bg-surface-card`, `rounded-card`, `shadow-card`, …). The stated house rule: **no component may introduce a raw hex or off-scale value — everything routes through these tokens.** (Known legacy exceptions using raw slate/red/amber palette classes: SnapshotBanner, TicketDetailDrawer, LeaveRequestsPage, VerificationReviewPage, ticketBadges, `BUCKET_CLASS`.)

## Color tokens

| Group | Token | Hex | Use |
|---|---|---|---|
| Brand (crimson) | `brand-300` | `#f3cbd3` | tints, ::selection |
| | `brand-600` | `#b9102b` | primary buttons, active chips, focus ring |
| | `brand-700` | `#8f0f24` | button gradient end, links |
| | `brand-logo` | `#b91c1c` | AutoPlant wordmark ONLY (pinned to legacy logo — never merge with brand scale) |
| Chrome (dark navy) | `chrome-900` | `#10131b` | sidebar, footer, login bg, overlay backdrops |
| | `chrome-800` | `#171b27` | login card, tooltips |
| | `chrome-700` | `#252a3a` | chrome dividers |
| | `chrome-text` | `#d9d3c7` | text on chrome |
| | `chrome-muted` | `#9c9385` | muted text on chrome |
| Luxury (gold accent — used sparingly) | `luxury-100` | `#fbf4e5` | ghost-button hover, avatar bg |
| | `luxury-300` | `#ead19a` | active-nav accent, login focus ring |
| | `luxury-600` / `luxury-700` | `#a97926` / `#7c5719` | eyebrow text, avatar text |
| Surfaces (warm off-white — **not pure white**) | `surface-app` | `#f8f6f1` | page bg (via body gradient) |
| | `surface-card` | `#fffdfa` | cards, tables, inputs, topbar |
| | `surface-raised` | `#fbf8f2` | table headers, section header bands |
| | `surface-sunken` | `#f1ece2` | hovers, wells, group rows |
| Lines | `line` | `#e7dfd0` | default border |
| | `line-strong` | `#d5c7ae` | hover border, scrollbar thumb |
| Ink | `ink-strong` | `#171a22` | headings, emphasized values |
| | `ink` | `#343946` | body text |
| | `ink-muted` | `#6f6b63` | secondary text, placeholders |
| | `ink-caps` | `#908574` | caps table headers / section eyebrows |
| Semantic (fg + `-bg` tint pair) | `info`/`info-bg` | `#1d4ed8`/`#e5eeff` | informational |
| | `success`/`success-bg` | `#197a3d`/`#e3f5e9` | positive |
| | `verified`/`verified-bg` | `#6d28d9`/`#eee7fb` | verification purple |
| | `warning`/`warning-bg` | `#9a6700`/`#fdf2d9` | caution |
| | `critical`/`critical-bg` | `#b42318`/`#fbe3e3` | danger |
| | `neutral`/`neutral-bg` | `#4b5563`/`#eeeef0` | default chip |

Body background: `radial-gradient(gold tint at top-left) + linear-gradient(#fbfaf7 → surface-app)`.

### Chart colors (`components/charts/colors.ts` — hex mirrors, keep in sync)
`CHART = { brand #c8102e, info #1d4ed8, success #197a3d, verified #6d28d9, warning #d99100, critical #b42318, criticalDeep #7a1b12, neutral #94a3b8, axis #8a93a3, grid #e7e5e1 }`; `CHART_PALETTE` = [brand, info, success, verified, warning, neutral].

### SLA bucket ramp (`lib/slaBucket.ts` — the single SLA color source)
`BUCKET_CLASS` (Tailwind classes, deepest red at top): LONG_PENDING `bg-red-900` · VERY_SEVERE `bg-red-700` · SEVERE `bg-red-500` · HIGH_CRITICAL `bg-orange-500` · CRITICAL `bg-amber-400` · RISK `bg-yellow-300` · EARLY_RISK `bg-lime-200` · WARNING `bg-slate-200`. `BUCKET_HEX` (charts): `#6d28d9, #8f1d12, #c4341f, #e0492e, #f08a24, #eab308, #9acd32, #3fae6a`. Range labels (`4–8h`…`7d+`) are **derived from shared `SLA_BANDS`** — never hardcode.

## Typography

- Font: **Inter**, system fallback stack (`--font-sans`); features `cv02 cv03 cv04 tnum` (tabular numerals globally); antialiased, optimizeLegibility.
- Scale in practice: page title `text-2xl font-semibold tracking-tight`; card/section titles `0.82rem–base font-semibold`; body `text-sm`; secondary `text-xs`; **caps-label idiom** `text-[10px]–[11px] font-semibold uppercase tracking-wider text-ink-caps` (table headers th default: 0.6875rem/700/0.08em caps); KPI value `text-2xl font-bold tracking-tight`.

## Spacing & radius

- Tailwind default 4px scale. Page padding `p-4 sm:p-6 lg:p-8`; card body `p-5 sm:p-6`; table cells `px-4 py-3`; section rhythm `mb-6`/`mb-8`; grid gaps `gap-3`/`gap-4`/`gap-6`.
- Radius: `--radius-card: 0.5rem` (`rounded-card`) for cards/tables/modals; `rounded-md` controls; `rounded-full` pills/chips.

## Elevation

- `--shadow-card`: inset white top-light + soft double drop (cards, topbar).
- `--shadow-card-hover`: deeper lift (card hover).
- `--shadow-floating`: `0 22px 70px rgb(16 19 27 / .28)` (sidebar mobile, modals, popups).
- Utility `.premium-panel`: white gradient wash + card shadow (Card, Modal).

## Component looks (summary — full specs in [07](07-components.md))

- **Buttons**: primary = brand red vertical gradient + white text; secondary = bordered card surface; danger = critical tint; ghost = text + luxury hover. Heights 32/36/44px, semibold, `active:translate-y-px`.
- **Inputs/selects**: h-10 (h-9 filters), `border-line` on `surface-card`, hover `border-line-strong`, focus `border-brand-600` + focus ring.
- **Cards**: `premium-panel` + `border-line/90`, hover border-strong + lifted shadow. SectionCard header: gradient band `surface-raised → surface-card → luxury-100/45` + hairline.
- **Tables**: caps headers on `surface-raised`, hairline row borders, warm hover tint (`rgb(251 244 229 / .42)` global tbody rule).
- **Badges/pills**: rounded-full, caps 0.68rem semibold, tinted bg + same-hue text + inset ring.
- **Icons**: 16–18px stroke-2 `currentColor` inline SVGs.
- **Alerts**: tinted boxes/paragraphs with `role="alert"`; toasts bottom-right.

## Focus & motion

- `.focus-ring` utility = `focus-visible:ring-2 ring-brand-600/35 ring-offset-2 ring-offset-surface-app` — applied to every interactive element.
- Global control transitions: 180ms `cubic-bezier(0.2, 0, 0, 1)`.
- Named animations: `ingest-glow` (pulsing red box-shadow) + `ingest-word-in` (verb fade) for the live ingestion button; `animate-pulse` skeletons; sidebar `transition-[transform,width] duration-300`; RollingNumber JS ease-out-cubic count-up.
- **`prefers-reduced-motion: reduce` collapses ALL animation/transitions globally** (must keep).
- `::selection` brand-tinted; custom 10px scrollbars (`line-strong` thumb).

## Utilities defined in index.css

`.enterprise-page` (1480px centered), `.premium-panel`, `.soft-divider`, `.focus-ring`, `.ingest-live`, `.ingest-word`. Plus `@source inline` safelist for `grid-cols-{1..6}`, `sm:grid-cols-{2,3}`, `lg:grid-cols-{3..6}` (MetricStrip picks columns from a prop — **keep the safelist or the grids silently fall back to 2-up**).

## Dark mode / theme provider

**None.** Light-only tokens; no `ThemeProvider`, no `data-theme`, no CSS-var switching at runtime. The login screen is a hard-coded dark composition, not a theme. A redesign may introduce theming, but the current app has no plumbing for it.

## Design-system source docs

Token derivation and documented omissions live at `.scratch/fsm-platform-v1/DESIGN-SYSTEM.md`; authoritative screen references at `docs/ui/desktop/v2-reference/`.
