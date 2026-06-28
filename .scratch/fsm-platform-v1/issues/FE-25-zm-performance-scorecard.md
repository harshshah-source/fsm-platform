# FE-25 — ZM Performance Scorecard

Status: ready-for-agent
Type: AFK · Frontend (backend-paired) · Phase F5
Effort: M

> Governed by `DESIGN-SYSTEM.md` §5.1/5.6. Global DoD applies. **Backend-gated** (Issue 43).

## What to build

The ZM Performance Scorecard page matching `25`: leader card (top ZM) + scorecard `DataTable` (ZM → uptime/
SLA-hit/overrides/escalations/rank with coloured deltas) bound to the Issue 43 endpoint. Operations-Head
scope.

## Dependencies

- FE-05 + **backend Issue 43 (ZM Performance Scorecard)**

## Acceptance criteria

- [ ] Page matches `25` (leader card + scorecard table with coloured metric deltas + rank)
- [ ] All data from the Issue 43 endpoint; Ops-Head scoping preserved

## Reusable components introduced

- `ScorecardTable` (shared with FE-07 Central/Ops-Head dashboards)

## Affected pages

- new `/reports/zm-scorecard` (**[N]** page)

## Reference

- `docs/ui/desktop/v2-reference/25-zm-performance-scorecard.png`

## Verification

- new scorecard test; Playwright ≈ `25`
