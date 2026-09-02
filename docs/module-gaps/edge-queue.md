# Edge queue — hand-off tests owed, worst first

Stage A1 output. Every row is an S3+ edge whose carrier could not be settled by static reading.
Test = the cheapest walk that decides it (api-walk with the two real roles, or a browser render).
Owner = the receiving side, which must BUILD the carrier. Price the edge once, under this id only.

| rank | id | from → to | severity | why it hurts | hand-off test to run | owner |
|---|---|---|---|---|---|---|
| 1 | E-14 | tickets → inventory | S4 DANGEROUS | 409 shadow use decrements van stock; dispute never restores it | api-walk SE submit conflicting troubleshoot, then WM `POST /warehouse/shadow-use/:id/dispute`, then re-GET `/api/component-blocked/van-stock` as that SE — does qty come back? | inventory |
| 2 | E-20 | tickets → intraday | S4 | SE has no way to decline a stop; accept/decline deleted; no ZM decline queue | five not-found checks: route, backend, permission, terminology (`skip`/`reassign`), entry point in scheduling `se-skip.ts` — then confirm ZM sees nothing | intraday |
| 3 | E-26 | admin-config → scheduling | S4 | plant deactivation silently strips an SE's live day plan; phone never told | api-walk OH `POST /api/plants/:id/deactivate`, then SE `GET /api/schedules/me` + `GET /api/notifications` — is the removal announced anywhere? | scheduling |
| 4 | E-12 | inventory → tickets (mobile) | S4 | WM ships a part; SE's app has no screen showing it arrived | render SE mobile Stock tab; grep-confirm no consumer of `GET /api/me/component-requests`; then api-walk WM ship → SE GET | tickets |
| 5 | E-05 | notifications → scheduling (SE phone) | S4 | day plan never pushed; SE must remember to open the app | api-walk: dispatch a batch, drain outbox, read `notification_delivery` rows — confirm every external channel lands UNAVAILABLE | notifications |
| 6 | E-25 | ingestion → tickets | S4 | departed device produces a file export no screen reads; open tickets orphaned | search `/build-health` + ops-explorer datasets for a departure lens; api-walk `GET /api/ops-explorer/datasets/:key` for a departure dataset | tickets |
| 7 | E-17 | vouchers → reports (finance) | S3 DANGEROUS | approved payouts leave as a CSV; mark-paid is an unreconciled manual claim | api-walk OH `GET /api/vouchers/export` then `POST /vouchers/mark-paid`; check whether a paid voucher can be re-exported (double-pay) | vouchers |
| 8 | E-15 | tickets → vouchers | S3 | no ticket→voucher carrier; SE re-keys the trip from memory | inspect `POST /api/vouchers` body for a ticketId field; render mobile TicketDetailScreen for any "raise voucher" control | vouchers |
| 9 | E-22 | tickets → tickets (customer) | S3 | confirmation link is only logged; every marking falls to OH override | api-walk ZM `POST /api/non-op`, read the log/notification rows — confirm no outbound send, then OH `override-confirm` is the only close | tickets |
| 10 | E-24 | cross-zone → scheduling | S3 | approved cross-zone assignment notifies home ZM but relies on E-05 for the working SE | api-walk CSM approve, then target-zone SE `GET /api/schedules/me` and `GET /api/notifications` | scheduling |
| 11 | E-19 | intraday → notifications | S3 | mid-day insertion reaches the SE in-app only; no interrupt | same drain check as E-05, scoped to `intraday-insertion.service.ts:343` | notifications |
| 12 | E-01 | ingestion → tickets | S3 | device returning ACTIVE leaves the Ticket open — no auto-close reverse | api-walk: flip a device back to ACTIVE via sync, re-GET `/api/tickets?deviceId=` — does status change? | tickets |
| 13 | E-10 | verification → tickets | S3 | fraud escalation has no un-escalate; a wrong flag is permanent | api-walk ZM escalate then look for any reversal endpoint on the ticket | tickets |

**Not queued (settled static, verdict OK):** E-02 E-03 E-04 E-06 E-07 E-08 E-09 E-11 E-13 E-16 E-18 E-21 E-23 E-27 E-28.
**Unowned edges:** none — every edge above has a receiving module.
