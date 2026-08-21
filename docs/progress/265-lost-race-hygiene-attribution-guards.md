# #265 — Lost-race hygiene: clean conflict answers and first-writer-wins attribution (TDD completion report)

**Date:** 2026-08-21 · **Branch:** `feat/autoplant-integration` · **Type:** AFK · Backend
**Issue:** [`.scratch/fsm-platform-v1/issues/265-lost-race-hygiene-attribution-guards.md`](../../.scratch/fsm-platform-v1/issues/265-lost-race-hygiene-attribution-guards.md)
**Decision:** #258 Parts 5–6 (G4, G7)
**Sequenced as:** P8 item 8 — independent, and a **hard prerequisite of #275**, whose AC-8 ("a lost
race returns a clean 4xx for that ticket, never a 500 and never a silent skip") is unbuildable without it.

> Frozen once written, per the progress convention. Corrections go to INDEX / SYSTEM-STATE.

## What was wrong

Every manual write in `OverrideService` was `read → check in JS → write by primary key`. Under READ
COMMITTED that means two writers both pass the check, and the second either crashes into a partial
unique — an unhandled P2002, which leaves the service as a **500** on paths both controllers map
carefully to a 409 — or **silently overwrites the first writer's row**.

The second is the worse one, because it is invisible. The 04:00 closure recycle guards its own writes
and states exactly why (`schedule-closure-scheduler.service.ts:255-265`): *"keying only on `id` would
then overwrite their actor and reason with a system stamp — and #244 reads that reason as a predicate,
so the mistake would be an operational reclassification rather than a visible one."* The guard was on
the side that loses. The side that wins had none.

None of this was academic on a branch that just shipped an M→N assign console: the entire point of
#272 is several managers moving work at once.

## Two measured facts decided the shape, and the usual idiom is wrong here

A throwaway probe against real Postgres, before any implementation:

**`meta.target` does not exist here.** Under this repo's Prisma driver adapter a P2002 carries no
`target` — the field every Prisma example keys on. The identity is at
`meta.driverAdapterError.cause.constraint.fields`, with the index name only in the raw message:

```
code=P2002 meta={"modelName":"BatchAssignmentTicket","driverAdapterError":{...,"cause":{
  "originalMessage":"duplicate key value violates unique constraint
    \"batch_assignment_tickets_one_active_per_ticket\"", "constraint":{"fields":["ticket_id"]}}}}
```

`modelName` is the discriminator (`src/common/unique-violation.ts`), and here it is **exact**:
`batch_assignment_tickets` and `work_schedules` each carry exactly one unique constraint, a raw
partial index invisible to `schema.prisma`. That assumption is written into the helper's docblock
rather than left implicit — a second unique on either table means it must start reading
`constraint.fields`.

**A P2002 inside an interactive transaction aborts it.** Postgres answers every subsequent statement
with *"current transaction is aborted, commands ignored until end of transaction block"*. So item 2's
"catch → re-find → proceed" is **not implementable in place**; recovery has to let the whole
transaction roll back and retry it from outside. That rollback is also what makes item 3's "write no
audit row" free rather than fiddly: `withAudit` writes the audit row *inside* the same transaction, so
a rolled-back attempt leaves no trail claiming an action that never happened.

## Two defects found that the issue did not describe

**`ensureSchedule` was broken with no concurrency at all.**
`work_schedules_one_active_per_se_zone_day` is partial-unique on `(se_id, zone_id, date_from)`.
`batch-assignment.service.ts:128` looks the row up on exactly those three columns. `ensureSchedule`
matched **`date_to` as well** — two call sites, two different answers to "which row is this engineer's
schedule for this day", and the database agreeing with only one of them. Give an engineer any live
schedule whose `date_to` differs — a multi-day plan, which `swapSe` and `moveTickets` propagate by
handing the *source* batch's range down, or a null one, which the column allows — and **every** manual
assign to them for that day found nothing, created, and died on the index. A deterministic 500, no
race involved. The find now matches the constraint that governs it; since the index permits no second
ACTIVE row for the day, attaching to the one that exists is the only legal outcome.

