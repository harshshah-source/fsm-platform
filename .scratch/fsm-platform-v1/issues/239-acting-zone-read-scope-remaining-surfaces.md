# 239 — `X-Acting-As-Zone` is still ignored by ~20 other manager read surfaces

Status: needs-triage — **partially resolved 2026-08-28** (Scheduler Console Phase 2.2)
> **Console slice taken, 2026-08-28.** The Console made this issue's failure mode concrete: across
> separate pages a mis-scoped read is confusing, but on one screen showing a deck, a candidate column
> and a target-SE picker at once it is *incorrect*. Converted **exactly the Console-reachable set**,
> per this issue's own "decide, don't sweep" rule: `GET /schedules/engineers`,
> `GET /schedules/:engineerId`, and all three of `batches.controller` (`:batchId`,
> `override/preview`, `override`). The judgement made for the writes, explicitly: **acting narrows,
> and narrowing a write can only reduce reach** — a CSM who needs to override in another zone stops
> acting first, as every read already requires. Also fixed there: `override` hard-coded
> `actedAsRole: null`, so an acting CSM's override recorded as an ordinary CSM action.
> **Everything else in the list below remains open and is still this issue's.**
Type: Backend · Authorization / read scope

Filed 2026-08-17 while fixing the operator report *"OH dashboard — Act as ZM is non working"*. That fix
closed the dashboard (and the Fleet Uptime hero KPI it renders); this issue owns the rest of the same
defect class, which the fix made measurable rather than theoretical.

## The gap

Acting as ZM (Issue 27) has two halves, and only one was built:

- **Audit attribution** — `resolveRequestActor` / `RequestActor` (#47). Works: an audited write by an
  acting CSM/OH stamps `acted_as_role` + `acting_zone` (`request-actor-attribution.e2e-spec.ts`).
- **Read scope** — what data comes back. Controllers built their scope by hand as
  `{ role: user.role, zoneId: user.zone_id }` straight off the claims, which structurally cannot carry
  acting. So an acting Operations Head kept receiving **pan-India** rows.

The dashboard fix introduced `resolveManagerScope` (`src/common/manager-scope.ts`) + the
`@CurrentScope()` decorator: acting collapses the read to `{ role: 'ZONAL_MANAGER', zoneId: actingZone }`,
which is the same collapse the admin UI already makes when it swaps the pan-India dashboard for the
Zone Operations view (FE-07). `DashboardController` (9 reads) and `ReportsController.fleetUptime` now
use it; **every other surface still hand-builds the claims-only scope.**

## Measured

`grep -rn "role: user.role, zoneId: user.zone_id" apps/backend/src` — **69 matching lines across 23
files** before the dashboard fix, **61 after** (all 9 in `dashboard.controller.ts` gone, 7 → 6 in
`reports.controller.ts`). The remaining 61 sit in:

`tickets`, `schedules`, `intraday-updates`, `intraday-insertion`, `batches`, `dispatch-runs`,
`devices`, `engineers`, `leave-request`, `se-planner`, `verification`, `vouchers`, `cross-zone`,
`component-request`, `inventory`, `warehouse-stock`, `vehicle-unavailability`, `install`,
`install-lifecycle`, `audit-trail`, and the six non-`fleetUptime` reads in `reports`.

Not all 61 are bugs — each needs the same judgement call the dashboard needed, and some deliberately
must NOT narrow.

## What needs deciding (per surface, not mechanically)

- **Reads vs writes.** Writes already resolve `RequestActor`; the question there is authorization
  (may an acting CSM approve in that zone?), which is a different question from "what rows do I see"
  and is partly still deferred by `acting-context.ts`'s own note (the ROLE_UNAVAILABILITY gate).
- **Surfaces that must stay wide while acting.** Cross-zone escalation is the clear candidate: its whole
  purpose is spanning zones, and clamping a CSM acting in a zone to that zone could hide the escalation
  they are acting in order to resolve. Decide, don't sweep.
- **The frontend half is per-client too.** Only the clients that call `authHeaders()` send the header at
  all. `api/dashboard.ts` and `api/reports.ts` were fixed; `api/devices.ts` and `api/client.ts` still
  carry local bearer-only header builders, so even a converted backend would not see the header from
  those pages. Both halves must land together per surface, or the change is invisible.
- **Whether the ZM-collapse is the right model everywhere.** It is right for the dashboard because the
  UI already renders the ZM's own view. A surface with no ZM equivalent (e.g. OH-only reports) may want
  "pan-India, filtered to zone" instead, which is not the same query.

## Non-goals

- Not re-doing the dashboard/`fleetUptime` conversion (landed 2026-08-17).
- Not the acting **authorization** gate (who may act when, driven by `ROLE_UNAVAILABILITY`) — that is
  still Issue 27's own deferred half and is tracked there, not here.
