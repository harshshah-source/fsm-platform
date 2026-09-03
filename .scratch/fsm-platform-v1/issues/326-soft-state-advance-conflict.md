# 326 — Concurrent soft-state advance answers a conflict, not a 500
Status: ready-for-agent
Type: AFK
Wave: 4 · Severity: P3 · Finding: RC-10, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## Problem
Two same-SE advances to the same target (mobile double-tap on a flaky network) both pass the JS
rank check; the loser's `create` hits `ux_ss_active` and the P2002 escapes as an unhandled 500.

## Root cause
`soft-state/soft-state.service.ts:271-309` — `runAdvance` is read → JS check → resolve prior row
by primary key (no `resolvedAt: null` guard) → create, with no P2002 recovery (contrast
`override.service.ts:661-670`).

## Affected files / symbols
`apps/backend/src/soft-state/soft-state.service.ts`; read-only: `common/unique-violation.ts`.

## Intended behavior after fix
The loser's P2002 (discriminated by `uniqueViolationModel`, the repo rule — `meta.target` does
not exist under this adapter) maps to an idempotent success when the winner reached the same
state, else the existing conflict shape; the prior-row resolve gains a `resolvedAt: null` guard.

## Implementation boundaries
Error handling + one guard; no state-machine or rank changes.

## DB / API / frontend impact
API: 500 → 200-idempotent/409. Mobile: no change required (it already handles the conflict
shape).

## Dependencies
None.

## Regression risks
Mapping must be narrow: only `ux_ss_active` violations on the same target fold to idempotent.

## Tests required
Barrier race: double advance → one 200, one idempotent/409, exactly one active row; regression on
normal advance/resolve.

## Acceptance criteria
- [ ] AC1 — no concurrent advance interleaving returns a 5xx.
- [ ] AC2 — exactly one active soft state survives any interleaving.

## UI surfaces
n/a.

## Reference
n/a.

## Blocked by
— (independent)
