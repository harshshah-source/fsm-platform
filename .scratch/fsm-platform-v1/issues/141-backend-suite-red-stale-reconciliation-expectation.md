# 141 — Backend suite red for 43 commits: stale AutoPlant reconciliation expectation
Status: accepted
Type: AFK

> Source: `docs/audits/2026-07-22-adversarial-review-admin-backend.md` §3.5 (N4, `needs-changes`).
> Re-verified 2026-07-22 by running the spec directly: 1 failed / 7 tests, exit code 1.

## Background

Issue [#128](./128-device-deployment-lifecycle.md) (device deployment lifecycle) widened the
AutoPlant operational deployment filter from a single status to two. That widening was an explicit,
recorded decision — INDEX:36, #128: *"insert scope pinned to **DEPLOYED/ACTIVE** (read ≠ create)"*.
The commit landed 8/8 on its own e2e suite plus a deliberate four-suite regression sweep, and #128 is
correctly marked ✅ DONE.

## Problem

`apps/backend/test/integration-reconciliation.e2e-spec.ts` (written by `d208aa2`, Issue 97 Slice 5)
pins the emitted reconciliation SQL to a **single** placeholder. The widening emits two. The backend
suite has been red since **2026-07-18 — 43 commits** (`git rev-list --count b9242da..HEAD` → 43).

## Root Cause

A behaviour change whose guarding test lived outside the blast radius the author imagined. Nothing
connects "device departure lifecycle" to "integration health reconciliation counts" in a mental
model, so a hand-picked regression sweep — however careful — could not select it. Only a full-suite
run finds this class of break.

**This is a testing-process defect, not a code defect.** The source is correct; the test is stale.

## Evidence

Re-run 2026-07-22 (`npx vitest run test/integration-reconciliation.e2e-spec.ts`):

```
FAIL test/integration-reconciliation.e2e-spec.ts:153
  > AutoPlantMasterSource counts: one single-row COUNT each, reusing the sync filters
  AssertionError: expected 'SELECT COUNT(*) AS c FROM `ap_masters…' to contain 'deployment_status IN (?)'
  Expected: "deployment_status IN (?)"
  Received: "SELECT COUNT(*) AS c FROM `ap_masters`.`mst_vehicle` WHERE deployment_status IN (?, ?)"
 Test Files  1 failed (1)      Tests  1 failed | 6 passed (7)      EXIT=1
```

- `apps/backend/src/ingestion/autoplant/master-mapping.ts:144` →
  `export const OPERATIONAL_DEPLOYMENT_STATUSES = ['DEPLOYED', 'ACTIVE'];`
- Consumed at `apps/backend/src/ingestion/autoplant/autoplant-master-source.ts:99`
  (`?? OPERATIONAL_DEPLOYMENT_STATUSES`) and `:187`
  (`this.inClause('deployment_status', this.operationalStatuses)`).
- `git log -S"'DEPLOYED', 'ACTIVE'"` → exactly `b9242da` (2026-07-18, #128 Slice 1).
- Both the source file and the test file are **clean/committed** — this is not working-tree noise.

> Note: the audit cites the path as `src/integration/autoplant/master-mapping.ts`. The real path is
> `src/ingestion/autoplant/master-mapping.ts`. Cosmetic error in the audit; the finding is correct.

## Current Behaviour

`countVehicleMasters()` emits `deployment_status IN (?, ?)` with params `['DEPLOYED', 'ACTIVE']`.
The test asserts one placeholder and `['DEPLOYED']`, so it fails and the whole backend suite is red.

## Expected Behaviour

The test asserts the **documented** filter — two placeholders, `['DEPLOYED', 'ACTIVE']` — and derives
that expectation from `OPERATIONAL_DEPLOYMENT_STATUSES` rather than a second hardcoded literal, so a
future widening cannot silently desync the pair again.

## What to build

Re-pin the reconciliation spec's count expectations to the shared constant. **Test-only.**

**Do not change the filter.** Narrowing `OPERATIONAL_DEPLOYMENT_STATUSES` back to `['DEPLOYED']`
would silently revert #128's recorded decision and re-introduce the 42.5%-undeployed problem it
fixed. The code is right; the test is stale.

## Acceptance criteria

- [x] `calls[1].sql` asserts `deployment_status IN (?, ?)` and `calls[1].params` equals `['DEPLOYED', 'ACTIVE']` — expressed via a `placeholders()` helper mirroring `inClause`, so the `?` count is generated rather than hand-written.
- [x] Both count expectations (vehicles **and** plants) are derived from the exported constants, not from duplicated string literals, so the next widening cannot desync them.
- [x] `OPERATIONAL_DEPLOYMENT_STATUSES` is unchanged — `git diff` for the commit contains no `src/` path.
- [x] Full backend suite green, reading **vitest's own exit code** (no pipe) — **286 files / 1172 passed + 5 skipped, exit 0, 539s**. Was `1 failed | 1170 passed | 5 skipped`; the +1 test is this issue's new operational-scope guard.

### Root cause was deeper than the audit stated (recorded 2026-07-22)

The audit diagnosed a changed literal. On disk the cause is one level down, and it matters because
the audit's prescribed fix would have **hidden** it:

The spec injected **`deploymentStatuses: ['DEPLOYED']`**, but `countVehicleMasters` reads
**`operationalStatuses`** (`autoplant-master-source.ts:187`). #128 deliberately split these into two
knobs — `deploymentStatuses` is the **READ** scope (default `[]`, every status, so departures are
observable) and `operationalStatuses` is the **create/reconciliation** scope (default
`['DEPLOYED','ACTIVE']`, what FSM actually mirrors). The injection was therefore **inert**, and the
test had been pinning a default it did not know it was pinning.

Merely updating the expected literal to `['DEPLOYED','ACTIVE']` would have produced a green test that
still injected a dead key. So the fix additionally adds a test —
**"countVehicleMasters counts the OPERATIONAL scope, not the READ scope"** — which injects a distinct
three-value `operationalStatuses` and asserts it reaches the SQL, pinning *which knob drives the
count*. That is the thing that actually broke.

## TDD Strategy

**RED already exists — do not author a new failing test.** The existing assertion at
`integration-reconciliation.e2e-spec.ts:153` is the RED, and it has been RED for 43 commits.

- **What fails today:** `expect(calls[1].sql).toContain('deployment_status IN (?)')`.
- **Why it fails:** `OPERATIONAL_DEPLOYMENT_STATUSES` holds two values since `b9242da`, so
  `inClause` emits two placeholders.
- **What makes it pass:** correcting the expectation to the constant-derived form. No source change.

RED → GREEN, no REFACTOR step (there is nothing to clean up in a four-line assertion block).

## Implementation Slices

### Slice 1 — Re-pin the reconciliation expectation to the shared constant

- **Objective:** backend suite green.
- **Files:** `apps/backend/test/integration-reconciliation.e2e-spec.ts`
- **Services:** none — no `src/` change.
- **Database:** none.
- **Frontend:** none.
- **Tests:** the modified spec; then the full backend suite as the gate.
- **Acceptance criteria:** all four above.
- **Definition of Done:** `npx vitest run` in `apps/backend` exits **0**; `git diff --stat` contains
  no `src/` path.

Single slice — independently mergeable.

## Rollback Plan

`git revert` the commit. Test-only, zero runtime surface, no migration, no data.

## Dependencies

None. Independent of #144 — the two files involved are clean/committed and unrelated to the
uncommitted dispatch layer.

## Estimated Effort

15 minutes. **Priority: P0** — it is the precondition that makes [#107](./107-ci-concurrency-guard-migration-tests.md) CI meaningful.

## UI surfaces
n/a (test-only)

## Reference
n/a

## Blocked by
None.
