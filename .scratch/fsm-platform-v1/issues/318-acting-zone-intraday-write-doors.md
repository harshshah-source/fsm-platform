# 318 — Acting-zone attribution on the intraday write doors
Status: ready-for-agent
Type: AFK
Wave: 3 · Severity: P3 · Finding: AR-12, `audit/2026-09-01-scheduler-engine-forensics.md` §7 —
targeted subset of [#239](./239-acting-zone-read-scope-remaining-surfaces.md) (write doors, which
#239's read-surface framing does not explicitly own)

## Problem

An acting CSM's same-day add or escalation resolution is committed pan-India-scoped and audited
**without** acting attribution — the defect class `batches.controller.ts:127-131` documents as
fixed for overrides, still live on the two intraday write doors. The FE half compounds it: three
api clients keep bearer-only local header builders, so a converted backend would never see the
header from those pages (the exact both-halves-or-invisible rule #239 records).

## Root cause

- Backend: `intraday-updates.controller.ts:50-52, 88-89, 107-108` and
  `intraday-insertion.controller.ts:84` build scope from raw claims and hardcode
  `actedAsRole: null`.
- Frontend: `api/dispatch-runs.ts:7-16`, `api/intradayInsertions.ts:19-26`,
  `api/intradayUpdates.ts:5-11` do not use the shared `authHeaders` builder.

## Affected files / symbols

The five files above; the pattern to apply is `@CurrentScope`/`manager-scope.ts` (backend) and
`authHeaders.ts` (frontend) — both already exist.

## Intended behavior after fix

Both intraday write doors honor `X-Acting-As-Zone` for scope and stamp acting attribution on
their audit rows, exactly as `/batches` does; the three FE clients send the shared headers.
Cross-zone reads that must deliberately NOT narrow (per #239's caution) are left as they are,
with a comment.

## Implementation boundaries

- These five files only — the remaining ~20 controllers stay #239's. Both halves land together
  per surface (the #239 rule).

## DB / API / frontend impact

DB: none. API: scope of the two write doors narrows for acting managers (correctness). Frontend:
header addition only.

## Dependencies

References #239 (this slice is a carve-out; update #239's remaining-surface count when done).

## Regression risks

- Narrowing scope must not break the SYSTEM actor's path into the same services (the CRITICAL
  sweep does not go through these controllers — verify, don't assume).

## Tests required

- e2e per door: acting CSM with `X-Acting-As-Zone` → write zone-scoped + audit row carries
  `acted_as_role`/`acting_zone`; without header → unchanged behavior.
- Admin: the three clients send the header (unit).

## Acceptance criteria

- [ ] AC1 — no manager write on these doors can commit outside the acting zone.
- [ ] AC2 — audit rows attribute acting context on both doors.
- [ ] AC3 — #239's ledger of remaining surfaces is updated.

## UI surfaces

n/a (headers only).

## Reference

n/a.

## Blocked by

— (independent; coordinates with #239)
