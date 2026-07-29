# 168 — Admin density pass + dark mode: kill the title card, fold filters into the table, tighten gutters, theme toggle

Status: done
Type: AFK

> Filed and executed 2026-07-28 from a five-point operator ask about the admin dashboard's use of
> space. Successor to [#160](./160-admin-table-chrome-ux-pass.md), which added the breadcrumb whose
> existence is what makes point 1 below safe.
>
> **Admin front-end only. No backend read, write, endpoint or query-parameter change.**

## The ask (operator, verbatim intent)

1. Every page carries a top card repeating the page name plus a sentence of description (e.g.
   `/tickets` → "Ticket Operations / Every open and recently-closed ticket in your zone, sorted by
   SLA urgency."). Remove the card entirely; relocate any action button it holds.
2. Pages with tables put search / sort / company / plant dropdowns in a **separate** card above the
   table. This wastes a band of page and separates a control from the thing it controls. Move them
   into the table's own card, above the table, arranged compactly.
3. Cards and tables carry heavy left/right margin. It reads unprofessional and starves the cells —
   on `/reports/device` a Device ID and an IMSI number each break across two lines.
4. The table row-hover wash is too faint to tell which row the cursor is on.
5. Add dark mode — a modern dark theme, compatible with every card and table, with the switch on
   the navbar.

## Settled decisions

- **The page title survives as an `sr-only` heading, not as nothing.** The breadcrumb's terminal
  crumb is a `<span aria-current="page">`, not a heading, so deleting the title outright would leave
  every page headingless for assistive tech — and eight test files assert on
  `getByRole('heading', …)`. `sr-only` costs zero vertical space, which is the whole of the ask.
- **`PageHeader`'s signature does not change.** Rendering behaviour changes in the one component;
  all 37 call sites stay as they are. `actions` still render, as a slim right-aligned row.
- **Dark mode is a token re-point, not a `dark:` sweep.** Every component already routes colour
  through `@theme` tokens (no raw hex is permitted), so overriding those variables under
  `:root[data-theme="dark"]` themes the whole app. Two `dark:` escapes exist where a token swap
  can't express the change (the top-bar avatar's tint/foreground pairing).
- **`system` is the default theme preference**, tracked live via `matchMedia`; an explicit choice
  pins and persists to `localStorage`.
- **Fixed-width `FilterSelect`.** Seven content-sized selects ("All assignment states" vs "Zone")
  wrapped to three ragged lines. Fixed width ellipsizes the long labels, which the open dropdown
  resolves.

## What landed

**S1 — title card removed.** `PageHeader` renders an `sr-only` title/subtitle plus, when present, a
borderless right-aligned actions row. `DashboardHero`'s equivalent slim title row went the same way.

**S2 — filters folded into the table card.** New `TableToolbar` (the strip inside a table card:
optional caps title, controls, `ml-auto` trailing slot) and a `toolbar` / `toolbarTitle` prop on
`DataTable` that renders it and shares the row with the existing download button. `FilterBar` is no
longer a card — it is a plain flex group for the few non-table clusters. Nine sites converted:
Tickets, Device Detail, Fleet Directory, Dispatch Batch Detail, Component-Blocked, Zone Overview,
Zone Unassignable, Zone Dispatch, Company/Plant Overview.

**S3 — gutters and density.** Shell `<main>` padding `p-4 sm:p-6 lg:p-8` → `px-3 py-4 sm:px-4
lg:px-5 lg:py-5`; `.enterprise-page` cap `1480px` → `1920px`; `DataTable` cell padding `px-4 py-3` →
`px-3 py-2.5` (auto) and `px-2.5 py-2.5` → `px-2 py-2` (fixed). The device list's identifier columns
lost their `break-all` and were re-sized from the widest real value (15-digit id/IMSI at 13%), with
`whitespace-nowrap` on the **value**, not the column — a `Column.className` lands on the `<th>` too,
and pinning the header stopped it wrapping and overflowed the labels into each other.

**S4 — row hover.** New `--color-row-hover` token, per theme, replacing `rgb(16 17 20 / 0.03)` in
the base layer and `hover:bg-surface-sunken/70` in `DataTable`.

**S5 — dark mode.** `@custom-variant dark`, a full `:root[data-theme="dark"]` token block,
`ThemeProvider` + `ThemeToggle` (a `role="switch"` two-position track in the top bar), and
`lib/applyStoredTheme.ts` called from `main.tsx` so a dark reload does not flash light. Chart chrome
(axis/grid/tick/cursor) moved from frozen hex to `var(--color-…)`; nine light-only escapes
(`bg-white`, `bg-slate-*`) routed through tokens.

**Incidental:** the top bar's search lacked `min-w-0`, so it could not absorb shrink and a long
breadcrumb wrapped "Assign SE" and "Log out" onto two lines. Fixed while adding the toggle.

## Follow-up round (same day, operator review of the dark theme)

Two defects the first pass shipped, both reported after looking at the running app:

1. **"The white text — make it more white."** The dark ink scale was a straight inversion
   (`ink-strong #f4f6fa`, `ink #d2d7e0`), which on a near-black canvas reads as dimmed. Raised to
   `ink-strong #ffffff` / `ink #e3e8f0` / `ink-muted #aab3c0` / `ink-caps #9aa4b3`, plus
   `chrome-text #e3e8f0`.
2. **"No red number in dark mode, only white."** Root cause: `text-brand-700` was doing double duty
   as both the primary button's gradient stop *and* the foreground for every drill-down count and
   inline link. In dark that resolves to `#a5122a` on `#16191f` — about 1.9:1. The Company/Plant
   Overview, which is nothing but those counts, rendered as a field of unreadable dark red.
   Fixed by **splitting the role into a `--color-link` token** (light `#8f0f24`, i.e. no light-mode
   change at all; dark `#ffffff`) and moving 18 foreground sites across 15 files onto it. The three
   `text-brand-700` sites left behind are text on a `brand-300` *fill* (`Badge`, `Toast`, the
   top-bar avatar), which is a different role and already correct in both themes.
   The Critical+ scorecard count moved from `text-critical` to the same token — it is the same
   drill-down-count role, and the severity is carried by the column header, not the ink.

**Deliberately still red:** `DispatchRunsPage`'s non-zero `errorCount` (`text-critical`). That is a
failure signal rather than a count-link, and dark `--color-critical` (`#e5484d`) is legible — so it
was left alone rather than swept up by the "only white" rule.

## Acceptance criteria

- [x] No page renders a boxed title/description card; every page still exposes its title as a heading.
- [x] A table's search/sort/filter controls render inside that table's card, above the table, sharing
      one strip with the download button.
- [x] Device ID and IMSI render on one line on `/reports/device`.
- [x] Row hover is a full surface step in both themes.
- [x] No drill-down count or inline link renders red on the dark canvas; body text reads as white.
- [x] A navbar switch toggles light/dark; the choice survives a reload; unset follows the OS.
- [x] `tsc --noEmit` clean; admin suite green (87 files / 367 tests).

## Follow-ups

- **Visual baselines are stale.** `visual/baseline/` predates this pass; every spec will diff. Re-run
  `pnpm --filter @fsm/admin visual:capture` and promote once the layout is signed off.
- **The `login` page has no theme toggle** — it is dark-on-dark by design and unaffected, but the
  switch only exists inside the authenticated shell.
