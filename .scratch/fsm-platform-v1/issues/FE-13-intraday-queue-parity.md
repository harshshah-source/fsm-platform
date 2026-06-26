# FE-13 — Intra-day Queue parity

Status: done
Type: AFK · Frontend · Phase F3
Effort: M

> Governed by `DESIGN-SYSTEM.md` §5.2/§8. Global DoD applies.

## What to build

Bring `IntradayQueuePage` to parity with `13`: KPI `MetricStrip` + dense `DataTable` with severity
row-accents/tints and `StatusPill`s (TIMED OUT / DECLINED / PENDING ACCEPTANCE / ESCALATION REQUIRED).
Renders the current ZM same-day-update data (Issue 31). Leave column space for the SE Accept/Decline +
timeout columns that land when backend 29/30 ship.

## Dependencies

- FE-03, FE-04

## Acceptance criteria

- [x] MetricStrip + row-accent `DataTable` matches `13`
- [x] Status pills cover the acceptance vocabulary (Decision §16) with correct tones
- [x] Current same-day-update rows render unchanged; 29/30 columns are forward-compatible placeholders

## Outcome (done — presentation-only, FE-13)

`IntradayQueuePage` re-skinned onto `PageHeader` + a tone-coded `MetricCard` row + the canonical
`DataTable` with per-row severity accents (ADD=success / REMOVE=critical / REORDER=info). The
`iq-metric-strip` / `iq-metric-*` / `iq-row-*` test ids, the `Intra-day Queue` aria-label, the event
labels, the "No acceptance required" text, and the ticket→drawer navigation are preserved.

The SE-Acceptance column is a forward-compatible placeholder: the acceptance vocabulary
(PENDING_ACCEPTANCE / TIMED_OUT / DECLINED / ESCALATION_REQUIRED) already has correct `StatusPill` tones
in FE-04, ready to bind when Issue 29/30 land system-triggered CRITICAL insertions into this same view.
`apiIntradayUpdates` fetch + count derivation unchanged. Verified: admin `tsc --noEmit` clean · vitest
**98/98** · `vite build` OK.

## Reusable components introduced

- (consumes FE-03/04)

## Affected pages

- `IntradayQueuePage` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/13-intraday-queue.png`

## Verification

- `intraday-queue.test.tsx` green; Playwright ≈ `13`
