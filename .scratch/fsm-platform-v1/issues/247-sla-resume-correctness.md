# 247 — SLA resume correctness: reason-checked resume + auto-resume on the return date

Status: ready-for-agent
Type: AFK · Backend

Filed 2026-08-19. Approved Decision 16. Two halves: fix the existing `resumeSla` safety hole, and
make the primary SLA resume when the ticket re-enters eligibility on the authoritative return date —
so a returned ticket is never dispatchable with a frozen primary clock.

## What to build

### Current behaviour (verified)

- `vehicle-unavailability.service.ts:195` — `resumeSla`'s guard is `if (cycle?.slaPaused && cycle.slaPausedAt)`
  with **no `slaPauseReason` check**: a manager resuming a VU report on a `WAITING_COMPONENT`-paused
  cycle silently clears the **component** pause (mirror of `fileReport`'s `!cycle.slaPaused` guard,
  which refuses to re-pause and leaves the component reason standing — order-dependent behaviour).
- Exactly two writers of `slaPaused: false` exist (`vehicle-unavailability.service.ts:200`,
  `component-request.service.ts:312`); **nothing is date-driven**. A ticket re-entering on its
  return date stays paused until a human acts.
- Secondary clock: derived from `openedAt`, structurally unpausable, manager-only by type omission —
  untouched (Decision 16: existing architecture governs it).

### Required change

1. **Reason check:** `resumeSla` resumes only when `slaPauseReason = 'VEHICLE_UNAVAILABLE'`;
   resuming a report on a differently-paused cycle resolves the report **without** touching the
   pause (and says so in the response). Symmetrically document `fileReport`'s no-re-pause guard —
   the report is still recorded; the earlier pause reason stands.
2. **Auto-resume on re-entry:** when the authoritative return date arrives (the ticket re-enters
   eligibility per #246), the primary SLA resumes automatically — pause seconds accumulated exactly
   once into `slaAccumulatedPauseSeconds`, reason/pausedAt cleared, **single writer** (the sweep is
   the only automatic resumer; `resumeSla` stays the manual path).
   Mechanism: a date-driven sweep in the `TierOverrideExpiryService` shape
   (`org/tier-override-expiry.service.ts` — `status ACTIVE ∧ expiresAt <= now` → flip + batched
   audit) over OPEN VU reports with authoritative `expected_from` ≤ now (IST-day), using the
   existing `@@index([status, expectedFrom])`. Registered under the `BUSINESS_SWEEPS_ENABLED`
   family with the standard single-in-flight guard. Idempotent: an already-resumed cycle is
   skipped by the reason check.
3. **Interaction pins:** auto-resume does NOT resolve the report (Decision 16: the report stays
   open until superseded or resolved by a submission — the SE may arrive and find the vehicle absent
   again, filing the next report/attempt); a cycle that was component-paused during the wait is
   never touched by the VU sweep.

### Existing code to reuse

`TierOverrideExpiryService` (structure + batched `auditLog.createMany` with SYSTEM actor),
`business-sweep-scheduler.service.ts` registration pattern, `resumeSla`'s accumulation arithmetic
(`:196,:204`), #245/#246's authoritative date.

### Tests

- e2e: pause → date arrives → sweep resumes with correct accumulated seconds → report still OPEN →
  ticket dispatchable with a running primary clock.
- Reason-check: VU resume on a component-paused cycle leaves the pause intact (both manual and
  sweep paths).
- Double-resume idempotency (sweep twice; sweep after manual resume).
- Secondary clock unchanged throughout (pinned).

### Risks / rollback

A new sweep — same guarded, non-throwing shape as the eleven existing business sweeps; default OFF
with the master switch. Rollback: disable the sweep; manual `resumeSla` still works.

## Acceptance criteria

- [ ] AC1 — `resumeSla` never clears a non-VU pause; the component-pause scenario is pinned in both
      directions (file-then-component, component-then-file).
- [ ] AC2 — On the authoritative return date, the primary SLA resumes automatically with pause time
      accumulated exactly once; the sweep is idempotent.
- [ ] AC3 — Auto-resume leaves the report OPEN; a subsequent submission or supersession resolves it
      (#245/#246 integration).
- [ ] AC4 — No ticket can be selected by the recommender while its cycle is VU-paused **and** its
      authoritative date has passed — the sweep runs before dispatch in the daily order (cron
      sequencing stated and tested at the config level).
- [ ] AC5 — Secondary SLA behaviour is bit-identical before/after.

## UI surfaces

n/a (the admin VU page already shows pause state; values now change truthfully)

## Reference

n/a

## Blocked by

#246 (re-entry + authoritative date). 
