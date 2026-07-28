# Progress — Issue 160: admin table & chrome UX pass (breadcrumb, per-table download, S.No.)

> Build date: 2026-07-27/28 · Strict TDD (RED→GREEN), AFK.
> Status: **Slices 1–4 ACCEPTED** (all backend-untouched; AC-1..AC-22 met). **Slice 5 partial**:
> docs + INDEX done in this commit; visual baselines are a HITL gate and are **not** regenerated here —
> see "Slice 5 — what remains" below.
> Admin **86 files / 362 tests, exit 0**; `tsc --noEmit` clean throughout. `git diff --stat apps/backend`
> empty at every commit (AC-25).

## What changed, in one line each

1. **Breadcrumb.** `TopBar` now renders a real `Dashboard › … › {page}` breadcrumb
   (`resolveBreadcrumb`, off `buildNav` + a 6-entry detail-route table), retiring the stale
   `PAGE_TITLES`/`titleFor` prefix table and the "FSM Command Console" eyebrow.
2. **S.No.** Every `DataTable` (38 sites) plus the two bespoke drill-downs gained a leading,
   non-sortable serial-number column, injected in the render pass — never pushed into `columns`.
3. **Download.** Every in-scope table gained exactly one download control
   (`TableDownloadButton`, a single button + Radix dropdown over CSV/Excel/PDF/PNG), backed by a
   deliberate DOM read (`lib/tableExport.ts`) rather than a data-model read.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| AC-1..AC-7 | Breadcrumb resolves correctly for `/`, nav-matched routes, detail routes, longest-prefix, unmatched fallback; `PAGE_TITLES`/`titleFor` deleted, string gone | 🟢 | `test/breadcrumb.test.tsx` (7 tests); `grep -rn "FSM Command Console" apps/admin/src` → 0 hits |
| AC-8 | Reference deviation recorded in the three specifying docs | 🟢 | `DESIGN-SYSTEM.md:144`, `docs/ui-redevelopment/04-layout.md:43`, `retheme-2026-07-15-parity-checklist.md:18` all updated this commit |
| AC-9..AC-16 | One download control per table, 4 formats, post-sort export incl. S.No., disabled on loading/error/empty, bespoke levels export only their own level, no row/column-level export or checkboxes, 5 redundant page-level `ExportMenu`s removed, zero network calls during export | 🟢 | `test/table-download.test.tsx` (9 tests, RED-verified against the pre-Slice-3 `DataTable` via `git stash`); AC-16 asserted by a `fetch` spy |
| AC-17..AC-22 | S.No. leftmost, not sortable, re-numbers on sort (never pins), `snoOffset` correct on the one paged table, sub-tables number independently, fixed-width tables re-proportioned, loading/empty/error/expansion colSpans account for it | 🟢 | `test/datatable.test.tsx` (7 new cases, RED-verified) |
| AC-23 | Full admin suite green, `tsc --noEmit` clean | 🟢 | 86 files / 362 tests, exit 0; tsc clean, checked after every slice |
| AC-24 | Tokens only, no hand-rolled colours/spacing | 🟢 | toolbar recipe reuses `border-line`/`bg-surface-raised`/`text-ink-muted`/`rounded-card`, already in use elsewhere |
| AC-25 | `apps/backend/` untouched at every commit | 🟢 | `git diff --stat apps/backend` empty, checked before every commit |

## Slice-by-slice RED→GREEN report

- **Slice 1 — breadcrumb** (`2c5acda`). New `shell/breadcrumb.ts`: pure `resolveBreadcrumb`, no
  React, unit-testable without a router. RED: 2 of 7 `breadcrumb.test.tsx` cases failed (no
  `nav[aria-label="Breadcrumb"]`, old string still present) — the other 5 were pure-function
  assertions that passed as soon as the module was written, since the DOM-integration half is what
  actually depends on the `TopBar` edit. GREEN after replacing the eyebrow+title block.
- **Slice 2 — S.No.** (`0b366e1`). Injected in the `sorted.map` render pass, never in `columns`
  (would corrupt the sort lookup and the `tableLayout="fixed"` colgroup key map). RED confirmed by
  `git stash`-ing the `DataTable.tsx` change and re-running `datatable.test.tsx`: 6 of 16 failed for
  the right reasons (wrong colSpans, missing header/cells, no `snoOffset`). Sweep surfaced one
  ambiguity trap not in the issue's pre-computed list: `dispatch-runs.test.tsx` asserted a bare
  `getByText('2')` that now also matched the new S.No. cell — fixed by scoping the query to the
  errors cell's `.text-critical` class, not by loosening the selector.
