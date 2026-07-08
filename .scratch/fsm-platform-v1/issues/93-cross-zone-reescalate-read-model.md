# 93 — Cross-zone escalation read model: expose DENIED AUTO to the home ZM (re-escalate)

Status: ready-for-agent
Type: AFK · Backend (+ thin admin surface)
Origin: Issue 78 follow-up (2026-07-01) — surfaced building the Admin Cross-Zone page.
Owner concept: read-model extension of Issue 32 (done).

## Background

Issue 32 built the cross-zone escalation backend. Its write path already supports re-escalation:
`CrossZoneEscalationService.reEscalateToOps(id, zmActor)` and `POST /api/cross-zone/:id/re-escalate`
(`@Roles('ZONAL_MANAGER')`) exist and are e2e-tested — a **home ZM** re-escalates a **DENIED
AUTO_PLATINUM** escalation to Operations Head. Issue 32's own AC line 16 marks *"Denied
auto-escalations return to home ZM queue; ZM can re-escalate to Operations Head"* as done.

## Problem — why the backend cannot support the UI

The **queue read hides the very rows the action needs.** `CrossZoneEscalationService.listForScope`
returns only escalations whose `status ∈ { PENDING, DEFERRED, ESCALATED_TO_OPS }`
(`cross-zone-escalation.service.ts` `listForScope`; Issue 32 spec line 43). A denied AUTO escalation has
`status = DENIED`, so it **never appears** in the `/cross-zone` list — for anyone, including the home ZM.

Consequently, Issue 78 (the Admin Cross-Zone page) **could not surface the re-escalate action**: the
UI has no row to attach it to. The `reEscalateToOps` capability is real but unreachable from the product,
so Issue 32's re-escalate AC is only *notionally* met (write-path present, no read to drive it).

## Why this is a read-model issue, not an Admin UI issue

- The **write action + RBAC guard already exist** (`POST /:id/re-escalate`, ZM-gated) and are tested.
- The **only** missing piece is a read that returns DENIED AUTO_PLATINUM escalations to their **home**
  ZM. That is a `listForScope` (or a dedicated read) change — server-side domain scope, not presentation.
- A pure Admin change cannot fix it: the admin client (`api/crossZone.ts`) faithfully renders whatever
  `GET /cross-zone` returns; the rows simply aren't in the payload.

## Repository evidence

- `apps/backend/src/cross-zone/cross-zone-escalation.service.ts` — `listForScope` `where.status` is
  `{ in: ['PENDING', 'DEFERRED', 'ESCALATED_TO_OPS'] }`; `DENIED` is excluded.
- `apps/backend/src/cross-zone/cross-zone.controller.ts` — `POST :id/re-escalate` exists, ZM-gated,
  returns `NOT_A_DENIED_AUTO_ESCALATION` / `NOT_HOME_ZONE_ZM`.
- `.scratch/fsm-platform-v1/issues/32-cross-zone-escalation.md` L16 (AC ✓), L41 (`reEscalateToOps` =
  DENIED AUTO_PLATINUM, home ZM), L43 (`listForScope` = PENDING/DEFERRED/ESCALATED_TO_OPS).
- `.scratch/fsm-platform-v1/INDEX.md` #78 — the deferral is recorded ("re-escalate has no source rows").

## Scope

- Extend the read so a **home ZM** sees their **DENIED AUTO_PLATINUM** escalations that are eligible for
  re-escalation (either widen `listForScope` for the ZM scope, or add a dedicated
  `GET /cross-zone/re-escalatable` read — pick per design, keep CSM/OH behaviour unchanged).
- Do **not** change the write path, RBAC, or the deny/approve/defer semantics.
- Thin admin surface (vertical slice per the surfacing rule): render the **Re-escalate to OH** action on
  those rows in the existing `/cross-zone` page (client method `apiCrossZoneReEscalate` already exists).

## Acceptance criteria

- [ ] A home ZM's read returns their DENIED AUTO_PLATINUM escalations eligible for re-escalation.
- [ ] CSM / Operations Head scope is unchanged (no DENIED leakage into the decision queue they act on).
- [ ] The existing `POST /:id/re-escalate` drives from these rows; a non-eligible row is rejected as today.
- [ ] Admin `/cross-zone` surfaces a **Re-escalate to OH** action on the eligible rows (ZM only).
- [ ] No change to approve/deny/defer/flag/sweep behaviour or the escalation state machine.

## Dependencies

- **#32** — cross-zone backend (done) — owns the model + `reEscalateToOps` + `listForScope`.
- **#78** — Admin Cross-Zone page (done) — the surface that renders the action; `apiCrossZoneReEscalate`
  client already present.

## TDD plan (RED → GREEN → REFACTOR)

- **RED (backend e2e):** seed a DENIED AUTO_PLATINUM escalation in zone Z; assert the home-zone ZM read
  returns it; assert a CSM/OH read does not; assert `POST /:id/re-escalate` then moves it to OH.
- **GREEN:** widen the ZM read scope (or add the dedicated read) to include eligible DENIED AUTO rows.
- **RED (admin):** the `/cross-zone` page renders `cz-reescalate-<id>` on an eligible ZM row → `POST
  /:id/re-escalate`.
- **GREEN:** surface the gated action.
- **REFACTOR:** de-dup the status/scope predicate; confirm existing #32 + #78 tests stay green.

## Priority

Low–medium. Closes a genuine end-to-end gap in Issue 32's re-escalate AC. Place with the cross-zone /
Admin follow-ups; not ahead of #70+FE-09.