**`flagOverridden` resurrects closed day plans.** Every override action ends by calling it, and it
wrote `status: 'OVERRIDDEN'` to `work_schedules` by primary key with no liveness guard. `OVERRIDDEN`
is a **live** status (#153's `LIVE_SCHEDULE_STATUSES`) while `COMPLETED`/`PARTIAL` are terminal — so an
override landing on a plan the 04:00 closure already shut brings it back to life, which is precisely
what `schedule-status.ts` warns of: *"widening past those would resurrect finished work onto today's
plan."* No race needed; a manager on a stale screen is enough. `swapSe` spells the same stamp inline
and carried it too.

Fixed **narrowly**: the withdrawal still happens (the ticket returns to the pool, harmless on a
finished plan) and only the meaningless provenance stamp is declined. Whether an override should be
*refused outright* on a terminal schedule is a lifecycle question owned by **#271**, not one to smuggle
in here.

## Slices (red → green)

| # | Seam | Red produced |
|---|---|---|
| 1 | `assignTicket` loses the ticket race | raw P2002 out of `:424` — `Unique constraint failed on (ticket_id)` |
| 2 | concurrent assigns to one schedule-less SE | **passed immediately — proved nothing** (see below) |
| 2b | live schedule with a differing `date_to` | `Unique constraint failed on (se_id, zone_id, date_from)` |
| 3 | remove vs the closure recycle | `expected '<zm-uuid>' to be null` — attribution clobbered |
| 4 | `deferTicket` + `moveTickets` removal leg | same, both |
| 5 | `manualAssign` on a held ticket | `expected 'NOT_FOUND' to be 'CONFLICT_DEFERRED'` |
| 5b | the single retry, at its own seam (unit) | `retryOnceOnUniqueViolation is not a function` |
| 6 | override lands on a closed plan | `expected 'OVERRIDDEN' to be 'COMPLETED'` |
| 7 | `accept` on a ticket held mid-flight | `expected 'PENDING_ACCEPTANCE' to be 'ESCALATION_REQUIRED'` |

## AC-2's concurrent pair does not reliably interleave, and that is worth recording

`Promise.all([assignTicket(), assignTicket()])` was written for AC-2, passed on the first run, and
proved nothing. That is the exact trap `test/support/concurrency.ts` was built by #107 to name: an
unbarriered race *"passes without ever having tried the case it claims to cover."* Reaching for it
before writing the test would have saved the detour.

The test is **kept** — it pins the required outcome (both callers succeed, exactly one schedule row) —
with that limitation stated in the test itself rather than implied. The sensitivity comes from the
deterministic `date_to` sibling above, which reds on demand.

## Where the race windows are, and which one nothing can reach

`override()` takes no injection point. But **`AuditService` is an injected collaborator, and every
affected writer does its pre-read *before* calling `withAudit`** — so gating that call from the test
opens precisely the gap between the read and the write. No production seam was added for a test's
benefit; the spec patches an injected dependency and restores it.

The one window nothing reaches is `ensureSchedule`'s: it needs a writer to commit *between* a
`findFirst` and a `create` that sit inside a single interactive transaction, and no collaborator is
called in that gap. Rather than assert an untested fix or write another race that cannot fail, the
retry is a small function and is tested as one (`test/unique-violation.spec.ts`), including that it
retries **once and not until it works** — looping would turn a persistent constraint error into a hang
under load.

## Item 4 was two defects

`manualAssign` collapsed every non-OK answer into `NOT_FOUND`, which the controller renders as a 404.
So `CONFLICT_DEFERRED` — a resolvable condition with a confirm flow already built for it — reached the
ZM as "that doesn't exist"; they retry, get the same 404, and #249's flow was simply unreachable from
the escalation queue. It now surfaces the outcome and accepts `confirm`/`reasonCode`, mapped to the
**byte-identical** 409 body `/schedules/assign` already returns, `DEFERRAL_OVERRIDE_REASON_REQUIRED`
included, so one held ticket answers the same way through either door.

`accept` re-offered on a deferral. Correct for "somebody else took it"; useless for a hold, because
**no Service Engineer can clear one** — the next SE hits the identical refusal, and the next, until the
retry chain is exhausted and the ticket escalates anyway, hours later, with a trail recording several
engineers declining nothing. It escalates immediately now, guarded by the same `transitionOrConflict`
claim the surrounding code uses. That is only useful *because* the ZM's manual-assign path can now
resolve it — the two halves are one fix.

## The sweep (item 5), in full

| Action | Unguarded terminal write | Unhandled P2002 | Done |
|---|---|---|---|
| `assignTicket` | — | batch-ticket **and** schedule | both recovered |
| `removeTicket` | yes | — | guarded |
| `deferTicket` | yes | — | guarded |
| `moveTickets` | yes (in a loop) | schedule, via `ensureSchedule` | both |
| `swapSe` | yes (inline schedule stamp) | schedule, via `ensureSchedule` | both |
| `flagOverridden` | yes (schedule stamp) | — | guarded |
| `reorder` | none | none | **swept clean** |

`reorder` renumbers `stop_sequence` on `plant_batch_assignments`, which carries no unique constraint
and no terminal stamp. Two concurrent reorders can interleave into an order neither operator chose, but
nothing is lost and no attribution is overwritten — out of scope here, recorded so the next sweep does
not re-derive it.

`moveTickets`' guard sits **inside its loop**, which means losing the race on any single row fails the
whole move. That is deliberate: a REASSIGN that moved three of four tickets and reported success would
leave a half-moved plan nobody asked for. The throw rolls the transaction back whole, so the move
either happens or it does not.

## The UI instruction resolves to a handoff note

#265 asks to verify the two new paths reuse the existing conflict banners. They cannot: **the
intra-day manual-assign path has no admin client at all.** `GET :id/available-ses` and
`POST :id/manual-assign` are unreachable from the app, and **#277** owns building the modal.

The admin's `DeferralConflictError` / `DeferralConflict` already exist for `/schedules/assign`
(`apps/admin/src/api/schedules.ts:117-136`), and this issue's new 409 body is deliberately
**byte-identical** to the one they parse, `DEFERRAL_OVERRIDE_REASON_REQUIRED` included. So #277's
modal reuses that vocabulary instead of inventing a second one — which is the whole reason the
mapping was matched exactly rather than approximately. No admin code changed here, and none needed to.

## Verification

- Backend `tsc` clean.
- Targeted regression over the write path's blast radius: **18 files / 94 tests green**
  (`batch-override-*`, `bulk-unassign*`, `deferral-override-confirm`, `intraday-*`, `critical-assign`,
  `issue-122b-fleet-assign`, `removal-reason`, `schedule-closure*`) — AC-5's "full override/batch spec
  suite stays green", plus the closure specs, since this issue's whole subject is racing them.
- **Full backend suite: 400 files — 397 passed / 3 skipped / 0 failed, 1969 tests passed / 5 skipped,
  exit 0 on every chunk.** Run as four foreground chunks (`run-tests.mjs` takes an explicit file list)
  because background long-runs were being terminated by the environment mid-suite — twice, at 114 and
  37 files, both times with everything green and no failure. One #184 worker crash inside chunk 2,
  auto-retried and recovered.
- That run also surfaced a **#274 regression that had shipped**: `schedules-route-conflicts` builds its
  own test module, so #274's new controller dependency made its `beforeAll` throw. Fixed in `5c5cd43`.
  The #274 session-log row is corrected in INDEX — its run was `1 failed | 393 passed | 3 skipped`,
  exit 1, not the "0 failed / exit 0" first recorded. **`#184 AC-4: recovered — all N files accounted
  for` means every file ran, not that all passed**, and the `exit 0` quoted came from a trailing `echo`
  rather than the suite.

## Files

`src/common/unique-violation.ts` (new — P2002 recognition + the single retry) ·
`src/common/lost-race.ts` (new — `LostRaceError` + `stampOnceOrLose`) ·
`src/scheduling/override.service.ts` (`assignTicket`, `ensureSchedule`, `removeTicket`, `deferTicket`,
`moveTickets`, `swapSe`, `flagOverridden`) ·
`src/intraday/intraday-insertion.service.ts` (`manualAssign`, `accept`) ·
`src/intraday/intraday-insertion.controller.ts` (the deferral 409) ·
`test/lost-race-hygiene.e2e-spec.ts` (new, 9 tests) · `test/unique-violation.spec.ts` (new, 6 tests).
