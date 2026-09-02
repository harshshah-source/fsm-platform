# NOTIF-04 — the audit ledger cluster, walked (S3, 2026-09-02, `ops.head@fsm.test`)

**Outcome: confirm.** The told-the-number test fails outright. Also two corrections to S2.

## What an Operations Head can actually ask

One route answers: `GET /api/audit-trail/tickets/:ticketId`. Nothing else exists. Walked and 404 at
the router: `/audit-trail`, `/audit-trail/tickets`, `/audit-logs`, `/audit`, `/audit-trail/search`,
`/audit-trail/actors`. The surviving route validates a UUID (`audit-trail.controller.ts:24`), so
`/audit-trail/tickets/all` is `400 INVALID_TICKET_ID`. There is no entrance that does not begin with
a ticket number you already hold.

The filter shapes are worse than refused — they are **silently accepted and ignored**. Each of
`?actorId=`, `?actedAsRole=`, `?actingZone=`, `?from=&to=`, `?entityType=` returned `HTTP 200` with a
body identical to the unfiltered read. The controller declares no `@Query` at all, so a caller who
believes they filtered gets the same rows back and no signal that they did not. That is a lookup
dressed as a query.

Role gating around it is real: `WM 403`, `SE 403`, `zm.north` on a zone-3 ticket `404
TICKET_NOT_FOUND` (`audit-trail.service.ts:46`), anonymous `401`.

## Correction 1 — the index DOES have a reader (S2 said it did not)

S2's C6 `check8 x` ("no reader uses that index") is wrong and is corrected in `coverage.json`.
`role-backup.service.ts:89` runs `groupBy(['actingZone','actedAsRole'])`; it is exposed at
`GET /api/reports/csm-approval-share` (`role-backup.controller.ts:60`, `@Roles OPERATIONS_HEAD`), and
there is a live admin page — `CsmApprovalSharePage.tsx`, routed `AppRoutes.tsx:250`, in the nav at
`nav.ts:215`, in the Help Center. Walked as OH: 2026-09 → 1 zone, 2026-08 and 2026-07 → 5 zones each.

This strengthens the gap rather than weakening it. The reader returns
`{zoneId, csmActions, totalActedActions, sharePct}` — counts. It cannot reach a row. So the accurate
statement is not "an index nobody queries", it is **"an audit table with one aggregate reader and no
row-level reader"**. Audit written on devices, engineers, leave, schedules and vouchers stays
unreadable by anyone.

## Correction 2 — H5 confirmed, with a caveat that folds in here

`totalActedActions` was 1–4 per month, and `actingZone` is only ever set together with `actedAsRole`
(`acting-context.ts:30`). So real acted-as rows exist: the write path is exercised and only the read
side is missing — H5 as stated, **confirm**. The caveat: six controllers bypass `auditActor()` and
hardcode `actedAsRole: null` / `actingZone: null` — `cross-zone.controller.ts:113`,
`devices.controller.ts:131`, `engineers.controller.ts:254`, `leave-request.controller.ts:69,85,103`.
An acted-as session on those flows loses attribution at write time and can never surface in either
reader. Folded into the NOTIF-04 row rather than filed separately; it does not block the claim.

`csmActions` was 0 in every zone of every month walked — not filed, it is consistent with the write
path and this DB simply has no CSM-acted rows.

## NOTIF-03, same cluster, sharpened

The S2 shape ("no history screen anywhere") was too strong. `TicketDetailDrawer.tsx:24` has real
`Lifecycle` and `Assignment History` tabs — but fed by `apiTicketDetail().lifecycle` (`:89, :147,
:305`) from `GET /api/tickets/:id`. Walked both endpoints on the same ticket: that payload carries
`ticket_events` only. The audit-trail endpoint's whole value-add is the merged `kind:'ACTION'` stream
from `audit_logs` with `action`, `actingZone` and `metadata` (`audit-trail.service.ts:63-73`), and
**no admin pixel renders it**. Five not-found checks recorded on the gaps.jsonl row.
