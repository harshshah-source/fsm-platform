# FE-07 — Role-variant dashboards (CSM-acting / Central / Ops-Head)

Status: ready-for-agent
Type: AFK · Frontend · Phase F1
Effort: M

> Governed by `DESIGN-SYSTEM.md` §8. Global DoD applies.

## What to build

Render the dashboard variants for non-ZM roles over the **existing** aggregations + acting context — no
new endpoints. CSM-acting (`02`, amber Backup-Coverage banner + `acted_as_role` surfacing), Central Service
"Cross-Zone Central Tower" (`03`, Escalation Queue + Zone Performance Scorecard), Operations-Head
"Pan-India Fleet Command" (`04`, denser KPIs + Auto-Dispatch efficiency row + `DistributionBar` + scorecard).

## Dependencies

- FE-06

## Acceptance criteria

- [ ] Variant rendering keyed on `session.role` / `actingZone`; ZM unaffected
- [ ] `02` CSM-acting shows Backup-Coverage banner + acting attribution (reuse Issue 27 context)
- [ ] `03` Central shows Escalation Queue + Zone Performance Scorecard `DataTable`
- [ ] `04` Ops-Head shows Auto-Dispatch efficiency row + SLA `DistributionBar` + scorecard
- [ ] No new backend endpoints introduced

## Reusable components introduced

- role-layout selector (composition); `ScorecardTable`, `EscalationQueueList`

## Affected pages

- `DashboardHome` variant rendering (**[N] shells over existing data**)

## Reference

- `02`, `03`, `04`

## Verification

- new variant tests added; existing dashboard tests green; Playwright ≈ `02`/`03`/`04`
