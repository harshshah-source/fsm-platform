# 311 — Override preview reads the real ON_SITE conflict source
Status: done (2026-09-03) - see `docs/progress/311-override-preview-real-onsite-conflicts.md`
Type: AFK
Wave: 3 · Severity: P2 · Finding: CB-4, `audit/2026-09-01-scheduler-engine-forensics.md` §6

## Problem

`POST /batches/:id/override/preview` reports `conflicts.onSite: []` for a batch whose engineer is
ON_SITE; the identical confirm body then 409s `OVERRIDE_ON_SITE_CONFLICT` — the exact
preview/commit drift the service's own docblock (`override-projection.service.ts:104-107`) calls
"worse than no preview".

## Root cause

`override-projection.service.ts:293-303` hardcodes `onSite: []` on the stale premise that
`soft_states` "does not exist yet". It does: `PrismaSoftStateConflictPort`
(`soft-state/soft-state-conflict.adapter.ts:15-27`) is implemented and bound in the same module
(`scheduling.module.ts:98`), and the commit path gates on it (`override.service.ts:235-251`).

## Affected files / symbols

- `apps/backend/src/scheduling/override-projection.service.ts` — `conflictsFor`, constructor DI
- `apps/backend/src/scheduling/scheduling.module.ts` — wiring only if needed

## Intended behavior after fix

The projection injects `SOFT_STATE_CONFLICT` and populates `onSite` from
`activeOnSiteTicketIds` — the same source the commit consults — so preview and commit agree by
construction. The stale docblock is corrected.

## Implementation boundaries

- Read-side only; the preview must remain write-free (the #289 row-count assertion must stay
  green). Do not change the commit gate or the conflict port.

## DB / API / frontend impact

DB: none. API: `conflicts.onSite` starts carrying real ids (the field always existed). Frontend:
none — `OverrideImpactPanel` already renders the field.

## Dependencies

None.

## Regression risks

Minimal. Keep the port's `NoConflict` constructor fallback semantics in mind: hand-constructed
instances in tests must bind the real port to assert this behavior (the forensic A6 note).

## Tests required

- Parity pin: for a batch with an ON_SITE engineer, preview's `onSite` equals the set the commit
  would 409 on (drive both paths in one spec).
- The #289 write-free row-count assertion stays green.

## Acceptance criteria

- [x] AC1 — preview and commit can never disagree on the ON_SITE conflict set.
- [x] AC2 — the preview still writes nothing.

## UI surfaces

Admin: OverrideImpactPanel (existing — data correctness only).

## Reference

n/a.

## Blocked by

— (independent)
