# FE-09 — Ticket Detail Drawer parity + fill stub tabs

Status: ready-for-agent
Type: AFK · Frontend · Phase F2
Effort: M

> Governed by `DESIGN-SYSTEM.md` §5.4/5.5. Global DoD applies.

## What to build

Bring `TicketDetailDrawer` to parity with `08`/`28`: `Sheet`-based slide-over with status-tile row
(primary SLA clock, secondary clock, assignability, assigned SE), tabbed body, left Reasoning-Evidence +
Dispatch-History panels, right Manager-Controls + Critical-Facts + Report/Escalation. Fill the
**Forms / Verification / Assignment-History** stub tabs from existing data (Issues 16/18/11). Replace the
`window.prompt` recovery-close with a `Modal`. Manager Controls render **READ ONLY for Ops-Head** (`09`).

## Dependencies

- FE-04, FE-08 (FE-05 for any mini-charts)

## Acceptance criteria

- [ ] Drawer matches `08`/`28` chrome: ID header band, meta chip row, status-tile row, two-column body
- [ ] Forms / Verification / Assignment-History tabs render real data (no stubs)
- [ ] Recovery manual-close uses `Modal` (mandatory reason) — keep `data-testid="recovery-manual-close"`
- [ ] Ops-Head sees Manager Controls as read-only (`09`)
- [ ] Superseded states omitted per fidelity rule (no `REVIEW_PENDING`/SE-Confirmation/`trust_score`)

## Reusable components introduced

- `ManagerControlsPanel`, `CriticalFactsList`, status-tile row (composition)

## Affected pages

- `TicketDetailDrawer` (**[RP]**)

## Reference

- `08`, `09`, `28`

## Verification

- `ticket-detail-drawer.test.tsx`, `ticket-components-tab.test.tsx`, `recovery-drawer-close.test.tsx` green; Playwright ≈ `08`/`28`
