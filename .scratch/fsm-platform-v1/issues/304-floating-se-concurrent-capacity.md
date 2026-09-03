# 304 — Floating-SE capacity holds under concurrent zone runs
Status: **done** (2026-09-02) — report [`docs/progress/304-floating-se-concurrent-capacity.md`](../../../docs/progress/304-floating-se-concurrent-capacity.md). **Both** sanctioned designs were needed, not either/or: the commit-time re-check alone is not enough, because under READ COMMITTED two concurrent transactions each read a load that excludes the other's uncommitted rows and both pass. So `dispatchForSe` also takes a per-ENGINEER advisory lock, after the zone lock and never before it. No transaction ever holds an engineer lock and then asks for a zone lock, so there is no cycle — two runs contending for one engineer queue, and every other engineer in both zones proceeds in parallel, which is what keeps #259/#260's model intact.
Type: AFK
Wave: 2 · Severity: P2 · Finding: RC-4, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## Problem

Two dispatch runs in different zones running concurrently (a manual zone-scoped run or a #286
recovery run beside the 05:00 loop) can each fill the same floating SE up to `dailyCapacity` —
the SE's real day can exceed capacity by up to another zone's allocation.

## Root cause

The capacity counter is seeded from committed DB rows once per zone-run
(`recommender.service.ts:504-511`) and incremented only for that run's own wins (:813); zone
claims serialize per **zone**, not per engineer; nothing downstream re-checks — dispatch claims
all SUGGESTED rows regardless (`batch-assignment.service.ts:168-175`), and
`work_schedules_one_active_per_se_zone_day` is deliberately per-(SE, **zone**, day), so the DB
permits it. `test/recommender-cross-zone-capacity.e2e-spec.ts` covers only sequential runs.

## Affected files / symbols

- `apps/backend/src/scheduling/batch-assignment.service.ts` — `dispatchForSe` (the enforcement
  point that exists at commit time)
- `apps/backend/src/scheduling/committed-day-load.ts` — read-only (the one capacity definition;
  must stay the one)
- Read-only: `recommender.service.ts` seeding (unchanged — recommendation-time optimism is fine
  if commit-time enforcement exists)

## Intended behavior after fix

Recommended design (commit-time re-check, matching where every other invariant is enforced):
inside the per-SE dispatch transaction, after claiming SUGGESTED rows, re-read
`committedDayLoad` for that SE **within the transaction** and dispatch only up to remaining
capacity; surplus claimed rows are released back to SUGGESTED (or RETIRED with a named reason) —
a counted, honest outcome, not silence. The manual doors' deliberate right to exceed capacity
(#258 Q2) is untouched — this bounds the **engine** only. Alternative designs (per-engineer
advisory lock spanning zones; a capacity partial unique) are acceptable if AC1 holds without
serializing whole zones.

## Implementation boundaries

- Capacity remains defined once (`committedDayLoad`) — no second spelling.
- Do not serialize zone runs against each other (the #259/#260 concurrency model stands).
- Do not touch manual-assignment capacity semantics.

## DB / API / frontend impact

DB: none (unless the chosen design adds an index — none expected). API: `se_skips`/run summary
may gain a named reason for capacity-released rows (additive). Frontend: none.

## Dependencies

Sequence with #303/#305/#307 (same service files). Independent of Wave 1.

## Regression risks

- The in-tx re-read must use the transaction's snapshot consistently — beware counting the rows
  this same transaction just wrote.
- Releasing surplus rows must not fight the idempotency guard or the orphan cleanup
  (`clearFailedSeOrphans` scoping rule from #262 applies: never touch rows another claimant holds).

## Tests required

- Barrier race: two zone runs, one shared floating SE, capacity 5, each zone offering 5 → total
  dispatched ≤ 5 across both, surplus honestly recorded; existing sequential spec stays green.
- Regression: `dispatch-per-se-isolation`, `dispatch-idempotent`, `dispatch-concurrent` green.

## Acceptance criteria

- [x] AC1 — no interleaving of engine runs can commit more than `dailyCapacity` engine-placed
      tickets to one SE for one day. Enforced at commit time behind the engineer lock, using
      `committedDayLoad` — the one definition (#269), reused not respelled — read before this
      transaction writes anything, so it cannot count its own rows.
- [x] AC2 — surplus is a named, counted outcome visible on the run ledger, never a silent drop.
      `ticketSkips` gains `CAPACITY_REACHED`. The surplus dropped is the **suffix** of the claim's
      `processing_rank` order, so the engine's own priority survives the cap rather than being
      silently reordered.
- [x] AC3 — manual doors still may exceed capacity (pinned). They take neither the engineer lock nor
      the capacity check; asserted by taking the engineer to `capacity + 1` through a manual plan.

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

— (sequence with 303/305/307 on shared files)
