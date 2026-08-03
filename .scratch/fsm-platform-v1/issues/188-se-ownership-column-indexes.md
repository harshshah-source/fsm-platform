# 188 — Missing indexes on SE-ownership columns ahead of SE-scoped reads

Status: ready-for-agent
Type: AFK · Backend · Data model

Filed 2026-08-03, found during the mobile-readiness precondition analysis
(`docs/status/mobile-readiness-2026-08.md`, revised pass). Not covered by #161, #162, or #173
(checked) — those own the SE ticket-read surface, the row-level authorization floor, and the SE
inventory/component-request surface respectively; none of their acceptance criteria mention index
coverage on the columns they scope against.

## What's wrong

`apps/backend/prisma/schema.prisma` gives several SE-facing operational models a real `seId`-shaped
ownership column, but no index covers it standalone or as a usable prefix:

1. **`ComponentRequest.seId`** (`schema.prisma:1173`) — the only indexes on this model are
   `@@index([status, createdAt])` (`:1194`) and `@@index([ticketId, createdAt(sort: Desc)])`
   (`:1195`). Neither supports `WHERE se_id = :callerId`.
2. **`ComponentBlockedQueue.seId`** (`:1150`) — this model has **zero `@@index`/`@@unique`
   declarations of any kind** (only `@@map`, `:1160`) — not even on `ticketId`.
3. **`VehicleUnavailabilityReport.seId`** (`:2050`) — indexes present are `[ticketId]` (`:2067`) and
   `[status, expectedFrom]` (`:2068`); `seId` is covered by neither.
4. **`IntradayInsertion.offeredSeId`** (`:495`) — indexes present are `[zoneId, status]`,
   `[ticketId]`, `[status, acceptanceDeadline]` (`:511-513`); `offeredSeId` is covered by none of
   them.

Lower relevance (manager/ops-facing, not on the SE mobile read path today, noted for completeness):
`CrossZoneEscalation.assignedSeId` (`:553`) and `DispatchDecisionTrace.seId` (`:807`) have the same
gap.

## Why this matters now, not later

None of these are load-bearing **yet** — no shipped endpoint currently issues a `WHERE se_id =
:caller` query against any of these four tables, so today it's dormant. It stops being dormant the
moment **#173** (SE inventory & component-request surface) ships its planned SE-initiated
component-request read/create, or **#161**'s remaining item-1 ticket-detail work surfaces a
component-request/VU status inline. At that point every affected table forces a sequential scan on
a filter that should be an index lookup, and `ComponentBlockedQueue` — the one with zero indexes at
all — is the worst case: even its existing manager read (`GET /component-blocked`,
`component-request.controller.ts`) already has nothing to lean on.

Fixing this now, while these tables are small, is a trivial additive migration. Fixing it after #173
ships and the SE-scoped query pattern is already live in the client means an index migration under
real read load instead of a green-field one.

## What to build

Additive indexes only — no data changes, no constraint changes:

```prisma
model ComponentRequest {
  // ...
  @@index([seId, createdAt(sort: Desc)])
}

model ComponentBlockedQueue {
  // ...
  @@index([seId])
  @@index([ticketId])
}

model VehicleUnavailabilityReport {
  // ...
  @@index([seId, createdAt(sort: Desc)])
}

model IntradayInsertion {
  // ...
  @@index([offeredSeId])
}
```

Exact column sets/sort order are a suggestion, not a mandate — whoever builds #173's actual query
shape should confirm the index matches the real `WHERE`/`ORDER BY`, not just add `seId` alone if the
shipped query also filters/sorts by status or date.

## Acceptance criteria

- [ ] `ComponentRequest`, `ComponentBlockedQueue`, `VehicleUnavailabilityReport`, `IntradayInsertion`
      each have an index usable for a `seId`/`offeredSeId` equality filter
- [ ] `ComponentBlockedQueue` gains at least a `ticketId` index alongside `seId` (currently has none)
- [ ] Migration is additive-only; no existing query plan regresses (spot-check the manager-facing
      reads on each touched table)
- [ ] `prisma migrate diff` against the applied migration set stays clean (no new drift beyond the
      intended indexes)

## UI surfaces

n/a — schema/migration only.

## Reference

n/a.

## Blocked by

- None. Independent, additive migration — can land any time; sequence it ahead of whichever of
  #161/#173 first ships an SE-scoped query against one of these tables so the index is in place
  before the read pattern goes live, not after.

## Comments

n/a.