- **Slice 3 — download** (`c66e1ec`). New `TableDownloadButton` + `lib/tableExport.ts`
  `extractTableExport`. The sort-arrow glyph (` ▲`/` ▼`) turned out to leak into exported header
  text on first pass — not called out in the issue — fixed by wrapping it in a
  `data-export-skip` span and having `extractTableExport` strip skip-marked descendants before
  reading `textContent`, rather than just filtering top-level cells. Removed the 5 redundant
  page-level `ExportMenu`s (`TicketsPage`, `DispatchBatchDetailPage`, `DeviceDetailPage`,
  `FleetDirectoryPage`, `ZoneOverviewTable`'s raw `downloadCsv`); `VoucherReviewPage`'s
  server-generated export and `api/exports.ts` are untouched, per decision 4.
- **Slice 4 — sweep + bespoke drill-downs** (`3b7de29`). Hand-wired `CompanyPlantTable` L1/L2/L3
  and `ZoneDispatchTable` L1/L2 (S.No. + `TableDownloadButton`, replacing their `ExportMenu`s where
  one existed). `ZoneDispatchTable`'s L1 interleaves company and plant rows in one physical
  `<table>` — not delineated into separate nested tables the way `CompanyPlantTable` is — so its
  S.No. is a single running counter spanning both row kinds, matched exactly in its export
  function's own traversal. Marked `exportable: false` on 13 action-only columns across the queue
  pages; set `downloadable={false}` on `InstallCreatePage`'s CSV-validation-errors table and
  `KitchenSink`'s dev demo table (decision 4). Fixed the two breakages the issue pre-computed
  (`company-plant-overview-rework.test.tsx`'s `cells[1]`/`cells[2]` → `cells[2]`/`cells[3]`;
  `dashboard-company-plant.test.tsx`'s stale two-control `ExportMenu` assertions) plus one it
  didn't: `dispatch-zone-detail.test.tsx`'s `plant.getByText('2')` collided with the new S.No. cell
  reading the same digit for an unrelated reason (row position vs. batch count) — fixed by scoping
  to the specific cell.

## Deviations / decisions (read before extending)

1. **The five hand-curated page-level exports had already drifted from their tables** (the issue's
   own evidence: `TicketsPage.tsx` declared 12 headers for an 11-column table, and mapped `rows`
   rather than the sort-aware `sorted`). Removing them in favour of the table's own DOM-derived
   export is intentional — the new export set is smaller/different in a few places (e.g.
   `TicketsPage` no longer exports a separate `Overridden` column; `DeviceDetailPage` no longer
   exports `Batch`, since neither is its own rendered column). Not a regression to chase.
2. **`ZoneDispatchTable` L1's S.No. numbering choice was not explicit in the issue.** Company rows
   and their (conditionally visible) plant child rows share one physical table and one running
   counter, rather than each getting an independent 1..n sequence — the cleanest reading of
   "numbers the current visible view from 1" for a single flat table that isn't split into parent/
   child sub-tables the way `CompanyPlantTable` is.
3. **Sort-arrow export leak and the `exportValue`/DOM-skip mechanism it required** were found
   during Slice 3, not anticipated by the issue's evidence section — recorded here so a future
   session doesn't mistake the fix (`data-export-skip` on the arrow span) for redesign of the
   deliberate DOM-read approach.

## Slice 5 — what remains

Done in this commit: the three design-system docs (AC-8), `SYSTEM-STATE-2026-07.md` §3k (edited in
place), this report, and one `INDEX.md` session-log line.

**Not done, by design (HITL gate):** the 28+ Playwright visual baselines under
`apps/admin/visual/baseline/` all change (every spec captures the topbar; most capture a table).
Per `docs/agents/workflow.md` and the issue's own Slice 5 trap, baselines are **not** blind-
regenerated — `npm run visual:compare` will report a wall of diffs, expected and not a regression,
and the operator reviews the diff before `npm run visual:capture` is run.
