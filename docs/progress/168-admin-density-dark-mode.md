# 168 — Admin density pass + dark mode — completion report

**Date:** 2026-07-28 · **Branch:** `feat/autoplant-integration` · **Scope:** admin front-end only —
no backend read, write, endpoint or query-parameter change.

Five operator points, one pass. Issue: `.scratch/fsm-platform-v1/issues/168-admin-density-dark-mode.md`.

---

## 1 — The per-page title card is gone

`PageHeader` (`components/data/PageHeader.tsx`) stopped rendering its boxed title/subtitle banner. It
now emits the title and subtitle inside an `sr-only` block plus, when the page passes any, a
borderless right-aligned actions row.

The title is kept rather than deleted for two reasons that point the same way: the top bar's
breadcrumb (landed in #160) is a `<span aria-current="page">`, not a heading, so removing the last
heading would leave every page anonymous to a screen reader; and eight test files assert on
`getByRole('heading', …)` for page titles. `sr-only` costs zero vertical space, which was the whole
of the ask.

**The prop signature did not change**, so none of the 37 call sites were edited. `DashboardHero`'s
equivalent slim title row (itself a previous de-carding of `PageHeader`) went the same way.

## 2 — Filters live in the table card

New `components/data/TableToolbar.tsx`: the strip that runs along the top of a table card, holding
that table's own controls. Optional caps title on the left, filter controls flowing, `ml-auto`
trailing slot for the download button — so filters and download share **one** strip instead of each
claiming a band of page.

`DataTable` gained `toolbar` and `toolbarTitle` props that render it. The two bespoke `<table>`
drill-downs use `TableToolbar` directly, inside their existing card wrapper.

`FilterBar` was demoted from a bordered card to a plain flex group (it survives for the few control
clusters that do not belong to a table). `SearchInput` and `FilterSelect` dropped to `h-8` /
`text-[13px]`, and `FilterSelect` became fixed-width: seven content-sized selects ("All assignment
states" being far wider than "Zone") wrapped onto three ragged lines.

Nine sites converted: Tickets, Device Detail, Fleet Directory, Dispatch Batch Detail,
Component-Blocked, Zone Overview, Zone Unassignable, Zone Dispatch, Company/Plant Overview.

On Device Detail this also collapsed three stacked blocks (a lone search `Field`, a bordered
`FilterBar`, then a `ChartCard`-wrapped table) into one card.

## 3 — Gutters and density

| | Before | After |
|---|---|---|
| Shell `<main>` padding | `p-4 sm:p-6 lg:p-8` | `px-3 py-4 sm:px-4 lg:px-5 lg:py-5` |
| `.enterprise-page` cap | `1480px` | `1920px` |
| `DataTable` cell pad (auto) | `px-4 py-3` | `px-3 py-2.5` |
| `DataTable` cell pad (fixed) | `px-2.5 py-2.5` | `px-2 py-2` |

The reported symptom — Device ID and IMSI breaking across two lines on `/reports/device` — was
`break-all` on those columns plus widths too small to hold the value. Columns were re-proportioned
from the widest **real** value (a 15-digit id at 13px tabular needs ~123px plus padding → 13%), and
`break-all` was replaced with `whitespace-nowrap`.

One trap worth recording: a `Column.className` is applied to the `<th>` **as well as** the `<td>`.
Putting `whitespace-nowrap` there stopped the header labels wrapping and overflowed them into each
other ("VEHICLE NUMBEDEVICE TYPIMSI NO"). The nowrap belongs on the rendered value, leaving the
header free to wrap.

## 4 — Row hover

New `--color-row-hover` token, defined per theme. It replaces `rgb(16 17 20 / 0.03)` in the base
layer (which every table inherits) and `hover:bg-surface-sunken/70` in `DataTable`. Light `#dae0e9`,
dark `#2b323e` — a full surface step rather than a film.

## 5 — Dark mode

The design system's standing rule that no component may carry a raw hex is what made this cheap:
dark mode is a **re-point of the same token names** under `:root[data-theme="dark"]`, not a `dark:`
sweep across the tree. `:root[data-theme="dark"]` (0,2,0) outranks Tailwind's `:root` (0,1,0), so it
wins regardless of source order.

- Blue-cool near-black canvas with genuinely raised card surfaces; `chrome-*` sits *lighter* than the
  canvas, because on a dark page an elevated rail reads as chrome where a darker one reads as a hole.
- Semantic foregrounds lifted to mid-scale — each has to survive both as text on the dark card and as
  a fill with white text (`DataTable`'s `danger` active row is `bg-critical text-white`).
- `ThemeProvider` / `ThemeToggle` (`role="switch"` two-position track in the top bar). Default
  preference is `system`, tracked live via `matchMedia`; an explicit choice pins to `localStorage`.
- `lib/applyStoredTheme.ts` runs from `main.tsx` before React mounts, so a dark reload does not flash
  the light canvas.
- Chart *chrome* (axis / grid / ticks / tooltip cursor) moved from frozen hex to `var(--color-…)`.
  Chart *series* colours stay literal: they are semantic, must stay distinguishable from each other
  rather than from the background, and sit mid-scale so they read on both canvases.
- Nine light-only escapes (`bg-white`, `bg-slate-*`, `text-slate-*`) routed through tokens. Exactly
  two `dark:` variants remain, both on the top-bar avatar's tint/foreground pairing.

## Follow-up round — operator review of the dark theme

Two defects the first pass shipped, both caught by looking at the running app.

**"The white text — make it more white."** The dark ink scale was a straight inversion
(`ink-strong #f4f6fa`, `ink #d2d7e0`). On a near-black canvas that reads as dimmed rather than white.
Raised to `ink-strong #ffffff` / `ink #e3e8f0` / `ink-muted #aab3c0` / `ink-caps #9aa4b3`, plus
`chrome-text #e3e8f0` — table content is white first, grey only where genuinely secondary.

**"No red number in dark mode, only white."** `text-brand-700` was doing double duty: the bottom stop
of the primary button's gradient *and* the foreground for every drill-down count and inline link. The
two roles diverge in dark — the gradient stop must stay a deep crimson, but the same crimson as a
foreground is `#a5122a` on `#16191f`, about **1.9:1**. The Company/Plant Overview, which is nothing
but those counts, rendered as a field of unreadable dark red.

Fixed by splitting the role into a **`--color-link`** token — light `#8f0f24` (byte-identical to the
old value, so light mode did not move at all), dark `#ffffff`. Eighteen foreground sites across
fifteen files moved onto it. The three `text-brand-700` sites left behind are text on a `brand-300`
**fill** (`Badge`, `Toast`, the top-bar avatar): a different role, already correct in both themes.
The Critical+ scorecard count moved off `text-critical` onto the same token — same drill-down-count
role, and the severity is carried by the column header rather than the ink.

**Deliberately still red:** `DispatchRunsPage`'s non-zero `errorCount`. That is a failure signal, not
a count-link, and dark `--color-critical` (`#e5484d`) is legible — so it was left alone rather than
swept up by the "only white" rule. Say the word if you want that one white too.

## Incidental

The top bar's search wrapper lacked `min-w-0`, so it could not shrink below the input's intrinsic
size. On a long breadcrumb (`Dashboard › Reports › Fleet Directory`) the overflow was pushed right
and wrapped the "Assign SE" and "Log out" labels onto two lines. Fixed while adding the toggle.

## Verification

- `tsc --noEmit` clean; `vite build` clean.
- Admin suite **87 files / 367 tests green**, including a new `test/ui-shell-density.test.tsx`
  (5 tests: the title card is gone but the heading is not; actions still render; toolbar controls sit
  in the table's card ahead of the table and share the strip with Download; the toggle flips
  `data-theme` and persists; a stored preference is restored on mount).
- `test/breadcrumb.test.tsx` gained `ThemeProvider` — `TopBar` now genuinely depends on it, exactly
  as it already depended on `SidebarProvider`.
- Driven live at 1440px in **both themes** against the running dev stack on `/tickets`,
  `/reports/device?zoneId=1&status=INACTIVE`, `/reports/fleet` and `/`.

## Follow-up

**`apps/admin/visual/baseline/` is stale.** Those PNGs predate this pass, so every spec in the
visual-parity harness will diff. Re-run `visual:capture` and promote once the layout is signed off.
Not done here: promoting baselines is a sign-off action, not a build step.
