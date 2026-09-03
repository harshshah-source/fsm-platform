# 345 — Plant deactivation reaches the SE's day-plan notice

**Done 2026-09-03.** Wave 1 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids AC-02 and SCH-02 — spine edge
**E-26** ("plant deactivation → SE plan", PRD story 51). Red-first.

## What it closes

An Operations Head deactivates a plant. Inside that one transaction the service closes every open
ticket on the plant, terminates the parent failure cycles, and — since #241 — ends the assignments
too: `batch_assignment_tickets` rows go `removed_at = now, removal_reason = TICKET_CANCELLED`.

The stop therefore vanished from the Service Engineer's Day Plan **while they were driving to it**,
and nothing told them. The plan read filters on `removed_at IS NULL`, so the next time the SE pulled
to refresh, the stop was simply gone: no notice, no reason, no plant name. Edge E-26 was carried by
"a human remembers to phone the engineer".

It now writes one `DAY_PLAN_OVERRIDDEN` outbox row per affected stop, **inside the deactivate
transaction**, carrying the new action `PLANT_DEACTIVATED` and the plant's name.

## Decisions worth keeping

**1. The read has to happen before the strip, because the strip is what destroys the evidence.**
`cancelOpenTickets` ends the assignments with an `updateMany` on `removed_at IS NULL`. After it runs,
the query "which live stops did this cancel?" answers nothing at all — every row it would have
matched now has `removed_at` set. So the affected batches are read first and the strip second, and
`cancelOpenTickets` returns `{ cancelledTickets, strippedStops }` rather than a bare count. The
alternative (re-reading by `removal_reason = TICKET_CANCELLED AND removed_at = now`) would work by
coincidence and break the first time two deactivations land in the same millisecond.

