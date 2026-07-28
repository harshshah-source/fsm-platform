# 174 — SE request validation (DTOs on every SE write route)

Status: ready-for-agent
Type: AFK · Backend

Filed 2026-07-28 (`docs/status/mobile-backend-freeze-plan-2026-07-28.md` §1.2, F1.1).
Surfaced by the independent contract pass; **no prior mobile assessment mentioned validation at all.**

## The defect

The global `ValidationPipe` (`app.module.ts:187-190`, `whitelist + forbidNonWhitelisted + transform`)
is real but **inert on every SE route**. Nest skips non-class metatypes, and `class-validator`
appears in exactly **one** file in the whole backend — `cross-zone/cross-zone.dtos.ts`, which is
manager-only. Every other `@Body()` is a TypeScript interface, erased at runtime; `whitelist` strips
nothing and nothing is checked.

Controllers hand-roll a few guards (`troubleshoot.controller.ts:74-79` validates 2 of its 11 fields).
Everything else reaches the service and Prisma unchecked. Confirmed crash paths:

- `BigInt(body.componentUnavailableItem)` (`troubleshoot.controller.ts:92`) — `SyntaxError` on any
  non-numeric string. Not an `HttpException`, no numeric `status`, so it falls through both branches
  of `all-exceptions.filter.ts` to the generic **500** (`:71-77`).
- `new Date(item.expenseDatetime)` (`vouchers.controller.ts:83`) — `Invalid Date` written to Prisma.
- `BigInt(Number(regionId))` (`geography.service.ts:46`) — `RangeError` on `NaN`.
- Five routes pass an unvalidated `:id` straight to a Prisma `uuid` column → P2023 → 500.

**Why this matters more than a missing idempotency key:** 5xx is the one status a retry policy must
treat as transient. A *client* bug therefore produces an infinite retry loop against a server with
no rate limiting (#110), and the load reads as an outage rather than a bad build.

## What to build

1. Class DTOs with `class-validator` decorators for **every** SE-facing `@Body()` (21 write routes —
   the inventory is in the freeze plan §4.4). Preserve the existing hand-rolled error codes so no
   route's contract changes; the DTO replaces the mechanism, not the vocabulary.
2. Param validation: one consistent regime. Today there are four — `ParseUUIDPipe` (1 route),
   hand-rolled regex (1), raw `BigInt()` (2, → 500), nothing (5, → 500).
3. Map Prisma `P2023`/`P2025` to 4xx in the exception filter rather than letting them reach the
   generic 500 branch.

Coordinate with **#169**: that issue owns the error *shape*; this one owns *whether the error
happens at all*. The `ParseUUIDPipe` 400 body differs from every hand-rolled 400 — #169 normalises it.

## Acceptance criteria

- [ ] Every SE write route rejects a malformed body with a 4xx carrying its documented `code`, never a 500
- [ ] `componentUnavailableItem: "abc"`, an unparseable `expenseDatetime`, and a non-uuid `:id` each return 4xx (regression tests for all three)
- [ ] `forbidNonWhitelisted` actually strips unknown fields on SE routes (verify it now does)
- [ ] No existing error code or status changes as a side effect (route-contract sweep stays green)
- [ ] Param validation is one regime across the SE surface

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

- None. Should land with or just before #169.

## Comments

### 2026-07-28 — one enum added by #172

`actionTakenCategory` moves from an unvalidated free string to a server enum (#172 decision 8),
so its DTO gets the same membership validation `rootCauseCategory` already has at
`troubleshoot.controller.ts:77`. Vocabulary is served/shared under #169.
