# 320 — Partition maintenance survives a lapse (per-statement isolation + DEFAULT drain)
Status: ready-for-agent
Type: AFK
Wave: 4 (pull forward before `PARTITION_MAINTENANCE_ENABLED` goes on in production)
Severity: P2 · Finding: AR-3, `audit/2026-09-01-scheduler-engine-forensics.md` §7

## Problem

If maintenance lapses past the 3-day create-ahead, snapshot rows land in the DEFAULT partition;
Postgres then **refuses** `CREATE TABLE … PARTITION OF` for any day the DEFAULT holds rows for.
`applyPlan` (`partition-maintenance.service.ts:122-134`) executes creates then drops with no
per-statement isolation, so the throw aborts the remaining creates **and all retention drops** —
and repeats identically every day. Nothing ever cleans the DEFAULT; retention re-inserts each
dead device's last ping into it after drops (the wedge's seed population).

## Root cause

All-or-nothing `applyPlan` + no DEFAULT-partition management at all.

## Affected files / symbols

- `apps/backend/src/ingestion/partition-maintenance.service.ts` — `applyPlan`, plus a new
  DEFAULT-drain step
- `apps/backend/src/ingestion/partition-planner.ts` — plan may need to name the drain work

## Intended behavior after fix

- Each create and each drop executes with isolated error handling: one failure is logged and
  counted, the rest of the plan proceeds (retention can never be halted by a create failure).
- A drain step moves DEFAULT-partition rows for a day into that day's partition (create the
  partition via the documented detach/move/attach or insert-and-delete sequence) so the wedge
  self-heals; bounded per tick.
- The tick's result names failures per statement (feeds #300's surfacing if present).

## Implementation boundaries

- Ingestion module only; no schema change to the parent table; `SAFE_NAME_RE` validation stays on
  every identifier. Locking care: drops take ACCESS EXCLUSIVE — keep the existing
  caught-and-retry posture for lock contention.

## DB / API / frontend impact

DB: DDL behavior only. API/frontend: none.

## Dependencies

Independent. Sequenced in Wave 4 by operator instruction, but must land before partition
maintenance is enabled unattended in production.

## Regression risks

- The drain must be idempotent and crash-safe (re-runnable); prove with a kill-mid-drain test.

## Tests required

- e2e (real DDL, the existing `partition-maintenance.e2e-spec` harness): seed rows into DEFAULT
  for a missing day → next tick creates the partition, drains, drops old partitions — all despite
  one injected create failure.
- Pin: a create failure no longer suppresses retention drops.

## Acceptance criteria

- [ ] AC1 — no single DDL failure prevents any other planned statement in the same tick.
- [ ] AC2 — a populated DEFAULT partition self-heals within bounded ticks.
- [ ] AC3 — retention proceeds during a wedge.

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

— (independent)
