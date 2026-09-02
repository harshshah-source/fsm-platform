# ENG-G1 — a denied leave leaves no trace (walk, 2026-09-02, E4)

**Outcome: confirm.** S2 read this off `file:line`. The walk reproduced it and made it worse.

## What was done
`leave_requests` and `se_availability` were both **empty** at the start, and of the 34,764 rows in
`audit_logs` **not one** matched `%LEAVE%`, `%AVAIL%` or `%PLANNER%` on action or entity_type. So
every row below is mine and the delta is unambiguous.

1. `POST /leave-requests` as `zm.north` for Sumit Chopra (`459b5409`, zone 1) → `201 {id:1}`.
2. `POST /leave-requests/1/reject {"reason":"S3 walk denial - staffing"}` → `200 OK` at 09:27:48Z.
3. `select ... from audit_logs where id > 34794` → **two rows, both another surveyor's `users` writes.
   Zero rows from the rejection.**
4. `POST /leave-requests/2/approve` → `200 OK` at 09:27:59Z.
5. audit delta → **exactly one row**:
   `id 34797 · ZONAL_MANAGER · SE_AVAILABILITY_SET · entity_type "se_availability" · entity_id "1" ·
   metadata {seId,status} · acting_zone null`.

## What that means
The approve row is keyed on the **availability row's** id, not the leave request's. `AuditLog` is
indexed `@@index([entityType, entityId])`; a query for `('leave_request', '2')` returns nothing.
The metadata carries no window, no reason, no request id. And the reject row's own columns
(`decided_by`, `decided_by_role`, `decided_at`, `decision_reason`) are the *only* record that the
denial happened — they are overwritable in place and sit outside the ledger every other decision in
this app is reconstructed from.

So: "who refused this engineer's leave, when, and on what grounds" is answerable only for as long as
nobody touches the row, and "who put this engineer on leave" is answerable only by first knowing the
`se_availability` id — which no screen ever shows.

## Folded, not filed separately: there is no reader either
`/api/audit-trail` exposes **one** route — `GET tickets/:ticketId`
(`apps/backend/src/audit/audit-trail.controller.ts:20`). A grep of `apps/admin/src` for
`audit-trail` / `auditTrail` returns **no hit at all**, so not even the ticket trail has an admin
page. The `SE_AVAILABILITY_SET` row that *is* written is therefore unreadable by any operator in
either app. That reader is app-wide in scope; it is noted here and must be priced at rollup, not by
this module. Recorded as a standing rule.

## Fix shape
Write an `entityType:'leave_request'` audit row on both `approve` (`leave-request.service.ts:103`)
and `reject` (`:126`), inside the same transaction as the status update, carrying the window, the
type, the decision reason and — for approve — the `availabilityId` so the two rows join.
