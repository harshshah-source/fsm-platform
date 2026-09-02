# Dependencies — what blocks what

Built from `SPINE.md` (28 edges) plus each module's brief. **Leverage is reciprocated**: if A blocks B,
B's row names A. A shared gap is priced in exactly one module and *referenced* by the others (policy P11);
the owner is named on every row.

## The keystones — three gaps that hold up nine modules between them

| gap | owned & priced by | blocks | why |
|---|---|---|---|
| **NOTIF-01** dead push exit | `notifications` | scheduling · intraday · cross-zone · inventory · tickets | A durable outbox and a device-token table sit in front of an adapter that returns `UNAVAILABLE` unconditionally. Every "the engineer is never told" finding in five modules bottoms out here. Spine edges E-05, E-19, E-24. |
| **INV-G8** consumed parts never reach the wire | `inventory` | inventory (4 of its own capabilities) · tickets · verification | `consumedComponents` is never populated, so van stock never depletes and no `InventoryTransaction` is written. Common Kit always reads complete, Component-Blocked can never fire, and the built-and-tested verification rollback has no rows to roll back. Spine edge E-11. |
| **AA-02** acting-role attribution dropped | `auth-access` | reports (CSM backup share) · notifications (audit read) · every module that writes an audit row | `acted_as_role` is non-null on **1 row of 34,758**. Any control that asks "who really did this, in whose scope" cannot be answered app-wide. |

## Module graph

| module | blocked by | blocks | note |
|---|---|---|---|
| `notifications` | — | scheduling, intraday, cross-zone, inventory, tickets | The most upstream buildable thing in the survey. Nothing blocks it. |
| `ingestion` | — | reports, dashboard, tickets | Feeds every work item (E-01, E-25). Its staleness is the *producing* end of the reports/dashboard freshness problem. |
| `auth-access` | — | reports, notifications, and the audit trail of all 14 | Cross-cutting; owns no spine edge, which is correct for infrastructure. |
| `scheduling` | notifications (E-04→E-05), admin-config (E-26), engineers (carrier works) | tickets (E-06), cross-zone (E-23) | Its own writes are sound; SCH-01 was falsified. |
| `tickets` | ingestion (E-01), scheduling (E-06), inventory (INV-G8) | verification (E-09), inventory (E-11, E-14, E-27), vouchers (E-15), intraday (E-18), reports (E-28) | Most connected module: 19 spine edges. TKT-02's HTTP 500 is why the warehouse queues are empty. |
| `inventory` | tickets (TKT-02, INV-G8) | tickets (E-12), verification | Its emptiness is a *symptom* of upstream, not its own failure. |
| `verification` | tickets (E-09), inventory | reports (E-28), tickets (E-10) | Zero live rows; blocked on fixtures more than on code. |
| `vouchers` | tickets (E-15 — **carried by a human remembering**) | reports (E-17, a file export plus a manual mark-paid) | The money path is the least automated chain in the app at both ends. |
| `cross-zone` | scheduling (E-23), notifications (E-24) | scheduling | Blocked and blocking on the same neighbour, in opposite directions. |
| `intraday` | tickets (E-18), notifications (E-19) | — | Since §21 retired accept/decline, this module *entirely* rests on NOTIF-01. |
| `reports` | ingestion, verification, vouchers, tickets (E-28), auth-access (AA-02) | — | Terminal consumer. Most-blocked module in the app. |
| `dashboard` | ingestion (freshness), tickets, scheduling | — | Terminal consumer. Its own scoping is the best-built thing in the survey. |
| `admin-config` | — | scheduling (E-26), and every module's behaviour via its dials | Config changes reach dispatch with no carrier (E-26 never enqueues into an outbox that already exists). |
| `engineers` | — | scheduling (availability → recommender, live-read and **working**) | The spine originally named no edge here; that was a map error, corrected. |

## Blocked by fixtures, not by code — dev-process, never the feature backlog (O4)

These stopped walks across several modules and are cheap to clear. They are **not** priced in the roadmap.

- **ENG-G7** — the seeded engineer persona has a `users` row and no `engineer_master` row, so the only account that can log in is not an engineer, while 65 of 100 zone-1 tickets are assigned to ingested identities that have no credentials. Blocked persistence checks in `tickets`, `vouchers`, `inventory`, `scheduling`.
- **V-08** — `verification` holds zero live rows; two or three seeded runs across two zones would promote V-01 and V-02 from code-evidence to reproduced.
- **inventory data surface** — van stock, shadow use, warehouse stock, component requests and component-blocked are all empty (a consequence of INV-G8 and TKT-02).
- **ING-09** — the running backend predates uncommitted ingestion-alert work; one restart on HEAD settles it.

## Where the chain is carried by a human remembering

Two spine edges have no mechanical carrier at all, and both sit on the money path:

- **E-15** `tickets → vouchers`: a closed ticket becomes an expense claim only because the engineer opens the Vouchers tab and re-keys the trip.
- **E-17** `vouchers → reports/finance`: an approved voucher becomes a payment via a file export and a manual mark-paid.

A process that runs on memory cannot be audited. Both are C2 by the spine's own severity floor.
