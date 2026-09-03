# #304 — Floating-SE capacity holds under concurrent zone runs

**Landed 2026-09-02** · branch `feat/autoplant-integration` · issue
[`.scratch/fsm-platform-v1/issues/304-floating-se-concurrent-capacity.md`](../../.scratch/fsm-platform-v1/issues/304-floating-se-concurrent-capacity.md)
· finding RC-4, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## What was wrong

`daily_capacity` caps an engineer's whole day. Nothing enforced that across zones:

- the recommender seeds its counter from committed rows **once per zone-run** and increments only for
  its own wins;
- zone claims serialize per **zone**, not per engineer;
- `work_schedules_one_active_per_se_zone_day` is per-(SE, **zone**, day) by design, so the database
  permits two plans;
- and nothing downstream re-checked — dispatch claimed every SUGGESTED row it was handed.

So two runs in different zones — a manual zone-scoped run, or a #286 recovery beside the 05:00 loop —
could each fill the same floating SE to capacity, and the engineer's real day came out at up to twice
it. `recommender-cross-zone-capacity.e2e-spec.ts` covered only the sequential case, which always
passed because the second run's seed sees the first run's committed rows.

## What was built — both designs, not either/or

The issue offered a commit-time re-check *or* a per-engineer lock. **The re-check alone is not
sufficient**, and that is worth stating because it is the trap: under READ COMMITTED, two concurrent
transactions each read a committed load that excludes the other's uncommitted rows, so both compute
the same remaining capacity and both pass. The re-check closes the sequential and near-miss cases and
leaves the actual race open.

So `dispatchForSe` does both:

1. **A per-engineer advisory lock**, taken immediately after the zone lock and never before it. Two
   runs contending for one engineer queue; every other engineer in both zones proceeds in parallel, so
   zone runs are not serialized against each other (#259/#260's model stands). No transaction ever
   holds an engineer lock and then asks for a zone lock — each `dispatchForSe` takes exactly one of
   each, in that order — so there is no cycle to deadlock on. The existing `SET LOCAL lock_timeout`
   bounds the wait, so a stuck holder costs that engineer only, matching the zone lock's posture.
2. **Commit-time enforcement**, behind that lock: read `committedDayLoad` for this SE inside the
   transaction, cap the claim at `dailyCapacity - committed`. `committedDayLoad` is *the* definition
   of committed (#269) and is reused rather than respelled — the number a manager reads beside
   `daily_capacity` has to be the number the engine enforces. Counted before the transaction writes
   anything, so it cannot count its own rows (the regression risk the issue names).

The surplus is the **suffix** of the claim's `processing_rank` order, so the cap drops the work the
engine ranked last instead of silently reordering the engineer's day, and each dropped ticket is named
`CAPACITY_REACHED` in `ticketSkips`. The recommender's optimism is untouched, as the boundary requires;
the manual doors take neither the lock nor the check, so #258 Q2's right to exceed capacity survives.

## A stale assertion this surfaced

`dispatch-per-se-isolation`'s throughput case seeded 4 SEs at `dailyCapacity: 20`, offered each 40
tickets through a hand-built `suggest()` that bypasses the recommender, and asserted all 160 landed —
i.e. it asserted the *unenforced* behaviour. It now seeds a capacity above `PER_SE`, because what it
measures is the per-SE transaction budget, not the capacity guard. Per #141's discipline: the widening
is intended, so the test moves, not the code.

## Tests

`test/dispatch-floating-capacity-concurrent.e2e-spec.ts` (new, 4), on two connection pools so the two
runs cannot see each other's memory — the reasoning `dispatch-zone-claim-admission` gives.

SUGGESTED rows are written directly rather than through the recommender, deliberately: the
recommender's optimism is explicitly out of scope, so what has to be proven is that the **commit**
refuses to exceed capacity whatever it is handed.

- **AC1/AC2** — two zones each offering a full day, started together: the engineer's real day is
  `≤ dailyCapacity`, and the surplus is named. The invariant is asserted as the engineer's day, not as
  either run's total, so it holds whichever order they land in.
- **AC1** — a second run against a full day places nothing and says `CAPACITY_REACHED` for every
  ticket.
- **AC2** — the dropped surplus is exactly the `processing_rank` suffix.
- **AC3** — a manual plan still takes the engineer to `capacity + 1`.

**Red before green**: forcing `capacity = null` (the pre-#304 "no cap" behaviour) turns **3 of 4 red**,
including the concurrent case; AC3 stays green, which is the correct split.

## Validation

- Targeted: 4/4. Every dispatch / capacity-touching spec run together: **176 files / 915 tests green**.
- `tsc --noEmit` clean.
- Full backend suite: recorded with the dispatch chain's combined run in
  [`INDEX.md`](../../.scratch/fsm-platform-v1/INDEX.md)'s session log.

## Follow-ups

None. No schema change and no index was needed.
