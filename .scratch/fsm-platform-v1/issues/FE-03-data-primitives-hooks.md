# FE-03 — Data primitives + async-state hooks

Status: done
Type: AFK · Frontend · Phase F0
Effort: M

> Governed by `DESIGN-SYSTEM.md` §5.2/5.7. Global DoD applies.

## What to build

The table/feedback recipe used by ~15 list pages, plus the async-state hooks that standardize today's
per-page `useEffect`+`alive` pattern. Build `DataTable`, `FilterBar`, `PageHeader`, `EmptyState`,
`ErrorState`, `Skeleton`, `Toast`, `DateRangeChips`; hooks `useApiResource`, `useAsyncAction`,
`useFilters`. Prove the recipe by fully reskinning `ComponentBlockedPage` to `17`.

## Dependencies

- FE-01

## Acceptance criteria

- [x] `useApiResource(fetcher, deps)` reproduces current fetch behavior, exposing `{data, loading, error, refetch}` with uniform Skeleton/Error/Empty handling
- [x] `useAsyncAction(fn)` drives `Button loading` + `Toast`; no new dependency added
- [x] `DataTable` supports columns, row-click, sort, zebra/row-accent/row-tint; preserves `role="table"` + `aria-label`
- [x] `ComponentBlockedPage` reskinned to `17` using the recipe; data path unchanged
- [x] `DateRangeChips` matches the `BEST/1D…YTD/DUAL RANGE` toolbar

## Reusable components introduced

- `DataTable`, `FilterBar`, `PageHeader`, `EmptyState`, `ErrorState`, `Skeleton`, `Toast`, `DateRangeChips`, `useApiResource`, `useAsyncAction`, `useFilters`

## Affected pages

- `ComponentBlockedPage` (proof; **[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/17-component-blocked-queue.png`

## Verification

- `component-blocked.test.tsx` green; Playwright ≈ `17`
