# Draft note to the SE team — #218c deployment-lifecycle catch-up window

**Status:** DRAFT for the operator to send. Not sent. Timing line is a placeholder until the window is
scheduled.

**Why this note exists:** no field coordination is needed — SE ticketing is not in real operational
use, and nothing in this window notifies anybody (verified programmatically, see below). But the
ticket tables are **live and actively written**, and the SE team appears to be developing against this
database. Several thousand rows will change underneath them in one transaction. That is worth telling
them about even though there is nothing for them to do.

---

## The note

> **Subject: Heads-up — bulk ticket closure on the FSM dev database, [DATE], ~05:00 IST**
>
> We are running a one-off data catch-up on the FSM database on **[DATE], early morning IST (before
> Shift A at 06:00)**. It changes a large number of ticket rows in a single transaction. Nothing is
> required from you — this is a heads-up so the numbers don't surprise you.
>
> **What happened.** FSM mirrors AutoPlant's device deployment status. The code that reacts when a
> device leaves the fleet (moves to a warehouse) has not been running since around 22 July — it was
> silently unwired, so FSM still believes ~4,000 devices are deployed when AutoPlant says they are
> not. The wiring is now fixed. This window applies the backlog that built up while it was dead.
>
> **What you will see change, in one transaction:**
>
> | | Now | After |
> |---|---:|---:|
> | Open tickets | 16,727 | **~13,400** |
> | Tickets force-closed by the window | — | **4,383** |
> | New `ticket_events` rows | — | **4,383** |
> | New tickets created (devices coming *back* into service) | — | **~1,100** *(estimate)* |
>
> **How to recognise a ticket this window closed** — every one of them carries the same signature:
>
> ```
> tickets.status          = 'CLOSED'
> tickets.closure_type    = 'DEVICE_UNDEPLOYED_CLOSE'
> tickets.closure_reason  = 'DEVICE_UNDEPLOYED: <UNDEPLOYED | MAINTENANCE | MISSING_FROM_SOURCE>'
> tickets.closed_at       = <the window timestamp>
>
> ticket_events.reason_code = 'DEVICE_UNDEPLOYED'
> ticket_events.to_state    = 'CLOSED'
> ```
>
> So `WHERE closure_type = 'DEVICE_UNDEPLOYED_CLOSE' AND closed_at >= '[DATE]'` isolates the whole set
> if you need to exclude it from a query, a fixture, or a screenshot.
>
> **Things worth knowing:**
>
> - **Closure is one-way.** Restoring a device does *not* reopen its old tickets. If a restored device
>   is still faulty, a **new** ticket is created for it — that is the ~1,100 above.
> - **Batch assignments are not touched.** A ticket that was on a dispatch batch stays on that batch
>   row; only the ticket is closed. **1,691 tickets across 234 live batches** are affected. We have
>   exported that list separately; no engineer is being notified, because nobody is dispatched from
>   this database today.
> - **No notifications fire.** Not push, SMS, WhatsApp or email — the external delivery adapters are
>   not wired to real accounts, and we assert that programmatically immediately before the window runs
>   rather than trusting a past check.
> - **If you have local fixtures or seeded tickets** that assume a device is deployed, they may need
>   refreshing afterwards.
>
> If any of this lands badly for something you have in flight, tell us before **[DATE]** and we will
> move the window.

---

## Notes for the operator (not part of the note)

**Numbers, and where each came from:**

| Figure | Source | Measured or estimated |
|---|---|---|
| 4,383 tickets force-closed | Gate-3 read-only dry-run, 2026-08-07, production AutoPlant | **Measured** |
| 16,727 open tickets | Direct count, 2026-08-07 | **Measured** |
| ~1,100 tickets created | Measured on the 2,197-device superset; the real restore cohort is 1,144, so this is an upper-ish bound | **Estimate** |
| ~13,400 open after | 16,727 − 4,383 + ~1,100 | Derived; inherits the estimate |
| 1,691 live-batch tickets, 234 batches | Stand-down export, second read-only dry-run 2026-08-07 ~14:05 IST | **Measured** |

**Two corrections to earlier figures, so the note does not repeat them:**

1. `FIX-PLAN.md` §7.1 says 3,709 tickets closed and a backlog landing "around 14,100". Both are
   **superseded** by the Gate-3 dry-run: the real figures are **4,383** and **~13,400**. The §7.1
   numbers predate the discovery that the forecast was structurally blind to the absence cohort.
2. The live-batch figure is **1,691**, not the ~1,750 carried forward from Gate 3. That earlier number
   was 1,461 measured (SOURCE_STATUS) plus ~300 estimated (absence). Both halves are now measured from
   a single source read: **1,395 SOURCE_STATUS + 296 ABSENT_FROM_READ**. The absence estimate was
   good; the SOURCE_STATUS side moved by −66 because this is a fresh read a few hours later and the
   fleet churns ~150 vehicles/day.

**The window's headline figures are stable across two independent reads**, which is the more useful
signal for the operator:

| | Gate 3 (~06:00 IST) | Export read (~14:05 IST) |
|---|---:|---:|
| Total departures | 5,240 | 5,238 |
| · UNDEPLOYED | 3,889 | 3,886 |
| · MISSING_FROM_SOURCE | 1,305 | 1,306 |
| · MAINTENANCE | 46 | 46 |
| Tickets force-closed | 4,383 | 4,382 |

The note quotes the Gate-3 figures throughout, since those are the ones on record in the issue; the
±1–2 drift between reads is fleet churn, not instability.

**Before sending, confirm the date** — the note commits to a window time and asks for objections by
it, so it needs to go out with enough lead time to be actionable.
