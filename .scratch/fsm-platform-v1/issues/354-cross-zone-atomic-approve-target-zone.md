# 354 — Cross-zone approve is atomic and the target zone is told
Status: ready-for-agent
Type: AFK
Wave: 3 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

Approving a cross-zone escalation can leave the system half-done, and the zone that receives the work
is never told.

`cross-zone-escalation.service.ts:162` commits the assignment inside `assignTicket`'s own transaction,
`:163` returns early on `ALREADY_ASSIGNED`, and `:166-178` updates the escalation to APPROVED outside
any transaction — a crash between the two leaves the ticket assigned and the escalation PENDING, and
a retry short-circuits on `ALREADY_ASSIGNED` (**#139**). `sweepAutoEscalations` (`:99-115`) does
create → audit → notify with no transaction and no per-ticket catch, after which the
`crossZoneEscalations: { none: {} }` predicate excludes that ticket forever (**#140**).
`notifyHomeZm` (`:319-320`) returns silently when a zone has no manager (CZ-09). The **target** ZM is
never notified, and `listForScope` (`:226`) scopes a ZM by `homeZoneId` only, so incoming work is
invisible to the zone that has to do it (CZ-11).

§1 correction: the survey's SCH-05 ("cross-zone assign notifies the home ZM, not the target SE") was
wrong — `assignTicket(..., 'CROSS_ZONE_ASSIGN')` already writes the target SE's outbox row at
`override.service.ts:850`. The target **ZM** is the one never told; that is what this slice fixes.

The #325 `inTransaction` hook on `assignTicket` is the ready-made seam for the atomic approve (CZ-01).

## Current code

- `cross-zone-escalation.service.ts:162` — assignment commits in `assignTicket`'s tx; `:163` — early
  return on `ALREADY_ASSIGNED`; `:166-178` — APPROVED written outside any tx.
- `cross-zone-escalation.service.ts:99-115` — `sweepAutoEscalations` create → audit → notify, no tx,
  no per-ticket catch; `crossZoneEscalations:{none:{}}` predicate excludes the ticket afterwards.
- `cross-zone-escalation.service.ts:319-320` — `notifyHomeZm` silent return when no ZM.
- `cross-zone-escalation.service.ts:226` — `listForScope` scopes ZM by `homeZoneId` only.
- `override.service.ts:850` — target SE outbox row already written (SCH-05 disproven).
- `assignTicket` `inTransaction` hook (#325) — the seam to use.

## What to build

- `cross-zone-escalation.service.ts`:
  - `approve` passes the #325 `inTransaction` callback to `assignTicket` so APPROVED + target ids are
    written in the same tx as the assignment.
  - `ALREADY_ASSIGNED` with a matching `assignedSeId` reconciles the escalation row instead of
    returning.
  - Sweep: per-ticket try/catch; enqueue notices via the #338 outbox helper.
  - `notifyHomeZm` → role-based resolver `notification.service.ts`
    `recipientsInRoles({ role: 'ZONAL_MANAGER', zoneId })` with a logged miss; add `notifyTargetZm`.
  - `listForScope` — OR on `targetZoneId` for ZM, with a `direction: 'incoming' | 'outgoing'` flag.
- `cross-zone.controller.ts` — map non-OK results (CZ-13).
- Admin `CrossZonePage.tsx` — incoming badge.
- Tests: `cross-zone-escalation.e2e-spec.ts`, `cross-zone-controller.e2e-spec.ts`.

## Acceptance criteria

- [ ] AC1 — a crash injected after the assignment tx cannot leave the escalation PENDING (the row
      flips inside the tx).
- [ ] AC2 — a retry after `ALREADY_ASSIGNED` for the same SE reconciles the escalation to APPROVED.
- [ ] AC3 — a notify throw inside the sweep neither aborts the sweep nor orphans the escalation.
- [ ] AC4 — a missing ZM → all ZMs of the zone by role, or a logged `NO_RECIPIENT` — never a silent
      return.
- [ ] AC5 — the target ZM receives `CROSS_ZONE_INCOMING` and sees the row in `/cross-zone`.

## Verification

Crash-injection e2e using `test/support/tx-hooks.ts`; recipient e2e.

## UI surfaces

Admin: Cross-Zone page (modified — incoming badge / direction).

## Reference

n/a — the plan names no reference image for this slice (badge only; the Cross-Zone page layout is
unchanged here — #355 owns the page work).

## Blocked by

- #338 — the durable outbox helper the sweep enqueues through

## Absorbs / supersedes

- survey ids: CZ-01, CZ-02 (the #140 notify half), CZ-09, CZ-11 (incl. the corrected SCH-05), CZ-13
  (controller result mapping)
- existing issues: #139, #140 (each closes into this slice when it lands); the cross-zone half of
  #331 (closes into this slice when it lands — the intra-day half goes to #356)
