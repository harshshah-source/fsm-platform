# notifications

STATUS: gaps  updated 2026-09-02
COMPLETE: 36%  ->  59% after backlog
GAPS: 7 (S4 1 · S3 4 · S2 2 · S1/S0 0)  DANGEROUS 1 · needs-verify 0
EST: not yet estimated (S4 has not run)
VERDICT: The platform can queue a notification durably and then has nowhere to send it — and the audit trail it writes faithfully can only be read if you already know the ticket number.

## The picture
This module is two jobs and both are half-finished in the same way: the hard part is built and the exit is
missing. Delivery has a durable outbox and a device-token table in front of an adapter that returns
UNAVAILABLE unconditionally — a working queue in front of a dead exit, so an engineer learns nothing unless
the app is already open. The audit ledger writes correctly inside the mutation transaction, but the only
read route takes a ticket UUID, and every filter it appears to accept is silently ignored.

## What matters, ranked
- 🔴 an engineer never learns a day plan was dispatched unless the app is already open (NOTIF-01, S4) — **this is the shared gap four other modules bottom out on, priced once here** (P11)
- 🟠 insertion and escalation notices are lost on a crash: twelve notify sites fire post-commit with no retry row (NOTIF-02, S3, DANGEROUS)
- 🟠 the audit log is queryable only by a ticket UUID you already have; actor, acting-role, zone and date filters return byte-identical unfiltered bodies (NOTIF-04, S3, confirmed live)
- 🟠 the admin bell is an inert button — managers hold real unread cross-zone escalations and can never see them (NOTIF-08, S3, confirmed live) — needs no push adapter, so it is independently fixable
- 🟠 the audit trail has a backend but no admin screen; the drawer's history tabs read a different source entirely (NOTIF-03, S3)
- 🟢 **per-user scoping and read-state both hold** — cross-user mark-read refused from three accounts, lists disjoint per user, read state durable across an independent re-read
- ⚠ LOW confidence, **borrowed** anchors, and the largest weak-anchor exposure in the survey at 4.04M TEQ resting on the integration cohort (n=6)
- ⚠ cross-check split 9.87×; NOTIF-01/03/04/05 each exceed the "over 3M is not one gap" line and must be split before commitment

## Numbers
| | |
|---|---|
| functionally complete | 36% now → 59% after backlog |
| backlog | — |
| cheapest big fix | — |
| engineering size / risk | — — **not a schedule** |

## Not finished / needs you
- **needs-verify:** none
- **your call:** none
- **not walked:** none recorded

## All gaps, one line each
| id | sev | ⚠ | what (plain words) | type | size | P50 | conf |
|---|---|---|---|---|---|---|---|
| NOTIF-01 | S4 |  | SE never learns of a dispatched day plan unless app open | INTEGRATION | — | — | HIGH |
| NOTIF-02 | S3 | ☠ | insertion and escalation notices lost on crash; no outbox | FIX | — | — | MED |
| NOTIF-03 | S3 |  | audit trail has a backend but no admin screen anywhere | COMPLETE | — | — | MED |
| NOTIF-04 | S3 |  | audit log queryable only if you already know the ticket UUID | NEW | — | — | MED |
| NOTIF-05 | S3 |  | WhatsApp acceptance confirmation coded but never called | COMPLETE | — | — | MED |
| NOTIF-06 | S2 |  | no SLA-warning, snapshot-failure or component-approval notification | NEW | — | — | MED |
| NOTIF-07 | S2 |  | push token endpoint exists, no mobile client ever calls it | COMPLETE | — | — | MED |

Evidence: `.work/notifications/` · estimate: `.work/notifications/estimate.json`
