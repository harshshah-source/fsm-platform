# 178 — Ticket closure never clears assignment state (351 closed tickets burn phantom capacity)

Status: **DONE 2026-08-20** (`docs/progress/178-closure-never-clears-assignment.md`) — the backfill probe is built and **NOT executed** (read-only by default; `--apply` is a deliberate act) — **sequenced into P8 as a hard prerequisite of [#269](./269-capacity-overload-visibility.md)** (2026-08-20 pre-implementation review). `committedDayLoad` has no ticket-status filter, so until this lands the capacity figure overcounts closed work until the 04:00 recycle — #269 would display that inflated number as fact, and [#268](./268-critical-direct-assignment.md) reads the same figure for its Q-B escalation decision. Fix the source before surfacing or escalating on it.
Type: AFK · Backend

Filed 2026-07-29 (found during the #179 bulk-unassign design investigation; independent companion —
#179's predicate excludes these rows, this issue fixes why they exist).

## Inventory corrected at implementation time (2026-08-20)

The writer list below was accurate when filed (2026-07-29) and **is not accurate now** — #241 landed
in between and fixed two of the paths it names. Verified against the working tree:

| Terminal writer | Status |
|---|---|
| `device-departure.service.ts:289` | ✅ already stamped by #241 (`TICKET_CANCELLED`) |
| `plant-deactivation.service.ts:177` | ✅ already stamped by #241 (`TICKET_CANCELLED`) |
| `auto-recovery.service.ts:268` | ✅ already stamped (`AUTO_RECOVERY`) |
| `verification.service.ts:135` (manual auto-recovery) | ❌ fixed here |
| `verification.service.ts` `finalize` (CLOSED / FAILED_VERIFICATION) | ❌ fixed here |
| `recovery.service.ts` `confirmWarehouseReceipt` | ❌ fixed here |
| `recovery.service.ts` `closeWith` (manual close + failed-recovery close) | ❌ fixed here — **not named in the original list** |
| `install-lifecycle.service.ts` `closeVerified` + `failActivation` | ❌ fixed here |
| `non-operational.service.ts:405` (CLOSED_NON_OPERATIONAL) | ❌ fixed here — **not named in the original list** |

Two terminal paths the original list missed (recovery's shared `closeWith`, and the non-operational
auto-close) are the reason the fix went in behind **one shared writer** rather than six inline copies:
`retireAssignmentOnClosure` (`src/scheduling/close-assignment.ts`).

Also corrected: `committedDayLoad` is at **`recommender.service.ts:926-937`**, not `:600-607`.

## The defect

No closure path clears a ticket's assignment or removes its live batch row. The complete list of
`assignmentState: 'UNASSIGNED'` writers in `src/` (grep 2026-07-29): the component-request
resubmit RETURN_TO_POOL (`component-request.service.ts:243`), the two ZM override paths
(`override.service.ts:152`, `:203`), and read-side `where` clauses. Verification close, recovery
close (`recovery.service.ts:157`), install close (`install-lifecycle.service.ts:238`),
device-departure cancel (`device-departure.service.ts:286`) and plant-deactivation cancel
(`plant-deactivation.service.ts:176`) all set a terminal status and touch neither
`assignment_state` nor `batch_assignment_tickets.removed_at`.

**Measured 2026-07-29 (dev DB, read-only):** 351 tickets are `CLOSED` + `FORMALLY_ASSIGNED` with
live batch rows. The arithmetic closes exactly: 7,150 live batch rows = 6,799 OPEN assigned +
351 CLOSED.

## Backfill population re-measured 2026-08-20 — and it is #243's C1 + C3

**Do not execute this backfill without an operator decision.** The probe
(`npm run closure-backfill:probe`, read-only) measured the dev mirror at implementation time:

| Class | Count |
|---|---|
| Live batch rows on resolved tickets | **3,310** |
| Resolved tickets still `FORMALLY_ASSIGNED` | **4,402** |

The issue's headline figure of **351** is stale by an order of magnitude — it was measured
2026-07-29, before #128's departure backfill and #241 landed.

These are not a new population. They are **exactly** [#243](./243-dev-data-cleanup-stranded-assignments.md)'s
already-ratified cleanup classes, and the arithmetic closes to the row:

```
C1  live rows on resolved/cancelled tickets      3,310
C3  resolved + FORMALLY_ASSIGNED with no row     1,092
                                                 -----
    resolved tickets still FORMALLY_ASSIGNED     4,402   ✓ probe
```

So this slice's backfill and #243's C1+C3 would write to the same rows, with **different reasons** —
`TICKET_RESOLVED` here, `DEV_CLEANUP` there. #243 is HITL-gated, ratified, and explicitly not to be
executed without fresh approval, and `DEV_CLEANUP` is documented as *its own rollback handle*. Running
this backfill first would silently consume #243's C1+C3 and destroy that handle.

**Disposition:** the mechanism above is complete and live, so the population stops growing from now.
The historical residue is left to #243 as a **backlog-ownership decision for the operator** — either
fold C1+C3 into #243's single audited cleanup (recommended: it keeps one rollback handle), or rule
that #178 owns them and amend #243's scope. Nothing was written either way.

## Why it matters (not cosmetic)

1. **Phantom capacity, forever.** `committedDayLoad` counts live batch rows on live schedules
   with **no ticket-status filter** (`recommender.service.ts:600-607`) — a closed ticket burns a
   capacity slot until its schedule dies, and per #147 nothing ever closes a schedule. The SE
   looks loaded with work that is finished; the recommender under-fills them accordingly.
2. **The SE day plan serves closed tickets.** The day-plan read filters `removedAt` only
   (`day-plan-query.service.ts:54-57`) — finished work renders as live stops-content.
3. **Every consumer of "live assignment" inherits the lie** — admin assignment context, ZM
   schedule views, #179's preview arithmetic (its predicate excludes them, but the class must be
   *reported*, and today it is invisible).

## What to build

1. **Mechanism**: on terminal closure (all paths listed above), stamp the ticket's live batch row
   `removed_at = now` with a system-attributed `removed_by`, in the same transaction as the status
   flip. Consider a shared helper so the six call sites cannot drift (the #153 lesson: one
   predicate, one writer). Whether to also flip `assignment_state = 'UNASSIGNED'` on closure is a
   semantics choice — recommend yes for invariant cleanliness ("FORMALLY_ASSIGNED ⇒ live work"),
   but the batch-row stamp is the load-bearing half (both `committedDayLoad` and the day plan key
   on `removed_at`).
2. **Backfill the 351** (dry-run-gated, #128 posture): stamp their live batch rows and clear
   assignment state; report before/after counts. Probe first — do not assume the count still
   matches at execution time.
3. **Regression**: e2e per closure family (verification close, recovery warehouse-receipt close,
   departure cancel, deactivation cancel) asserting the batch row is stamped and committed load
   drops.

## Acceptance criteria

- [ ] Closing a ticket by any path removes it from `committedDayLoad` and from the SE day plan in
      the same transaction (e2e per closure family)
- [ ] `FORMALLY_ASSIGNED ⇒ status is live` holds after the backfill (query-asserted); the 351
      measured on 2026-07-29 are cleaned up with a dry-run report first
- [ ] No history destroyed: batch rows are stamped, never deleted; `removed_by` distinguishes the
      system actor from ZM removals
- [ ] #146 interplay: the closure stamp must NOT set `deferred_to_date` and must not disturb the
      removal-scoped scorecard reads (`recommender.service.ts:548-555` family)

## UI surfaces

n/a (data correctness; existing surfaces get truthful numbers).

## Reference

n/a.

## Blocked by

- None. Independent of #179 (whose predicate already excludes CLOSED); lands whenever. Touches the
  same tables as #147's schedule-closure work — coordinate, don't merge: this is ticket-level,
  #147 is schedule-level.
