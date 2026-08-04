# 207 — Admin completeness: ticket-status filter, the missing AVAILABLE setter, terminal component states

Status: ready-for-agent
Type: AFK · Admin (+ in-place corrections on [#25](./25-se-management-availability.md), FE-15, [#62](./62-ticket-drawer-component-chain.md))
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04
Blocked by: nothing

## Root cause

Three admin surfaces were each built against a subset of the state space their backend can produce,
and in every case the subset was frozen at the time the page was written and never revisited as the
lifecycle grew. None of them fails loudly — the rows simply cannot be reached, or the control simply
is not offered — so the gaps have stayed invisible.

## Findings closed

Audit 2: **C8** (ticket filter offers 8 of 17 statuses), **D7** (admin cannot set `AVAILABLE`),
**D9** (WM queue can never show `RECEIVED`/`REJECTED`), part of **C3** (SOFT_UNAVAILABLE handling —
the *label* half is #208's).

## Evidence — verified 2026-08-04

**Ticket filter (C8)**
- `apps/admin/src/pages/tickets/TicketsPage.tsx:21-24` offers **8** statuses; the schema has **17**
  (`generated/prisma/enums.ts:431-449`) and the backend accepts all of them
  (`ticket-query.service.ts:118-123`).
- Missing: `REQUESTED`, `SCHEDULED`, `ON_SITE`, `FITTED`, `ACTIVATED`, `FAILED_ACTIVATION`,
  `COLLECTED`, `RECEIVED_AT_WAREHOUSE`, `FAILED_RECOVERY` — i.e. **every Recovery and Install
  lifecycle status**. The same page offers `WORK_TYPES` including RECOVERY and INSTALL at `:20`, so
  an operator can filter *to* those tickets and then cannot filter them *by* any status they hold.

**Availability setter (D7)**
- Backend permits a manager to set `AVAILABLE`: `engineers.controller.ts:70` includes it in
  `SETTABLE_STATUSES`, and `se-availability.service.ts:103-107` applies **no status narrowing to the
  ZM/CSM legs** (only the SE self-set legs are narrowed, `:101-102`).
- Admin cannot: `apps/admin/src/api/engineers.ts:19` types `SettableStatus` as 4 values omitting
  `AVAILABLE`; `SeManagementPage.tsx:26` and the dropdown at `:305-309` match.
- Consequence: **no manager can clear an SE's stuck window from the console** — only the SE can, from
  mobile. This is the manager half of the hole #87's 2026-07-28 comment warned about; #162 fixed the
  SE half.
- `#25` is the owning issue (`accepted`) and its AC `[x] Set Availability writes ON_LEAVE / OFF_SHIFT
  / WEEKLY_OFF / SOFT_UNAVAILABLE` is *accurate as written* — it simply predates `AVAILABLE` becoming
  settable. Corrected in place there.

**Terminal component-request states (D9)**
- `component-request.service.ts:80` defines `ACTIVE = ['REQUESTED','APPROVED','SHIPPED']` and
  `queue()` at `:88` filters to it — so the WM queue backing `GET /warehouse/requests` can **never**
  return `RECEIVED` or `REJECTED`.
- The WM who shipped a part therefore never sees the SE's receipt confirmation land, even though
  mobile writes it (`StockScreen.tsx:118` → `component-request.service.ts:192,198`).
- FE-15 (`done`) built the metric strip over three statuses only; the `StatusPill` column *can*
  render all five (`badges.tsx:86-91`).
- In manager-oversight mode the same page uses the **unfiltered** read (`:96-101`) and does receive
  terminal rows — but the metric strip still counts three (`ComponentRequestsPage.tsx:29,191-193`),
  so the strip under-counts its own table.
- `#62` carries an unticked AC under a `done` status: `[ ] Shows delivery destination + tracking ref
  when SHIPPED; rejection reason when REJECTED`.

## Scope

**In:** complete the ticket-status filter; add `AVAILABLE` to the admin availability setter with the
scoping the backend already enforces; make terminal component-request states reachable and correctly
counted for the WM.

**Out:** changing any backend authorization or the `ACTIVE` constant's use elsewhere — the WM queue's
*default* view may legitimately stay active-only; the requirement is that terminal states are
**reachable** (a filter, a tab, or a separate view), not that the default changes. Label/tone
wording — that is #208.

## Acceptance criteria

- [ ] The ticket filter offers every status the backend accepts, grouped legibly by work type
      (17 flat options is a usability regression — group them)
- [ ] A ZM/CSM can set an SE to `AVAILABLE` from the admin console, and doing so clears an active
      `SOFT_UNAVAILABLE` window; zone scoping is unchanged
- [ ] A WM can reach `RECEIVED` and `REJECTED` component requests, and the metric strip's counts
      equal the rows in the table it sits above (in both WM and oversight modes)
- [ ] `#25`, FE-15 and `#62` are corrected in place to reflect the new reality
- [ ] Regression tests for each of the three. **Cheap** — `TicketsPage`, `SeManagementPage` and
      `ComponentRequestsPage` all have existing specs

## Verification

```bash
cd apps/admin && npx vitest run src/pages/tickets src/pages/engineers src/pages/inventory
cd apps/backend && node scripts/run-tests.mjs test/se-availability.e2e-spec.ts
```
Plus manually: set an SE `SOFT_UNAVAILABLE` from the handset, then clear it from the admin console.

## Risk if deferred

A ZM cannot filter the Recovery and Install queues they are accountable for. An SE who sets
themselves soft-unavailable and then loses their phone cannot be made available again by anyone —
the recovery path requires the handset that is gone. And a warehouse manager cannot confirm that
anything they shipped was ever received, which is the closing step of the component loop.

## Size estimate

S-M. Three small independent changes; the ticket-filter grouping is the only one with a design choice
in it.
