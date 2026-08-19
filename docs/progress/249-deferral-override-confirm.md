# #249 — a return-date deferral can be overridden, never bypassed

**Done 2026-08-19**, commit `2a3ddc0`. Backend + Admin — one vertical slice, with one surface
deliberately left in the working tree (below).

## What this closes

Decision 17. `OverrideService.assignTicket` checked existence, zone scope and `ALREADY_ASSIGNED`, and
**never consulted `notDeferredOn`**. So the Critical Work Queue's one-click assign would put a ticket
whose vehicle is away until Friday straight onto today's plan: silently, with nothing in the audit
trail naming the hold it walked through, and leaving `deferredUntil` standing on a now
`FORMALLY_ASSIGNED` ticket for whatever read it next.

What hid it is that the *bulk* path already honoured the deferral — `assignPlants` filters at selection
(#146) — so the system looked correct from the outside. The gap is only reachable by handing a ticket
to the primitive directly, which is exactly what every per-ticket assign surface does.

## The shape

A refusal that can be answered, not a refusal that ends the conversation:

- **Unconfirmed** → `CONFLICT_DEFERRED` (409) carrying the deferral date and, when a report exists, the
  SE's `proposedFrom` beside the authoritative `expectedFrom`. #245 separated those two on purpose, and
  a manager overruling a hold should be able to see whether they are overruling the field or a
  colleague's decision.
- **Confirmed with a reason** → proceeds, writes an `OVERRIDE_DEFERRED_ASSIGN` audit row naming the
  deferral and the report it overrode, and **spends the deferral** on assignment, the way dispatch
  does. A live `deferred_until` on assigned work is the verified stale-deferral edge this closes rather
  than creates.
- **Confirmed with no reason** → `REASON_REQUIRED`. Overruling a hold somebody placed for a stated
  reason is the one action whose "why" is the entire accountability record.

The **report itself is untouched**. Overriding the hold says "assign it anyway", not "the vehicle is
back" — only #245's decide path may move a return date.

This is deliberately the existing `CONFLICT_ON_SITE` mechanism rather than a second one: same 409
shape, same `confirm` + reason, same banner. A surface that already answers one answers the other, and
the alternative is two confirm vocabularies that drift.

## Where the rule lives

In `assignTicket`, once. `SameDayUpdateService.addTicket` passes the caller's decision through rather
than deciding anything, so AC1's "no code path" is a property of the primitive instead of a convention
three call sites each have to remember. Both controller legs (`POST /schedules/assign`,
`POST /intraday-updates/add`) map it identically.

Move actions (REASSIGN / SPLIT_BATCH / SWAP_SE) get the same gate as **defence in depth** and
**preserve** the deferral — only an assignment-creating action spends one. Structurally that branch is
near-vacuous, since a deferred ticket has no live batch row to move; it is reachable only through the
edge this same slice closes. Gated anyway, because "you can only get here through a bug we just fixed"
is not a guarantee.

REMOVE / DEFER / REORDER are deliberately outside the gate: none creates an assignment, and refusing to
*withdraw* or re-order a held ticket would obstruct the very actions that respect the hold.

## Pinned rather than assumed

- **The intraday accept can never reach the branch.** `fireForZone` selects with `notDeferredOn`, so a
  deferred ticket is never offered and therefore never accepted. That is a property of a *different*
  file, which is precisely why it is asserted here: the accept path calls `assignTicket` with no
  deferral argument, so if that sweep ever stopped spreading the predicate, accepts would start failing
  with `CONFLICT_DEFERRED` and nothing else would notice.
- **`assignPlants` is byte-identical** — deferred tickets excluded at selection, no 409 to swallow, no
  silent skip to explain.
- **A lapsed deferral is not a hold.** The branch keys on `isNotDeferredOn`, the same inclusive-on-the-day
  predicate every reader of unassigned work spreads in, so the normal path gains no friction at all.

## Two corrections to the issue's own text

Both recorded in the issue file in place.

**"Device Detail assign" is the bulk `assign-plants` panel** (`AssignSePanel`), which excludes deferred
tickets at selection and can never reach the branch — AC3 pins exactly that. No dialog belongs there.
The genuine second *per-ticket* admin assign is the Commissioning Cohort per-device control.

**There is no admin control for the ZM same-day ADD.** `IntradayQueuePage` is a read-only view over the
audit log. The backend leg is plumbed and refuses/accepts identically, so AC1 holds; there is simply no
dialog to add until that surface is built.

## What is committed, and what is not

`DeferralConfirm` (shared component) is wired to the **Critical Work Queue** assign and committed. It
holds the assign per cluster, shows the dates, requires a reason, and resends with `confirm` — applying
that confirm only to the ticket that raised it, never to the rest of the cluster, since a manager who
overrode one hold has said nothing about any other.

The **Commissioning Cohort** per-device assign is wired to the same component, typechecks and passes,
but is **not in `2a3ddc0`**: that control does not exist at HEAD — it is part of the ~73 files of
uncommitted in-flight work (#236) this session was told not to sweep. The change sits in the working
tree and lands when #236 does. At HEAD, the Critical Work Queue is the only per-ticket assign surface,
and it is covered.

## Test sensitivity

Eight backend tests + three admin tests, RED before GREEN. Seven probes, each turning exactly the
intended test red:

| Probe | Went red |
|---|---|
| no deferral gate on `assignTicket` | the refusal, the reason requirement, the confirmed override |
| treat any deferral as a hold (lose the day boundary) | the lapsed-deferral case |
| do not spend the deferral on assignment | the confirmed-override case |
| remove the move gate | the REASSIGN case |
| confirm button not gated on a reason | the empty-reason case |
| the 409 left untranslated in the API client | all three admin cases |
| confirm sends an empty reason | the resend case |

Full admin suite 518/518, `tsc --noEmit` and `vite build` clean. Backend scheduling, intraday,
cross-zone, day-plan, bulk-unassign and scheduler-preview suites green unchanged.

## Files

- `src/scheduling/override.service.ts` (the gate, `openVuContext`, `deferredTicketIds`),
  `same-day-update.service.ts`, `schedules.controller.ts`, `batches.controller.ts`,
  `intraday-updates.controller.ts`
- `apps/admin/src/api/schedules.ts` (`DeferralConflictError`),
  `src/components/domain/DeferralConfirm.tsx` (new), `src/pages/dashboard/CriticalQueue.tsx`
- `test/deferral-override-confirm.e2e-spec.ts`, `apps/admin/test/deferral-override-confirm.test.tsx`

No migration, no schema change. The new outcome variants are additive; every existing caller keeps its
behaviour unless it opts in.
