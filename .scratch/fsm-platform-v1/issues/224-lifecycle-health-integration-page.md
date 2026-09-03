# 224 — The lifecycle check is not on the Integration Health page

Status: done 2026-09-03 — closed into #349, report docs/progress/349-integration-health-page-completion.md
Type: Admin (frontend only — the API already returns the data)
Filed: 2026-08-07
Origin: `/code-review` of the uncommitted [#218](./218-lifecycle-drift-detection.md) work, Spec axis
Blocks: **#218 cannot be marked done while this is open** (CLAUDE.md parity gate)

## Problem

`AutoPlantHealthService.lifecycleHealth()` ships in #218a and `IntegrationHealth.lifecycle` is in the
`GET /api/integration/health` response. **No admin page renders it.**
`apps/admin/src/api/integrationHealth.ts`'s `IntegrationHealthView` never picks the field up, and
`apps/admin/src/pages/admin/BuildHealthPage.tsx` — which already consumes `apiIntegrationHealth` —
never displays it.

This is a direct miss against the approved plan. `FIX-PLAN.md` §5:

> **Placement:** the Integration Health page, as a new entity in the existing
> `ReconciliationHealth.entities[]` array

…under a section titled *"the dashboard cannot hide this"*. And §4 says of the `quietRuns` signal:

> Layer 4 alone would have caught this within a day.

It cannot catch anything an operator never sees.

## What IS already surfaced — scope this correctly

**The Ops Explorer half is done.** `reconciliation.service.ts` adds the 9th identity
`lifecycleConsistency`, and `apps/admin/src/pages/ops-explorer/ReconciliationPanel.tsx:60` maps
**all** identities generically (`data.identities.map(...)`), so it renders today with no frontend
change. §9 open-question 2 settled on *both* surfaces; this issue is the remaining one.

Note the placement wording in §5 was overtaken by 218a's design: `lifecycle` is a **top-level field**,
not a `ReconciliationHealth.entities[]` entry — deliberately, because that array returns `entities: []`
the moment AutoPlant is unreachable, which is exactly when this check matters most. Build against the
shipped shape, not §5's original sentence.

## Acceptance criteria

- [x] `IntegrationHealthView` carries `lifecycle` (`drift`, `missingFromSource`, `quietRuns`,
  `quietRunsAlert`, `quietRunsThreshold`, `healthy`) — plus #349's `runs` (per-run churn).
- [x] `BuildHealthPage` renders it, with `drift` and `quietRunsAlert` visible without interaction.
- [x] `drift` is presented as a **contradiction, not a measurement** — its correct value is exactly 0, and
  any non-zero is a defect by construction. It must not read like a tolerance-band metric.
- [x] `missingFromSource` is shown **beside** `drift`, never folded into it (218a's whole point: the
  excluded population is surfaced, not hidden).
- [x] Not added to the main KPI strip — FIX-PLAN §5 is explicit that those tiles count devices by
  lifecycle state while this counts a disagreement *about* it, and putting them together invites
  subtraction between non-commensurable numbers.

## Not in scope

The backend. `lifecycleHealth()` is shipped, tested (`lifecycle-health.e2e-spec.ts`, 5/5) and consumed
by Ops Explorer. This is a read-only frontend surface over an existing payload.
