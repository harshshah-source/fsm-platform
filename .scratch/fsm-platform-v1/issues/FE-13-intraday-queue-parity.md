# FE-13 — Intra-day Queue parity

Status: ready-for-agent
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

- [ ] MetricStrip + row-accent `DataTable` matches `13`
- [ ] Status pills cover the acceptance vocabulary (Decision §16) with correct tones
- [ ] Current same-day-update rows render unchanged; 29/30 columns are forward-compatible placeholders

## Reusable components introduced

- (consumes FE-03/04)

## Affected pages

- `IntradayQueuePage` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/13-intraday-queue.png`

## Verification

- `intraday-queue.test.tsx` green; Playwright ≈ `13`
