# Progress — Issue 07: Ticket List & Detail Drawer

> Build date: 2026-06-20→21 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 6 acceptance criteria green. Backend **149 tests / 44 files**, admin
> **24 tests / 10 files**, both `tsc --noEmit` clean (local PostgreSQL 18, no Docker).

## Decision taken (HITL, this issue)

**Built `ticket_events` (the LLD lifecycle-timeline spine, schema D6) now**, rather than synthesising a
lifecycle. Issue 05 shipped `tickets` without it (audit/events were deferred to Issue 03). Issue 07 is
the first consumer (the Lifecycle tab), so it lands the table and **retrofits Issue 05's
`TicketCreationService`** to write the opening `→ OPEN` event inside its existing transaction. Later
issues (verification, assignment, closure) append their transitions; the table is append-only.

## Summary

The Ticket List (`/tickets`) and inline Detail Drawer (`/tickets/:ticketId`). Backend: the existing
`/api/tickets` read surface gained the full filter set, a default SLA-bucket-descending sort (raw-SQL
`CASE` severity rank), **ZM zone-scoping** (list and detail), and a detail `lifecycle` array from
`ticket_events`. Frontend: a filterable, badge-rich list and a six-tab drawer that slides in over the
list (the list stays mounted via a nested route). `AdminShell` became a layout shell (`<Outlet/>`).

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | List filters (work_type/status/company/plant/bucket/assignment) | 🟢 | `TicketQueryService.list` raw-SQL conds; `TicketsPage` filter controls. `tickets-list-detail.e2e-spec.ts` (bucket/workType), `tickets-list.test.tsx`. |
| 2 | Default sort SLA bucket desc + colour-coded badges | 🟢 | `SEVERITY_RANK` `ORDER BY … DESC`; `BucketBadge` + `lib/slaBucket` colours. `tickets-list-detail.e2e-spec.ts` (order), `tickets-list.test.tsx`. |
| 3 | Inline badges per condition | 🟢 | `InlineBadges`: REPEAT (`repeatFailure`), ESCALATED (status/cycle), WAITING_COMPONENT (cycle state), AUTO_RECOVERY (status). PARTIAL_RECOVERY + FRAUD render once verification data lands (Issue 18/19). |
| 4 | Detail Drawer inline, six tabs | 🟢 | `TicketDetailDrawer` (`role="complementary"`) over the list via nested route; tabs Overview/Lifecycle/Forms/Verification/Components/Assignment History. `ticket-detail-drawer.test.tsx`. |
| 5 | Overview + Lifecycle real data (actor/role/timestamp per transition) | 🟢 | `ticket_events` → detail `lifecycle`; drawer renders it. `ticket-events.e2e-spec.ts`, `tickets-list-detail.e2e-spec.ts` (detail), `ticket-detail-drawer.test.tsx`. |
| 6 | Role/zone scoping | 🟢 | List + detail filter ZM to `p.zone_id = zone_id`; SE→403 (role guard). `tickets-list-detail.e2e-spec.ts` (ZM scope + cross-zone 404). |

## Slices delivered

- **A — `ticket_events`** (migration `20260620182738_add_ticket_events`) + creation-event retrofit.
- **B — list/detail backend**: filters, bucket-desc sort, zone scope, `getById` lifecycle + uuid guard.
- **C — Ticket List page** (`TicketsPage`, `ticketBadges`, `api/tickets` list/detail client).
- **D — Detail Drawer** (`TicketDetailDrawer`); `AdminShell`→layout `Outlet`; nested `/tickets/:ticketId`.

## Deviations / deferred (read before extending)

1. **`ticket_events`: `actor_id` is a bare uuid (FK→users deferred)** and append-only is by
   construction (services only INSERT) — the DB immutability trigger + users FK land with the audit
   spine (Issue 03). The creation event has a null actor (system-generated).
2. **PARTIAL_RECOVERY and FRAUD FLAG badges are not yet rendered** — they need verification ping
   counts (Issue 18) and the distance-delta fraud signal (Issue 19). The badge component adds them
   when those fields arrive. WAITING_COMPONENT renders without a days-elapsed count for the same reason
   (the cycle's pause timestamp isn't on the view yet — Issue 22).
3. **Forms / Verification / Components / Assignment History tabs are graceful stubs** — their data is
   owned by Issues 16 / 18-19 / 21-22 / 11-13.
4. **List sort/paging**: bucket-severity ordering is done DB-side via a `CASE` rank; no MV. Fine at v1
   scale.
5. **Test update**: Issue 05's `tickets-api` list test switched from a ZM to Operations Head — ZM
   cross-zone list visibility was intentionally removed by this issue's AC#6 scoping.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run     # 149 green
cd apps/admin   && node node_modules/vitest/vitest.mjs run     # 24 green
# demo: start backend + admin, log in as a manager → Tickets (nav) → filter, sort, click a row →
#   the Detail Drawer slides in with Overview + Lifecycle from real data.
```

Note: `pnpm exec` triggers a network deps-check that FortiGate blocks; run the vitest/prisma/tsc
binaries directly via `node node_modules/...`.
