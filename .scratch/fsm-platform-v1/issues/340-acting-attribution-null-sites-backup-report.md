# 340 — Acting attribution: 11 null sites, bulk-unassign column overload, backup-share report
Status: ready-for-agent
Type: AFK
Wave: 1 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

`acted_as_role` is non-null on 1 of 34,758 audit rows. Eleven controller sites hardcode
`actedAsRole: null`, so a write made under acting is recorded as the real role.
`scheduling/bulk-unassign.service.ts:289,367` writes the **target** zone into `acting_zone`, which
`roles/role-backup.service.ts:89-96` reads as an acting session — so the backup-share report
("% approvals by CSM") cannot be fixed by attribution alone.

The survey's CZ-03 ("CSM backup actions lose the acting tag") was falsified — all cross-zone writes
audit via `auditEscalation` (`:359-378`). The residual is `cross-zone.controller.ts:113`, one of
the eleven sites here (plan §1).

## Current code

The eleven `actedAsRole: null` sites:

- `cross-zone.controller.ts:113`
- `devices.controller.ts:131`
- `engineers.controller.ts:254`
- `leave-request.controller.ts:69,85,103`
- `intraday-insertion.controller.ts:93`
- `intraday-updates.controller.ts:52,94,115`
- `tickets.controller.ts:143`

Column overload:

- `scheduling/bulk-unassign.service.ts:289,367` — writes the target zone into `acting_zone`
- `roles/role-backup.service.ts:89-96` — reads any `acting_zone` as an acting session

## What to build

- The 11 sites above → `@CurrentActor()` (the actor seam already exists; 339 is not required)
- `bulk-unassign.service.ts` — own metadata key for the target zone; `actingZone` only from the
  actor
- `role-backup.service.ts:89-96` — filter `actedAsRole IS NOT NULL`
- Tests: `csm-backup-report.e2e-spec.ts`, `intraday-updates-controller`,
  `leave-request-controller`, `auto-recovery-manual`, `cross-zone-controller` e2e
- Expected behaviour: every write made under acting is stamped with the acting role and zone; the
  "% approvals by CSM" report is computed only from real acting rows

## Acceptance criteria

- [ ] AC1 — zero literal `actedAsRole: null` remains in `apps/backend/src` (a grep-based test pins
      it)
- [ ] AC2 — paired e2e: the same write as CSM acting vs OH acting → both rows stamped
- [ ] AC3 — bulk-unassign rows no longer appear in the backup-share report
- [ ] AC4 — report per zone equals acting-approvals ÷ approvals for a seeded month

## Verification

e2e above; static pin test for AC1.

## UI surfaces

n/a (backend only; the backup-share report number corrects itself)

## Reference

n/a

## Blocked by

— (none; 339 not required — the actor seam exists)

## Absorbs / supersedes

- survey ids: AA-02, AA-03, CZ-03 residual
- existing issues: #318 (closes into this slice when it lands)

## Downstream

341 (acting scope on write doors) depends on this and 339 (plan §3).
