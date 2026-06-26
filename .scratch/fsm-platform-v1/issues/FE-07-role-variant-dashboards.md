# FE-07 — Role-variant dashboards (CSM-acting / Central / Ops-Head)

Status: done
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

- [x] Variant rendering keyed on `session.role` / `actingZone`; ZM unaffected
- [x] `02` CSM-acting shows Backup-Coverage banner + acting attribution (reuse Issue 27 context)
- [x] `03` Central shows Escalation Queue + Zone Performance Scorecard `DataTable`
- [x] `04` Ops-Head shows Auto-Dispatch efficiency row + SLA `DistributionBar` + scorecard
- [x] No new backend endpoints introduced

## Outcome (done — presentation-only, FE-07)

`DashboardHome` is now a loader + variant selector over the one set of role-scoped aggregations:
- **Operations Head** → `OpsHeadDashboard` "Pan-India Fleet Command" (dense KPI strip + Auto-Dispatch
  efficiency row + SLA `DistributionBar` fed from aggregated zone bucket counts + `ScorecardTable`).
- **Central Service Manager (not acting)** → `CentralDashboard` "Cross-Zone Central Tower"
  (`EscalationQueueList` derived from the critical-queue + `ScorecardTable`).
- **Zonal Manager — or any role acting as ZM (`actingZone` set)** → the FE-06 `ZmDashboard`
  (reference 01/02). The amber Backup-Coverage banner is the shell's existing Issue 27 control
  (`acting-banner.test.tsx`), reused unchanged — not re-implemented here.

New reusable dashboard pieces: `ScorecardTable`, `EscalationQueueList`, and `BUCKET_HEX` (promoted into
`lib/slaBucket.ts` as the single SLA-colour source for chart surfaces, §9.3).

**Documented omission (§9.2):** the Auto-Dispatch System Efficiency row has no backend source until the
System Efficiency report (BE-42 / FE-24); it renders reference chrome with `—` placeholders, not faked
figures. (Fleet Uptime % likewise → BE-39/40 / FE-21, as in FE-06.)

No new endpoints, no routing/auth/RBAC change. New `dashboard-role-variants.test.tsx` (4 cases) added;
all prior dashboard tests green. Verified: admin `tsc --noEmit` clean · vitest **98/98** · `vite build` OK.

## Reusable components introduced

- role-layout selector (composition); `ScorecardTable`, `EscalationQueueList`

## Affected pages

- `DashboardHome` variant rendering (**[N] shells over existing data**)

## Reference

- `02`, `03`, `04`

## Verification

- new variant tests added; existing dashboard tests green; Playwright ≈ `02`/`03`/`04`
