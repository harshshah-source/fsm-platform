# 200 — DECISION: how is a *deferred* ticket shown to the SE, and does "removed" survive a cold start?

Status: needs-triage — **decision required before [#201](./201-mobile-consumes-server-day-plan-signal.md) can be built**
Type: HITL · Decision · Mobile
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04

**Nothing is decided in this issue. It exists to put the options in front of a human.**

## Root cause

The PRD specifies that a removed ticket shows a "removed" label "for one session", and separately
gives the ZM two distinct override actions — Remove and Defer-with-a-date. It never says how the SE
should tell those apart, and "for one session" is ambiguous about an app restart. #66 built a
client-side set-diff against that ambiguity; #161 later shipped a server-side signal that
distinguishes the two cases and survives restarts. Which behaviour is actually wanted has never been
ruled on, so the fields sit unread.

## Findings closed

Part of audit 2 **D1** (the presentation half; the "fields have no reader" half is #201's).

## Evidence — verified 2026-08-04

- `docs/PRD-fsm-admin-dashboard.md:510` — "updated Ticket is highlighted (new addition at top of
  affected plant group; **removed Ticket shows 'removed' label for one session**)." This is the only
  durability statement, and "one session" is undefined against a cold start.
- `PRD:376` and `PRD:106` — Remove Ticket (×) and **Defer Ticket (date picker)** are separate ZM
  actions. Backend keeps them separate: `override.service.ts:23-24`, handled at `:129-158`
  (`DEFER_TICKET`) and `:165-210` (`REMOVE_TICKET`).
- Server already distinguishes them for the SE: `me-tickets-query.service.ts:127-128` sets
  `removedFromPlanAt` (presence signal) **and** `deferredToDate` (set only for a defer), contract at
  `packages/shared/src/index.ts:103-114`.
- `#66` deliberately chose the client diff: *"**Option A (adopted):** the client caches the previous
  ticketId set… **Option B (only if per-ticket [ZM Name] attribution is required):** add an SE-scoped
  same-day change-feed endpoint. Not adopted."* Its rejection reason was attribution — **not**
  cold-start durability, which is a consequence nobody weighed at the time.
- Today's behaviour: `dayPlanCues.ts:23-26` returns no cues on the first call after a cold start, and
  `TicketsScreen.tsx:149,172` renders one generic `{ label: 'Removed', status: 'critical' }` badge
  for both cases, with no return date.
- **No document specifies the defer presentation.** Nothing in `CONTEXT.md`, the PRD, the workflow
  doc or `docs/ui/mobile/` distinguishes them SE-side.

## The decision

### Q1 — Should a deferred ticket read differently from a removed one?

**Option A — distinguish them.** "Moved to 14 Aug" vs "Removed from today's plan". The data is
already on the wire (`deferredToDate`), so this costs one badge variant. An SE who sees "Removed"
for a ticket that is actually coming back on Thursday has been told something false.

**Option B — keep one label.** Simplest, matches PRD:510's literal wording (which only ever says
"removed"). Accepts that defer and remove are indistinguishable to the field.

### Q2 — Does the "removed" cue survive an app restart?

**Option A — yes, server-authoritative** (the `removedFromPlanAt`-within-today window #161 already
implements). An SE who closes the app at lunch and reopens it still learns their plan changed.
Matches PRD:510's intent that the SE is *told*.

**Option B — no, session-scoped** (today's behaviour). Literal reading of "for one session". Means a
removal that happens while the app is closed is **never** shown — the SE may drive to a plant that
was taken off their plan hours earlier.

*Note:* Q2 Option A is what makes #201 worth building at all. If Q2 resolves to Option B, #201
reduces to the defer/bulk-unassign/closure legs only, and the fields stay unread by design — which
should then be recorded on #66 so the next reader stops re-discovering it.

### Q3 — What should a *bulk unassign* say?

`bulk-unassign.service.ts:270-273` sets the same `removedAt`, but deliberately leaves the schedule
untouched (`:289-295`) and sends a different message — "your day plan will refresh on the next
dispatch run" (`:358-366`). Should that read as "Removed", or as its own "plan being rebuilt" state?
It is operationally different: nothing is coming back today under a remove, whereas a rebalance
means *wait*.

## Acceptance criteria

- [ ] Q1, Q2, Q3 answered; the answers recorded on this issue and reflected into #66's comment log
- [ ] If Q2 = A: #201 is unblocked to consume the server fields
- [ ] If Q2 = B: #66 is annotated with the accepted consequence, and #201 is re-scoped

## Verification

Ruling recorded; #201's ACs rewritten to match; #66 annotated either way.

## Risk if deferred

An SE can be shown "Removed" for a ticket that is deferred to a specific future date, or shown
nothing at all for a plan change that happened while the app was closed — and then travel to a plant
that is no longer theirs. The cost of that is a wasted field trip, which is exactly the class of
error the same-day update cue exists to prevent.

## Size estimate

Decision: S. Implementation (#201): S-M.
