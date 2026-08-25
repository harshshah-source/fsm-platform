# 288 — An SE who becomes unavailable mid-day does not silently strand their work

Status: **done** (2026-08-25) — report [`docs/progress/288-mid-day-unavailability-escalation.md`](../../../docs/progress/288-mid-day-unavailability-escalation.md)
Type: AFK · Backend (+ the #285 surface)
Decision: #282 R4 (operator, 2026-08-25) — **escalate-only. Nothing re-plans automatically.**

## Objective

When an engineer becomes unavailable after dispatch, their remaining committed work becomes visible
as work needing a human decision — instead of sitting on a plan nobody will execute.

## Current behaviour (verified)

Nothing re-plans committed work when availability changes. `LeaveRequestService.approve`
(`leave-request.service.ts:89-92`) writes an `SeAvailability` window; that window only affects the
**next** selection pass. `hard-filters.ts:9-13` retires the ADR-0016 heartbeat filter and points at
"Acceptance Timeout + reroute (Issue 29/30)" — machinery **#268 deleted**. So the documented recovery
path for intra-day unreachability no longer exists, and no replacement was filed.

## Required change

Detect that a live day plan's engineer is unavailable for the operating day, and raise escalation
entries for their remaining live tickets through the **existing** `ESCALATION_REQUIRED` +
`escalateToZm` path (`intraday-insertion.service.ts:346-359`, `:452-464`). A human redistributes
through the existing manual-assign flow. **No automatic reassignment, no capacity bypass, no removal
of the original assignment** — the plan history stays intact and auditable.

Re-use the existing re-escalation guard (`intradayInsertions: { none: { status:
'ESCALATION_REQUIRED' } }`, `:168`) so one unavailability does not produce a storm.

## Acceptance criteria

- [x] AC1 — Approving leave covering today for an SE with live remaining work raises escalations for
      that work and notifies the ZM. **One alert, not one per ticket** — the ledger needs a row each,
      but the decision is single, and eight alerts for eight stops is the storm the guard prevents.
      Hooked to `SeAvailabilityService.setAvailability` (which `approve` delegates to), so a manager or
      SE setting a window directly is covered by the same rule rather than a second definition.
- [x] AC2 — Already-resolved / already-removed tickets are not escalated. "Remaining" is the existing
      pair of facts: a live day-plan row (`committedDayPlan`'s predicate) whose ticket is still `OPEN`.
- [x] AC3 — **Nothing is reassigned automatically**; the original assignment rows are untouched and
      the day plan is not rewritten. Pinned by asserting the batch-ticket row is identical afterwards.
- [x] AC4 — No duplicate escalation for the same ticket (#268's guard, reused verbatim).
- [x] AC5 — The escalations are actionable — **and the path is the override/reassign one, not the
      queue's Assign.** AC3 and the queue's Assign cannot both hold: `assignTicket` refuses a
      `FORMALLY_ASSIGNED` ticket, and stranded work is still formally assigned precisely because AC3
      requires it. Freeing the work first would be the automatic re-plan #282 R4 forbids. So the rows
      carry who holds the work, the queue offers "Reassign on the day plan →" instead of a button that
      would 409, and the cockpit strip stops asserting the capacity cause over a mixed list. The dead
      end itself is pinned by a spec. See the report's "The conflict between AC3 and AC5".
- [x] AC6 — Backend suite green (blast radius + full run); admin **112 files / 657 tests**;
      `tsc --noEmit` clean on both.