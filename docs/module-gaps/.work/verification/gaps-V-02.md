# V-02 — fraud-flag list is not zone-scoped (P4 · S3 · DANGEROUS · outcome NEEDS-VERIFY)

Hypothesis H2. Walked 2026-09-02 with `api-walk` only; no browser.

## What the walk actually returned

| call | ZM north | ZM south | CSM | OH | WM | SE |
|---|---|---|---|---|---|---|
| `GET /verification/fraud-flags` | 200, len 0 | 200, len 0 | 200, len 0 | 200, len 0 | **403** | **403** |
| `GET /verification/review` | 200, len 0 | 200, len 0 | 200, len 0 | 200, len 0 | **403** | **403** |

Two things are settled at E4 by this, and one is not.

**Settled — the role gate is real.** `@Roles(...MANAGER_ROLES)` on the fraud-flags handler is enforced,
not decorative: WM and SE are refused. Any "unguarded endpoint" reading of this route is falsified.

**Not settled — the leak itself.** Both zonal managers received an empty array. Per the data warning
and policy P19, two identical empty lists are equally consistent with "the clamp works" and "the clamp
does not exist", so the walk **cannot** promote this to E4. Outcome is `NEEDS-VERIFY`, not `confirm`.

## Why the finding survives anyway, at HIGH confidence

The cause needs no fixture, because there is no code path along which a zone could be applied:

- `verification-query.service.ts:214` — `fraudFlags(): Promise<FraudFlagView[]>` declares **no scope
  parameter**, and its `findMany` `where` is exactly `{ fraudFlag: true }`. No ticket, plant or zone clause.
- `verification.controller.ts:111` — the handler injects **no `@CurrentUser`**. It is the only handler
  in the file that does not.

So no scope *value* ever reaches the query layer. The strongest alternative — "a global interceptor or
Prisma middleware scopes it outside the service" — is falsified by construction: an interceptor cannot
narrow a query it was never given a zone for.

## The sharpest evidence is intra-file, not the /tickets contrast

The brief expected the contrast to be "the same app clamps `/tickets` but not fraud flags". The real
contrast is tighter and lives in the same two files:

- `verification-query.service.ts:174` — `review()` clamps: `restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : …`, applied as `ticket.plant.zoneId`.
- `verification-query.service.ts:161` — `forTicket()` clamps: ZM passes only if `ticket.plant.zoneId === scope.zoneId` (this is #162's fix).
- `verification.service.ts:96` — `escalateFraud()` clamps; an out-of-zone ZM gets `NOT_FOUND`.
- `verification-query.service.ts:214` — `fraudFlags()` does **not**.

One file, three clamps, one omission — and the omission is the read of the fraud data. This is not a
module that forgot about zoning; it is a single handler that fell out of a pattern its neighbours keep.
That is why it reads as an oversight rather than a design choice, and why the fix is small.

## What would settle it at E4

One `VerificationRun` with `fraudFlag = true` whose ticket hangs off a **zone-2** plant, then
`GET /verification/fraud-flags` as `zm.north@fsm.test`. A non-empty response containing that row is the
confirmation. Cost: one seed row plus one ~2k TEQ call. Blocked today only by V-08.
