# 143 — Critical Devices KPI silently dropped from the Pan-India dashboard
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-22-adversarial-review-admin-backend.md` §3.3 (N1a, **`fail`**).
> Re-verified 2026-07-22: the guarding test is red on committed code and has been for 3 commits.

## Background

Issue [#122](./122-dashboard-ui-overhaul.md) established, by explicit HITL operator decision
(INDEX:86 — *"**'Critical+' KPI → CRITICAL-band-only** (operator decision via HITL; worse bands stay
in Zone Overview/SLA distribution)"*), that the Pan-India **Critical** KPI counts *strictly the
CRITICAL band* and must agree with the Zone Performance Scorecard's Critical column.
`apps/admin/test/kpi-critical-plus-consistency.test.tsx` was written to guard exactly that invariant.

## Problem

Commit `ad03769` ("feat(dashboard): Total Devices KPI — surface AutoPlant source catalog size")
removed the Critical Devices KPI from the Operations-Head dashboard. The guarding test was left in
place and has been red for 3 commits on **committed** code.

## Root Cause

`ad03769` reworked the Pan-India hero into a fixed slot layout and dropped a card to make room. The
commit message documents only the *addition* — the removal is not mentioned anywhere, in the message
or in any doc, and `sumCriticalDevices` was dropped from the imports as collateral. The guarding test
was left standing rather than deleted.

**That is the signature of an oversight, not a decision.** A deliberate reversal of a HITL-ratified
product decision would have deleted or rewritten the test and recorded the reversal.

## Evidence

```
$ git show ad03769 -- apps/admin/src/pages/dashboard/OpsHeadDashboard.tsx
-import { sumCriticalDevices } from '../../lib/slaBucket';
-    // Strictly the CRITICAL band (Issue 122) — same zone-overview source as the scorecard's Critical
-      { label: 'Critical Devices', value: roll(criticalDevices),
-        hint: 'pan-India, CRITICAL band', tone: 'critical', testId: 'kpi-critical' },
+        testId: 'kpi-total-devices',
```

Failure (re-run 2026-07-22):

```
FAIL test/kpi-critical-plus-consistency.test.tsx:75
  > Pan-India Critical KPI counts strictly the CRITICAL band (not tickets, not worse bands)
  TestingLibraryElementError: Unable to find an element by: [data-testid="kpi-critical"]