**2. "Lost a stop" means a stop on a plan that is still today's — `schedule-status.ts`, not a bare
`removed_at IS NULL`.** #242's nightly recycle has no writer yet, so a `batch_assignment_tickets` row
from last Tuesday is still live in the column sense. Notifying an engineer that a plant was removed
from a plan that stopped being theirs three days ago is noise, and noise in the one channel that also
carries "your Day Plan is live" is expensive. The predicate is therefore the platform's existing
definition of liveness at both levels — `liveScheduleFilter()` (`ACTIVE | OVERRIDDEN`, #153),
`liveBatchFilter()` (`AUTO_ASSIGNED | OVERRIDDEN`) — plus the IST day the plan covers
(`istDate(now)`, the `@db.Date` value `date_from`/`date_to` want). Re-spelling either status list
here is exactly the drift `schedule-status.ts` exists to prevent.

**3. One notice per stop, not per ticket.** A plant is one stop on the plan. An SE whose batch held
four of that plant's tickets lost that stop once, and four identical pushes would read as a fault.
The batches are de-duplicated into a `Map` keyed on `batch_id` before the enqueue, which is also what
makes the issue's "one row per SE" and the plan's "per affected batch" the same sentence: a batch is
one (schedule, plant, SE).

**4. `plantName` is a new *stored* field on `DayPlanOverriddenEvent`, and storing it is the point.**
AC2 asks the message to name the plant, and the notifier is a port with no database access, so the
name has to travel on the event. It is written into the payload rather than re-derived at delivery
because the row must say what the plant was called **when the plan changed** — a rename, or a
master-sync between the enqueue and the drain, would otherwise silently rewrite history in the notice
the SE finally reads. Optional (`string | null`), so every row written before this slice and every ZM
action that names no plant keeps working unchanged.

**5. `PLANT_DEACTIVATED` is the first action in the vocabulary that no Zonal Manager performed, and
that is why the copy had to change.** Every other member — `REMOVE_TICKET`, `DEFER_TICKET`,
`REORDER`, `SWAP_SE`, `REASSIGN`, `SPLIT_BATCH`, `MOVE_TICKET` — is a ZM override command verbatim,
sent by the SE's own manager, usually mid-conversation; the action word is the whole content and
"Your Day Plan was updated (REMOVE_TICKET)." is adequate. A deactivation arrives unannounced from an
Operations Head the engineer never spoke to, so the generic sentence leaves them with nothing to act
on. `dayPlanOverriddenBody()` branches on that one action and every other action's copy is byte-for-
byte what it was — pinned by a test.

**6. No post-commit drain here, deliberately — and it is a latency decision, not a durability one.**
Every #338 producer drains its own rows immediately after committing, so the notice does not wait for
a sweep tick. `PlantDeactivationModule` owns no `DayPlanNotifier`, and acquiring one means importing
`SchedulingModule` into it for a single port. The `business-notification-outbox` sweep already
carries that port and runs every two minutes (`DEFAULT_NOTIFICATION_OUTBOX_CRON`), which is the right
latency for news an engineer reacts to by *not* driving somewhere. The row is durable either way —
that is what the transaction bought. Wiring the port for an immediate drain is a strict improvement
and is listed as a follow-up below; this slice's file ownership did not include the module.

**7. Reactivation is untouched (AC3).** See "Decision recorded" below.

## What was tested, and why in that shape

**Two properties at the door, and they are different properties** — the shape #338 established:

- **Durability** — the delivery fails. The deactivation must still be committed (ticket `CLOSED`),
  the notice must survive as an unsent row carrying its `last_error`, the next drain must deliver it,
  and a *second* drain must not deliver it twice (the claim precedes the delivery).
- **Atomicity** — the *enqueue* fails. The deactivation must roll back with it. This is the only
  assertion that tells an in-transaction enqueue apart from a post-commit one that merely happens to
  write a row, and it is asserted on the **mutation** — ticket still `OPEN` with a null `closed_at`,
  no `plant_deactivations` row, no `PLANT_DEACTIVATED` audit row, the batch link still live — never
  on the notice.

**The crash rig is local to this spec, not the shared `test/fixtures/outbox-crash-injection.ts`.**
That fixture's `failingNotifyEnqueue` deliberately lets **day-plan** rows through: #338 needed a
`DAY_PLAN_OVERRIDDEN` row written in the same transaction to keep succeeding, or its rollbacks would
have been caused by the wrong write. A day-plan row is precisely what this slice enqueues, so reusing
it would have injected nothing. Widening the shared fixture with a flag would put a footgun in twelve
other specs' path for one caller's benefit; the ~25-line local proxy is the smaller cost. It also
respects the same trap the shared one documents — `withAudit` opens its transaction on the
**`AuditService`'s own** client, so the proxy is handed to both the service and its `AuditService` or
the write under test never sees it.

**The negative cases are two, not one**, because "no live stop" has two distinct causes and the
liveness predicate is the interesting half: a plant on **nobody's** plan (no batch row at all) and a
plant on a **stale** plan (a live batch row on a schedule dated three days ago). Both must produce
zero rows, and only the second one exercises decision 2.

Fixtures live in their own zone. The outer suite's dashboard AC asserts that its zone has disappeared
because every plant in it is deactivated, and a fixture plant landing in that zone would have made
that assertion pass or fail for the wrong reason.

## Acceptance criteria

- **AC1** — met. Every SE whose live plan lost a stop gets exactly one outbox row, written in the
  deactivate transaction; a plant on no plan and a plant on a stale plan produce none.
- **AC2** — met. `plantName` travels on the event and `SpineDayPlanNotifier` puts it in the body and
  the metadata; the nameless fallback is tested so a pre-#345 row can never print `undefined` at an
  engineer.
- **AC3** — met. `reactivate` is byte-for-byte unchanged, and a test pins it: reactivating restores
  no ticket, no stop and no notice.

## Decision recorded (§7 AC-03)

**Should reactivating a plant restore the tickets and stops the deactivation cancelled?**
**No — default assumed and kept, current behaviour unchanged.** A cancelled ticket is closed with a
real closure event and its failure cycle is terminated `FAILED`; the next pipeline run opens a fresh
cycle and a fresh ticket for any device still inactive, which is how reactivation has always been
specified (Issue 119). Resurrecting the old ticket would reopen a closed cycle, re-date the SLA clock
against a window nobody worked, and put a stop back on a Day Plan that has since been re-dispatched.
Recorded here as a Strategic HITL decision item; it did not block this slice.

## Tests, verbatim

New — 9 tests written for this slice:

- `plant-deactivation.e2e-spec.ts`, block `#345 — the SE whose plan lost a stop is told` (5):
  AC1/AC2 one row naming the plant · no live stop, no notice (unplanned + stale) · durability
  (failed push → committed, unsent, retried once, never twice) · atomicity (failed enqueue → the
  deactivation rolls back) · AC3 reactivation restores nothing.
- `day-plan-notification-outbox-writers.e2e-spec.ts` (4): the `PLANT_DEACTIVATED` row round-trips its
  action and plant name through the drain · a row with no plant name still delivers with
  `plantName` null · the Spine notifier names the plant in the body and metadata · the nameless
  fallback never prints `undefined` · every other override action's copy is untouched.

As run:

- `plant-deactivation` + `day-plan-notification-outbox-writers` — **2 files / 19 passed**.
- Outbox, notifier and sweep neighbours (`day-plan-notification-outbox`,
  `notification-outbox-generic`, `day-plan-notifier-spine`, `notifier-adoption-wiring`,
  `business-sweep-scheduler-wiring`, `batch-dispatch-notify`, `day-plan-notification-counts`) —
  **7 files / 20 passed**.
- Override writers (`batch-override-remove`, `-defer-reorder`, `-swap-split`, `-move-day`,
  `-onsite`, `assign-batch`, `same-day-update-service`) — **7 files / 41 passed**;
  `override-schedule-live` timed out in its `beforeAll` under the parallel run and passes alone
  (**1 file / 5 passed**), which is load, not this change.
- `npx tsc --noEmit` — no error in any file this slice touched. (The tree carries pre-existing
  errors in `ingestion/snapshot-query.service.ts` and `ticketing/troubleshoot.controller.ts` from
  concurrent slices; neither is ours.)

## Follow-ups this slice does not own

- **An immediate post-commit drain for this producer.** Needs `plant-deactivation.module.ts` to
  import `SchedulingModule` for `DAY_PLAN_NOTIFIER` and the service to call `drainProducerRows`;
  worth ~2 minutes of latency, no durability change. Outside this slice's file ownership.
- **#337** — the push exit itself. The outbox delivers to `NotificationService`; what leaves the
  building is that slice's problem, and until it lands the SE's notice stops at the channel seam.
- **#242** — the nightly recycle that would retire stale `batch_assignment_tickets` rows. Until it
  exists, decision 2's date predicate is what keeps this notice off dead plans.
