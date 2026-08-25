# 288 — An SE who becomes unavailable mid-day does not silently strand their work

Status: **ready-for-agent** (policy ruled — [#282](./282-decision-todays-dispatch-crew-deck.md) R4)
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

- [ ] AC1 — Approving leave covering today for an SE with live remaining work raises escalations for
      that work and notifies the ZM.
- [ ] AC2 — Already-resolved / already-removed tickets are not escalated.
- [ ] AC3 — **Nothing is reassigned automatically**; the original assignment rows are untouched and
      the day plan is not rewritten.
- [ ] AC4 — No duplicate escalation for the same ticket (the existing guard holds).
- [ ] AC5 — The escalations are actionable through the existing manual-assign path.
- [ ] AC6 — Backend suite green.