```

Trace:

- The test renders `DashboardHome` as `OPERATIONS_HEAD` (`kpi-critical-plus-consistency.test.tsx:15,63-71`).
- `ManagerDashboard` routes Operations Head → `OpsHeadDashboard`.
- `OpsHeadDashboard.tsx` is **clean / committed**; its testIds are `kpi-uptime`, `kpi-devices`,
  `kpi-total-devices`, `kpi-companies`, `kpi-plants` — **no `kpi-critical`**.
- `kpi-critical` now exists only in `ZmDashboard.tsx:85` (the ZM variant), which this test does not render.
- The test file itself is **unmodified**.
- **Not caused by the uncommitted tree** — the only uncommitted dashboard edits are a `ZmDashboard`
  label change, a `centerBelow` prop on `DashboardHero`, and small `ActivityTrendSection` /
  `ZoneOverviewTable` edits. None touch `kpi-critical`.

**Restoration is unobstructed — there is no "which KPI do we drop" trade-off:**

- `sumCriticalDevices` still exists at `apps/admin/src/lib/slaBucket.ts:48`.
- `OpsHeadDashboard.tsx:83-99` passes `left={kpis.slice(0, 2)}` (**2 cards**) and
  `right={[fleet-directory, kpis[2], kpis[3]]}` (**3 cards**), while the docblock at `:81` states the
  reference is *"3 KPIs each side of the truck"* (`docs/ui/hero-ref.jpg`).
  **The left column has a free third slot.** Restoring the KPI moves the layout *towards* its
  reference, not away from it.

**The other three tests in the file still pass** — so the *scorecard* half of the Issue-122 invariant
is intact and only the *KPI* half was lost. That asymmetry is why it went unnoticed: the two halves
are asserted independently, so losing one does not fail the other.

## Current Behaviour

An Operations Head has no pan-India CRITICAL-band count on the dashboard. The consistency invariant
#122 was built to enforce is unenforced on the Operations-Head surface, and the guarding test fails
with a message (`Unable to find element`) that reads like a broken test rather than a lost feature.

## Expected Behaviour

`data-testid="kpi-critical"` renders on the Pan-India dashboard, sourced from
`sumCriticalDevices(zones)`, and its value equals the sum of the Zone Performance Scorecard's
Critical column. `ad03769`'s Total Devices feature is retained in full.

## What to build

Restore the Critical Devices KPI to the Operations-Head hero as **left slot 3**, and strengthen the
guard so the KPI↔scorecard invariant is asserted as one relationship rather than two independent
numbers.

> **Strategic HITL note (business-rule confirmation).** This issue is written against the
> recommendation that the removal was **accidental** and should be reverted — grounded in #122's
> explicit purpose (KPI↔scorecard consistency), the guarding test being left in place, and the
> commit message being silent on the removal.
>
> If the operator instead confirms the removal was **intended**, this issue inverts to: delete the
> KPI test, **record the reversal of the #122 decision in `INDEX.md` and in the #122 issue file**, and
> keep the file's other three tests. Deleting a red test without recording the decision is not an
> acceptable outcome under either branch.

## Acceptance criteria

- [ ] `data-testid="kpi-critical"` renders on the Operations-Head dashboard, sourced from `sumCriticalDevices(zones)`, labelled `Critical Devices`, hint `pan-India, CRITICAL band`, tone `critical`.
- [ ] A single test asserts the **invariant** — the KPI value equals the sum of the scorecard's Critical column — rather than asserting two independent constants.
- [ ] Hero layout matches `docs/ui/hero-ref.jpg`: 3 cards each side. `kpi-total-devices` and `kpi-devices` are both retained; `ad03769`'s feature is **not** reverted.
- [ ] `kpi-critical-plus-consistency.test.tsx` passes with its original intent intact (the CRITICAL-band-only semantics of #122 are unchanged).
- [ ] Full admin suite green (expected 318/318), reading vitest's own exit code.
- [ ] INDEX session log records the regression, its 3-commit window, and the resolution.

## TDD Strategy

**RED already exists** for Slice 1 — `kpi-critical-plus-consistency.test.tsx:75` is a pre-written
failing test for a feature that must be restored. This is the textbook case.

- **What fails today:** `await screen.findByTestId('kpi-critical')` on the Operations-Head render.
- **Why it fails:** `ad03769` deleted the metric entry from `OpsHeadDashboard.tsx`'s `kpis` array and
  removed the `sumCriticalDevices` import; the testId now exists only on the ZM dashboard, which this
  test does not render.
- **What makes it pass:** re-adding the metric to the `kpis` array with `testId: 'kpi-critical'` and
  re-importing `sumCriticalDevices`, then widening the hero's left column to `kpis.slice(0, 3)`.

Slice 2 introduces a **genuinely new RED** (a contract test over the documented testId set) — write
it first, watch it fail against a deliberately removed card, then make it pass.

## Implementation Slices

### Slice 1 — Restore the KPI and assert the invariant

- **Objective:** Operations-Head Critical KPI back, guarded by the KPI↔scorecard relationship.
- **Files:** `apps/admin/src/pages/dashboard/OpsHeadDashboard.tsx`,
  `apps/admin/test/kpi-critical-plus-consistency.test.tsx`
- **Services:** none — no API change; `zone-overview` already carries `byBucket`.
- **Database:** none.
- **Frontend:** re-import `sumCriticalDevices` from `../../lib/slaBucket`; add the `Critical Devices`
  metric to the `kpis` memo; pass `left={kpis.slice(0, 3)}` so the hero's left column carries 3 cards
  per `docs/ui/hero-ref.jpg`.
- **Tests:** the existing spec goes GREEN; **add** an assertion that the KPI value equals the sum of
  the scorecard's Critical column — the missing link that let half the invariant die unnoticed.
- **Acceptance criteria:** AC 1–5 above.
- **Definition of Done:** admin suite exits 0; hero eyeballed against `docs/ui/hero-ref.jpg` and
  `docs/ui/desktop/v2-reference/04-dashboard-operations-head.png`; INDEX line appended.

### Slice 2 — Guard the class, not the instance

- **Objective:** make any future KPI deletion fail loudly and legibly.
- **Files:** `apps/admin/test/` (new dashboard-contract spec).
- **Services / Database / Frontend:** none.
- **Tests:** assert the Operations-Head hero renders its documented testId set — `kpi-uptime`,
  `kpi-critical`, `kpi-devices`, `kpi-total-devices`, `kpi-companies`, `kpi-plants`. Removing any one
  card then fails with a readable message naming the missing card, instead of surfacing as an
  `Unable to find element` inside an unrelated invariant test.
- **Acceptance criteria:** deliberately removing one card fails this spec and names it.
- **Definition of Done:** admin suite green; the deliberate-removal check performed and reverted.

Both slices are independently mergeable; Slice 1 alone closes the `fail` verdict.

## Rollback Plan

Slice 1 is a single-file revert of one entry in the `kpis` array plus one import.
`ad03769`'s Total Devices work is untouched and independently revertible.
Slice 2 is test-only.

## Dependencies

None. `OpsHeadDashboard.tsx` is clean/committed, so this can proceed in parallel with
[#144](./144-commit-dispatch-correctness-layer.md).

## Estimated Effort

1–2 hours. **Priority: P1** — a `fail` verdict on a core operator surface, red on committed code.

## UI surfaces

Admin: **Pan-India Fleet Command** dashboard (Operations Head) — restores one KPI card to the hero's
left column. No new page, no new route, no role-visibility change.

## Reference

- `docs/ui/hero-ref.jpg` (hero layout — 3 KPIs each side of the truck)
- `docs/ui/desktop/v2-reference/04-dashboard-operations-head.png` (Operations-Head dashboard)

## Blocked by
None.
