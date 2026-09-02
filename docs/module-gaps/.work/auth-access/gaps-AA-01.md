# AA-01 / AA-11 / AA-02 / AA-03 — acting-scope, walked 2026-09-02 (S3, api + psql, no browser)

`role_unavailability` holds **0 rows**. Every ZM is present. Everything below happened anyway.

## The gate that is not there (AA-01, P4, confirm, E4)
`csm@fsm.test` sending `X-Acting-As-Zone: 2` got HTTP 200 on `GET /api/dashboard/zone-overview`
and received **only zone 2** — South, whose ZM "Alla Lokesh" is on duty. Zones 1 and 5 behaved the
same, and `ops.head@fsm.test` behaved the same. `resolveActingContext` (`acting-context.ts:29`) asks
one question — is the caller CSM or OH — and never asks whether that zone's ZM is out.
`isRoleUnavailable` / `currentActingRoleForZone` (`role-backup.service.ts:64,77`) still have no
caller outside their own file, and there is no page to write a row into the table they read.
The header is also unvalidated: zone `99` is accepted and returns an empty 200 rather than a 400,
and zone `abc` parses to NaN and is **silently dropped**, so a mistyped zone hands the operator the
pan-India view while the banner tells them they are inside one zone.

**Falsified half — worth keeping.** `zm.north` with `X-Acting-As-Zone: 2` stayed clamped to zone 1,
and `wm@fsm.test` was refused 403 at the role guard. A ZM cannot widen and an unrelated role cannot
act at all. The breach is confined to the two roles the cascade names; it is a missing *when*, not a
missing *who*.

## What acting actually scopes (AA-11, C5, confirm, E4)
Only five controllers inject `@CurrentScope`: dashboard, reports, batches, dispatch-today,
schedules. `GET /api/tickets` — the manager's primary list — returned the identical 100 rows across
zones 1-5 with the header, without it, and with a different zone. `GET /api/dispatch-runs` and the
`GET /schedules` list are likewise unmoved. So acting narrows a handful of read screens and nothing
else. Writes are worse than unscoped: they build their scope from `@CurrentUser`, so a CSM
"acting in zone 2" **closed a zone-1 ticket** (`POST /tickets/f1978011…/auto-recovery-close` → 200).
Acting today buys a narrower dashboard on top of an unchanged, unbounded write surface.

## The ledger holds both shapes (AA-02, P2, confirm, E4)
Two rows, one session, same header mechanism:
- `audit_logs #34793` — CSM, `X-Acting-As-Zone: 2`, ticket closed → `acted_as_role NULL`, `acting_zone NULL`.
- `audit_logs #34794` — OH, `X-Acting-As-Zone: 3`, `GET /ops-explorer/meta` → `OPERATIONS_HEAD`, zone `3`.
The `auditActor()` + `withAudit` seam is correct; it is simply not on the write paths a stand-in
manager uses. Census of the whole table: 34,758 rows, `acted_as_role` non-null on **one**.

## The number Operations Head reads (AA-03, O3, confirm, E4)
`GET /api/reports/csm-approval-share` returns `[]` this month and, for August, five zones at
**0% CSM share**. Two defects feed it. The numerator is empty for the reason above. The denominator
is fake: 30 of the 31 `acting_zone` rows in the entire ledger are `BULK_UNASSIGN_ZONE`, where
`bulk-unassign.service.ts:289,367` reuses `acting_zone` to mean the *target* zone of the unassign.
Fixing AA-02 alone cannot make this report right — the column carries two meanings.
