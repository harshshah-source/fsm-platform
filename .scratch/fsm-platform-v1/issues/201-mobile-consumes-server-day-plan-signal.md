# 201 — Mobile consumes the server's day-plan change signal (and handles rebalance + closure)

Status: ready-for-agent — **UNBLOCKED 2026-08-04**: [#200](./200-decision-deferred-vs-removed-presentation.md) ruled server-authoritative, defer distinguished from remove, and a bulk rebalance gets its own "plan being rebuilt" state. All three conditional ACs below are now live.
Type: AFK · Mobile
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04

## Root cause

#161 shipped a server-authoritative signal for day-plan changes (`removedFromPlanAt`,
`deferredToDate`) and #66, which predates it, derives the same information client-side by diffing
consecutive fetches in memory. The client diff cannot see a change that happened while the app was
closed, cannot tell a defer from a removal, and resets on every cold start. The result is that the
authoritative fields have **zero readers** while the SE relies on a strictly weaker derivation — and
two other ways the server can change a plan (bulk rebalance, schedule closure) have no mobile
handling at all.

## Findings closed

Audit 2: **D1** (server signal unread), **D2** (`DAY_PLAN_REBALANCED` dead-end tap), **D3** (schedule
closure has no mobile state).

## Evidence — verified 2026-08-04

- Server publishes both fields on every `/api/me/tickets` row:
  `me-tickets-query.service.ts:61-68` (today-scoped source) and `:127-128` (assignment); contract at
  `packages/shared/src/index.ts:103-114`.
- **Zero production readers on mobile**: grep for `removedFromPlanAt` / `deferredToDate` across
  `apps/mobile/src` returns only three test fixtures (`homeKpi.test.ts:25-26`,
  `HomeScreen.test.tsx:72-73`, `TicketsScreen.test.tsx:53-54`).
- Client diff instead: `dayPlanCues.ts:20-41`, whose own comment at `:12-19` says it exists "since
  the server has no 'added/removed since' signal" — **no longer true**.
- Cold-start blind spot: `dayPlanCues.ts:23-26` returns no cues on the first call after launch.
- Defer collapsed into remove: `TicketsScreen.tsx:149,172` render one
  `{ label: 'Removed', status: 'critical' }` badge; `deferredToDate` (and therefore the return date)
  is never shown. Backend keeps them distinct — `override.service.ts:23-24`, `:129-158`, `:165-210`.
- Bulk unassign is a dead-end tap: `bulk-unassign.service.ts:358-366` writes
  `type: 'DAY_PLAN_REBALANCED'` with `entityType: 'zone'`; `NotificationsScreen.tsx:57` routes only
  `entityType === 'ticket'`, so tapping it marks read and does nothing. It also deliberately leaves
  the schedule status untouched (`:289-295`), unlike every override action.
- Schedule closure: `schedule-closure-scheduler.service.ts:162,167` write `PARTIAL`/`COMPLETED`, both
  excluded from `LIVE_SCHEDULE_STATUSES` (`schedule-status.ts:15,22`) — so the SE's plan silently
  empties with no "day closed out" state. #147's UI-surfaces line explicitly disowns the mobile side.
- PRD intent: `:510` requires the SE be shown removals; `:404` specifies the push copy. So this is a
  spec conformance gap, not a new feature.

## Scope

**In:** read `removedFromPlanAt`/`deferredToDate` from `/me/tickets` and drive the Tickets-list cue
from them; render a distinct state for a deferred ticket (pending #200 Q1); handle a closed schedule
with an explicit state rather than an empty list; make a `DAY_PLAN_REBALANCED` notification do
something coherent when tapped.

**Out:** push delivery of any of these (#89, external). Per-ticket "[ZM Name]" attribution — that was
#66's stated Option B trigger and still has no endpoint. A change-feed endpoint: not needed, the
fields are already on the existing read.

**Depends on the #200 ruling** for: whether defer reads differently from remove (Q1), whether the cue
survives a cold start (Q2 — if "no", this slice reduces to the rebalance + closure legs), and what a
rebalance should say (Q3).

## Acceptance criteria

- [ ] The removed/changed cue is derived from the server fields, not from an in-memory diff
- [ ] A removal that occurred while the app was closed is visible on first launch (if #200 Q2 = A)
- [ ] A deferred ticket is distinguishable from a removed one and shows its return date (if #200 Q1 = A)
- [ ] A `COMPLETED`/`PARTIAL` schedule renders an explicit end-of-day state, not an empty list that
      looks identical to "no plan yet"
- [ ] A `DAY_PLAN_REBALANCED` notification tap does not dead-end — it lands somewhere coherent or is
      rendered as non-tappable
- [ ] `dayPlanCues.ts`'s stale "the server has no signal" comment is corrected or the module retired
- [ ] Regression tests: cold-start visibility, defer-vs-remove rendering, closed-schedule state.
      **Cheap** — `dayPlanCues.test.ts` and `TicketsScreen.test.tsx` already exist and already carry
      fixtures containing both fields.

## Verification

```bash
cd apps/mobile && npx jest src/tickets/dayPlanCues.test.ts src/navigation/screens/TicketsScreen.test.tsx
```
Plus, against the #210 dataset: remove a ticket from the SE's batch via the admin override, fully
kill and relaunch the app, and confirm the cue is still shown.

## Risk if deferred

An SE closes the app between plants — the normal way a phone is used in the field — and never learns
their plan changed. They drive to a plant that is no longer theirs. Where the change was a *defer*,
they are told "Removed" for work that is actually returning on a known date. This is the exact
failure the same-day update cue exists to prevent, and the data to prevent it has been on the wire
since 2026-08-03.

## Size estimate

S-M, and smaller than it looks — the fields are already fetched and already in the shared types; most
of the work is deciding what to render and retiring the diff.
