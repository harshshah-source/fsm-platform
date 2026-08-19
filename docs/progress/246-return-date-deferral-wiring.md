# #246 — Return-date deferral wiring: filing ends the attempt, the ticket waits, re-entry is automatic

**Done 2026-08-19.** Backend + Mobile — one vertical slice. Built directly on #245's authoritative
date and #241's removal reason. Feeds #247, #248 and #249.

## What this closes

Before this slice, the date an SE typed into the Vehicle Unavailability form had **no consequence
anywhere**. `fileReport` wrote a report row, paused the primary SLA, and stopped. The ticket stayed
`FORMALLY_ASSIGNED` on that day's batch, kept burning a capacity slot, and the next run planned it
again exactly as if the vehicle were standing there. `expected_from` was read by nothing in
scheduling — verified, not assumed.

Three writes close that, in `fileReport`'s existing transaction:

1. the live `batch_assignment_tickets` row is closed — `removed_at`, `removed_by = seId`,
   `removal_reason = VEHICLE_UNAVAILABLE` (the member #241 defined and left without a writer);
2. the ticket returns to `UNASSIGNED`, so something *can* re-plan it;
3. `deferred_until` is set to the IST day derived from the authoritative date, so nothing re-plans it
   *yet*.

Steps 2 and 3 are a pair and were built as one. Without the first, the ticket is stranded
permanently — the bug #146 fixed for ZM defers, where no reader of unassigned work can ever see it
again. Without the second, "returned to the pool" means "re-dispatchable within the hour", which is
the opposite of waiting for a vehicle.

## Decision 14 — the deferral is a day, not an instant

The unit is an **IST calendar day** because that is the unit the scheduling side already speaks:
`deferred_until` is a `@db.Date`, dispatch plans a day at a time, and `notDeferredOn` compares days.
So a vehicle back at 4pm today gets **no deferral at all** — the ticket is simply eligible again.

Writing an hour-level wait for that case would invent machinery nothing reads: no reader could
honour "back at 16:00", so the ticket would end up either excluded for the whole day or included
immediately regardless. `deferralDateFor` returns `null` for it, and callers write that straight
through, which is also what makes a manager moving the date *backwards* onto today clear the wait
rather than leave a stale future date stranding the ticket after the vehicle is provably back.

The one real subtlety is that the day is IST, not UTC, and the two disagree for five and a half hours
every day. `2026-06-25T19:00Z` is already the 26th in IST; bucketing it by UTC day would silently
lose a day of waiting. That case is pinned as its own test rather than left to the general one.

## Decision 10 — no bounds, deliberately

Any future date is accepted. No horizon validation, no cap on consecutive VU deferrals, no count.
Management approval (#245's approve/override) is the control, and each absence still increments the
Special attempt count, so a vehicle that never comes back **surfaces** rather than quietly
disappearing. A +90-day date is pinned end-to-end so a future reader does not "helpfully" add a
limit.

## Re-entry — the existing predicate, and one copy folded back in

There is no new sweep and no new job. Re-entry is `notDeferredOn`, which every reader of unassigned
work already spreads in, and which is inclusive on the deferred date itself. AC5 pins that as a real
query at four different days rather than by inspection: the whole design rests on that predicate
selecting the ticket, and if it does not, nothing else ever will.

`se-ticket-access.ts` carried its own inline copy of the comparison (`deferredUntil === null ||
deferredUntil <= istDate(now)`). It is now `isNotDeferredOn`, exported from `deferral.ts` beside the
query builder. That file exists precisely because #153 was six copies of a liveness filter drifting
apart and blanking every SE's day plan; a seventh copy of *this* filter would strand deferred tickets
in exactly one read while the other six agreed.

## Re-derivation, not a second source of truth

The wait is derived from the authoritative date, so every write that can move that date re-derives it
in the same transaction: approve, override, and supersession (a new filing recomputes it by
construction). The deferral is never stored as an independent fact that could disagree with the
report it came from.

The case worth stating: an override onto **today** clears the deferral outright. A manager saying
"the truck is back now" that left a week-old future date in place would strand the ticket for a week
after the person with authority to say so had said it.

## Holds stay a separate concept (Decision 13)

Nothing here writes `deferred_until` for admin holds, and #251's `placeHold` already refuses to
overwrite a ticket carrying an OPEN VU report unless explicitly confirmed. That branch shipped in
#251 ahead of this slice for exactly this moment — the refusal is now protecting a real return
decision rather than an inert column.

## Mobile

**Date entry.** The four presets capped at roughly tomorrow 2 PM, so "next week" — the commonest real
answer for a vehicle on a long trip — was literally inexpressible on the one screen whose job is
saying when the vehicle comes back. Replaced with free entry: `YYYY-MM-DD` plus an optional `HH:MM`.

Two deviations from the issue's wording, both deliberate:

- It asks for a **picker**. There is no date-picker component in this project and adding one is a
  native dependency in an Expo app; the in-repo precedent (the leave form, and #64's own original
  call) is a plain `YYYY-MM-DD` text input with the server authoritative on parsing. This follows
  that precedent, which satisfies AC6 as written ("any future date is enterable"). **A native picker
  remains available as a follow-up if the operator wants one** — it is a dependency decision, not a
  design gap.
- Its Reference section names a `docs/ui/mobile/` vehicle-unavailability screen image. **There isn't
  one** — the third mis-filed Reference section in this block, and the first in the opposite
  direction (claiming an image that does not exist rather than missing one that does). The screen
  keeps its existing layout; the picker row is swapped in place.

Entry is read as **IST**, not as the handset's timezone. The server buckets deferrals by IST day, so
a handset on any other clock would otherwise produce a date meaning a different operating day than
the SE picked — and a bare `YYYY-MM-DD` handed to `Date` is UTC midnight, which is 05:30 IST: the
same off-by-a-few-hours class of bug `ist-day.ts` exists to end on the backend.

**Confirmation.** Filing now holds on a confirmation screen instead of closing straight back to
Ticket Detail, and the day it shows is the one the **server** derived — returned as `deferredUntil`
on the file response — never the date the SE typed. Those two differ whenever the same-day rule
applies, and showing the typed date would tell the SE the ticket is waiting when it is not. Where
there is no wait it says so in words rather than printing a date.

**Ticket detail.** A deferred ticket now carries a banner naming the return day, so the date stays
readable after the confirmation is gone and an SE scanning their list can tell "nothing to do yet"
from "I have not got to this". This added `deferredUntil` to `MeTicketDetailView`.

## Tests

`test/vu-deferral-wiring.e2e-spec.ts` (8) covers AC1–AC5 and AC7: the three writes; Decision 14's four
cases in one table plus the IST-boundary case on its own; +90 days and uncapped repeats; approve /
override-later / override-onto-today re-deriving; the re-entry predicate queried at four days; the
removal reason that makes the window countable by #244; and filing on a ticket with no live batch row
at all, which is ordinary (shared-pool work, or already recycled) and must not be an error.

RED was proven first — all 8 failed before the implementation. Sensitivity was then checked by
breaking three things one at a time and confirming the right tests went red and 8/8 returned:
removing the same-day rule (2 red), not ending the attempt window (3 red), and not re-deriving on a
decision (1 red).

Mobile: 7 tests on the entry helper (IST anchoring, optional time, far-future, malformed input
rejected) and 7 on the form, plus 2 on the detail banner. Full mobile suite 49 files / 346 tests.

## Limitations

- `expectedTo` is still unbuilt and still has no readers.
- The SLA stays paused while the ticket waits; pause-reason-aware resumption is #247.
- No native date picker (see above) — a dependency decision left open.
